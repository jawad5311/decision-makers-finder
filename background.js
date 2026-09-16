const RUN_STATE_KEY = 'decisionMakerRunState';
const NEXT_PROFILE_ALARM = 'dmf-next-profile';
const SEARCH_LAUNCH_GAP_MS = 2000;
let searchLaunchTimer = null;
let stateOperations = Promise.resolve();

// Tab launches, result messages, and Stop can arrive together. Serialize writes
// so concurrent result pages cannot overwrite each other's collected links.
function enqueueStateOperation(operation) {
  const result = stateOperations.then(operation);
  stateOperations = result.catch(() => undefined);
  return result;
}

function cleanDomain(value) {
  return String(value || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].trim();
}

function buildSearchUrl(domain, query, linkedIn = false) {
  const cleanHost = cleanDomain(domain);
  const cleanQuery = String(query || '').trim();
  if (!cleanHost || !cleanQuery || !/^[a-z0-9.-]+$/i.test(cleanHost)) return null;
  const suffix = linkedIn ? ' linkedin' : '';
  return `https://www.google.com/search?q=${encodeURIComponent(`${cleanHost} ${cleanQuery}${suffix}`)}`;
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
  clearTimeout(searchLaunchTimer);
  searchLaunchTimer = null;
  await chrome.alarms.clear(NEXT_PROFILE_ALARM);
  const state = await getRunState();
  return setRunState({ ...state, running: false, phase, finishedAt: Date.now() });
}

async function launchNextSearch() {
  const state = await getRunState();
  if (!state.running || state.nextQueryIndex >= state.queries.length) return;
  const queryIndex = state.nextQueryIndex;
  const tab = await chrome.tabs.create({
    url: buildSearchUrl(state.domain, state.queries[queryIndex], state.linkedIn),
    active: true
  });
  await setRunState({
    ...state,
    nextQueryIndex: queryIndex + 1,
    searchTabIds: [...state.searchTabIds, tab.id],
    searchTabQueries: { ...state.searchTabQueries, [tab.id]: queryIndex }
  });

  // Launch cadence is independent of when other search tabs finish loading.
  if (queryIndex + 1 < state.queries.length) {
    searchLaunchTimer = setTimeout(() => {
      searchLaunchTimer = null;
      enqueueStateOperation(launchNextSearch).catch(() =>
        enqueueStateOperation(() => finishRun('error'))
      );
    }, SEARCH_LAUNCH_GAP_MS);
  }
}

async function startProfileQueue(state) {
  if (!state.profileLinks.length) {
    return finishRun('complete');
  }
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
  const savedSettings = await chrome.storage.local.get({ linkedIn: false });
  const linkedIn = typeof message.linkedIn === 'boolean'
    ? message.linkedIn
    : savedSettings.linkedIn === true;
  if (!domain || !queries.length || !buildSearchUrl(domain, queries[0], linkedIn)) {
    return { started: false, error: 'A valid domain and at least one query are required.' };
  }
  const current = await getRunState();
  if (current.running) return { started: false, error: 'A search is already running.' };

  const state = {
    running: true,
    phase: 'searching',
    domain,
    queries,
    linkedIn,
    nextQueryIndex: 0,
    queriesCompleted: 0,
    searchTabIds: [],
    searchTabQueries: {},
    verificationTabs: [],
    profileLinks: [],
    profileIndex: -1,
    profileTabIds: [],
    sourceTabId: message.sourceTabId || sender.tab?.id || null,
    startedAt: Date.now()
  };
  await chrome.alarms.clear(NEXT_PROFILE_ALARM);
  await setRunState(state);
  await launchNextSearch();
  return { started: true };
}

async function acceptGoogleResults(message, sender) {
  const state = await getRunState();
  const tabId = sender.tab?.id;
  if (!state.running || !['searching', 'waiting-verification'].includes(state.phase) || !state.searchTabIds.includes(tabId)) {
    return { accepted: false };
  }

  if (message.verificationRequired) {
    const verificationTabs = [...new Set([...(state.verificationTabs || []), tabId])];
    await setRunState({ ...state, phase: 'waiting-verification', verificationTabs });
    return { accepted: true, waitingForVerification: true };
  }

  const combined = new Map((state.profileLinks || []).map(link => [link.toLowerCase(), link]));
  for (const link of message.links || []) combined.set(String(link).toLowerCase(), link);
  const nextState = {
    ...state,
    phase: state.verificationTabs.some(id => id !== tabId) ? 'waiting-verification' : 'searching',
    queriesCompleted: state.queriesCompleted + 1,
    searchTabIds: state.searchTabIds.filter(id => id !== tabId),
    verificationTabs: (state.verificationTabs || []).filter(id => id !== tabId),
    profileLinks: [...combined.values()]
  };

  await setRunState(nextState);
  await chrome.tabs.remove(tabId).catch(() => undefined);
  if (nextState.nextQueryIndex >= nextState.queries.length && !nextState.searchTabIds.length) {
    await startProfileQueue(nextState);
  }
  return { accepted: true, profiles: nextState.profileLinks.length };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'START_SEARCH_RUN') {
    enqueueStateOperation(() => startRun(message, sender)).then(sendResponse).catch(error => sendResponse({ started: false, error: String(error) }));
    return true;
  }
  if (message?.type === 'GOOGLE_RESULTS_READY') {
    enqueueStateOperation(() => acceptGoogleResults(message, sender)).then(sendResponse).catch(error => sendResponse({ accepted: false, error: String(error) }));
    return true;
  }
  if (message?.type === 'STOP_SEARCH_RUN') {
    enqueueStateOperation(() => finishRun('stopped')).then(state => sendResponse({ stopped: true, state }));
    return true;
  }
  if (message?.type === 'GET_RUN_STATE') {
    getRunState().then(sendResponse);
    return true;
  }
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== NEXT_PROFILE_ALARM) return;
  enqueueStateOperation(async () => {
    const state = await getRunState();
    if (!state.running || state.phase !== 'opening-profiles') return;

    const nextIndex = state.profileIndex + 1;
    if (nextIndex >= state.profileLinks.length) return finishRun('complete');

    const nextState = { ...state, profileIndex: nextIndex, currentProfileUrl: state.profileLinks[nextIndex] };
    const tab = await chrome.tabs.create({ url: nextState.currentProfileUrl, active: true });
    nextState.profileTabIds = [...(state.profileTabIds || []), tab.id];
    await setRunState(nextState);
    await scheduleNextProfile();
  }).catch(() => enqueueStateOperation(() => finishRun('error')));
});

chrome.tabs.onRemoved.addListener(tabId => {
  enqueueStateOperation(async () => {
    const state = await getRunState();
    if (!state.running) return;
    if (state.searchTabIds?.includes(tabId)) {
      const remaining = state.searchTabIds.filter(id => id !== tabId);
      const verificationTabs = state.verificationTabs.filter(id => id !== tabId);
      const nextState = {
        ...state,
        searchTabIds: remaining,
        queriesCompleted: state.queriesCompleted + 1,
        verificationTabs,
        phase: verificationTabs.length ? 'waiting-verification' : 'searching'
      };
      await setRunState(nextState);
      if (nextState.nextQueryIndex >= nextState.queries.length && !remaining.length) {
        await startProfileQueue(nextState);
      }
    }
  }).catch(() => enqueueStateOperation(() => finishRun('error')));
});
