const RUN_STATE_KEY = 'decisionMakerRunState';
const NEXT_PROFILE_ALARM = 'dmf-next-profile';
const DEFAULT_QUERY = 'decision makers';
const SEARCH_TAB_LIMIT = 3;

function cleanDomain(value) {
  return String(value || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].trim();
}

function buildSearchUrl(domain, query) {
  const cleanHost = cleanDomain(domain);
  const cleanQuery = String(query || '').trim();
  if (!cleanHost || !cleanQuery || !/^[a-z0-9.-]+$/i.test(cleanHost)) return null;
  return `https://www.google.com/search?q=${encodeURIComponent(`${cleanHost} ${cleanQuery}`)}`;
}

function randomDelayMs(minSeconds, maxSeconds) {
  return (Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds) * 1000;
}

async function getRunState() {
  const result = await chrome.storage.local.get({ [RUN_STATE_KEY]: { running: false, phase: 'idle' } });
  return result[RUN_STATE_KEY];
}

async function setRunState(state) {
  await chrome.storage.local.set({ [RUN_STATE_KEY]: state });
  return state;
}

async function finishRun(phase = 'complete') {
  await chrome.alarms.clear(NEXT_PROFILE_ALARM);
  const state = await getRunState();
  return setRunState({ ...state, running: false, phase, finishedAt: Date.now() });
}

async function createSearchBatch(state, startIndex, existingTabIds = []) {
  const batch = state.queries.slice(startIndex, startIndex + SEARCH_TAB_LIMIT);
  const tabIds = existingTabIds.slice(0, batch.length);
  const newTabs = await Promise.all(batch.slice(tabIds.length).map((query, offset) =>
    chrome.tabs.create({ url: buildSearchUrl(state.domain, query), active: tabIds.length === 0 && offset === 0 })
  ));
  tabIds.push(...newTabs.map(tab => tab.id));

  const searchTabQueries = {};
  tabIds.forEach((tabId, index) => { searchTabQueries[tabId] = startIndex + index; });
  const nextState = {
    ...state,
    phase: 'searching',
    batchStart: startIndex,
    searchTabIds: tabIds,
    searchTabQueries,
    searchResultsReceived: [],
    verificationTabs: []
  };
  await setRunState(nextState);

  await Promise.all(existingTabIds.slice(0, batch.length).map((tabId, index) =>
    chrome.tabs.update(tabId, {
      url: buildSearchUrl(state.domain, batch[index]),
      active: false
    }).catch(() => undefined)
  ));

  // Reuse the first three search tabs for later batches; close any unused tabs.
  await Promise.all(existingTabIds.slice(batch.length).map(tabId => chrome.tabs.remove(tabId).catch(() => undefined)));
  return nextState;
}

async function startProfileQueue(state) {
  if (!state.profileLinks.length) {
    await setRunState({ ...state, searchTabIds: [] });
    await Promise.all((state.searchTabIds || []).map(tabId => chrome.tabs.remove(tabId).catch(() => undefined)));
    return finishRun('complete');
  }
  await Promise.all((state.searchTabIds || []).map(tabId => chrome.tabs.remove(tabId).catch(() => undefined)));
  const nextState = {
    ...state,
    phase: 'opening-profiles',
    searchTabIds: [],
    profileIndex: 0,
    currentProfileUrl: state.profileLinks[0],
    profileTabIds: []
  };
  await setRunState(nextState);
  const tab = await chrome.tabs.create({ url: nextState.currentProfileUrl, active: true });
  nextState.profileTabIds = [tab.id];
  await setRunState(nextState);
  await scheduleNextProfile();
}

async function scheduleNextProfile() {
  await chrome.alarms.clear(NEXT_PROFILE_ALARM);
  await chrome.alarms.create(NEXT_PROFILE_ALARM, { when: Date.now() + randomDelayMs(10, 15) });
}

async function startRun(message, sender) {
  const domain = cleanDomain(message.domain);
  const queries = Array.isArray(message.queries) ? message.queries.map(value => String(value).trim()).filter(Boolean) : [];
  if (!domain || !queries.length) return { started: false, error: 'A domain and at least one query are required.' };
  const current = await getRunState();
  if (current.running) return { started: false, error: 'A search is already running.' };

  const state = {
    running: true,
    phase: 'searching',
    domain,
    queries,
    batchStart: 0,
    searchTabIds: [],
    searchTabQueries: {},
    searchResultsReceived: [],
    verificationTabs: [],
    profileLinks: [],
    profileIndex: -1,
    profileTabIds: [],
    sourceTabId: message.sourceTabId || sender.tab?.id || null,
    startedAt: Date.now()
  };
  await chrome.alarms.clear(NEXT_PROFILE_ALARM);
  await createSearchBatch(state, 0);
  return { started: true };
}

async function acceptGoogleResults(message, sender) {
  const state = await getRunState();
  const tabId = sender.tab?.id;
  if (!state.running || state.phase !== 'searching' && state.phase !== 'waiting-verification' || !state.searchTabIds.includes(tabId)) {
    return { accepted: false };
  }

  if (message.verificationRequired) {
    const verificationTabs = [...new Set([...(state.verificationTabs || []), tabId])];
    await setRunState({ ...state, phase: 'waiting-verification', verificationTabs });
    return { accepted: true, waitingForVerification: true };
  }

  if (state.searchResultsReceived.includes(tabId)) return { accepted: false };
  const received = [...state.searchResultsReceived, tabId];
  const combined = new Map((state.profileLinks || []).map(link => [link.toLowerCase(), link]));
  for (const link of message.links || []) combined.set(String(link).toLowerCase(), link);
  const nextState = {
    ...state,
    phase: 'searching',
    searchResultsReceived: received,
    verificationTabs: (state.verificationTabs || []).filter(id => id !== tabId),
    profileLinks: [...combined.values()]
  };

  if (received.length < state.searchTabIds.length) {
    await setRunState(nextState);
    return { accepted: true, remaining: state.searchTabIds.length - received.length };
  }

  const nextBatchStart = state.batchStart + state.searchTabIds.length;
  if (nextBatchStart < state.queries.length) {
    await createSearchBatch(nextState, nextBatchStart, state.searchTabIds);
    return { accepted: true, nextBatchStart };
  }

  await startProfileQueue(nextState);
  return { accepted: true, profiles: nextState.profileLinks.length };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'START_SEARCH_RUN') {
    startRun(message, sender).then(sendResponse).catch(error => sendResponse({ started: false, error: String(error) }));
    return true;
  }
  if (message?.type === 'GOOGLE_RESULTS_READY') {
    acceptGoogleResults(message, sender).then(sendResponse).catch(error => sendResponse({ accepted: false, error: String(error) }));
    return true;
  }
  if (message?.type === 'STOP_SEARCH_RUN') {
    finishRun('stopped').then(state => sendResponse({ stopped: true, state }));
    return true;
  }
  if (message?.type === 'GET_RUN_STATE') {
    getRunState().then(sendResponse);
    return true;
  }
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== NEXT_PROFILE_ALARM) return;
  const state = await getRunState();
  if (!state.running || state.phase !== 'opening-profiles') return;

  const nextIndex = state.profileIndex + 1;
  if (nextIndex >= state.profileLinks.length) return finishRun('complete');

  const nextState = { ...state, profileIndex: nextIndex, currentProfileUrl: state.profileLinks[nextIndex] };
  const tab = await chrome.tabs.create({ url: nextState.currentProfileUrl, active: true });
  nextState.profileTabIds = [...(state.profileTabIds || []), tab.id];
  await setRunState(nextState);
  await scheduleNextProfile();
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const state = await getRunState();
  if (!state.running) return;
  if (state.searchTabIds?.includes(tabId)) {
    const remaining = state.searchTabIds.filter(id => id !== tabId);
    if (!remaining.length) await finishRun('stopped');
    else await setRunState({ ...state, searchTabIds: remaining });
  }
});
