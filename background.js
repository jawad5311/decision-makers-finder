const RUN_STATE_KEY = 'decisionMakerRunState';
const NEXT_PROFILE_ALARM = 'dmf-next-profile';
const DEFAULT_QUERY = 'decision makers';

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

async function openNextSearch(state) {
  const url = buildSearchUrl(state.domain, state.queries[state.queryIndex]);
  if (!url) return finishRun('error');
  try {
    await chrome.tabs.update(state.workTabId, { url, active: true });
  } catch {
    const tab = await chrome.tabs.create({ url, active: true });
    state.workTabId = tab.id;
    await setRunState(state);
  }
}

async function scheduleNextProfile() {
  await chrome.alarms.clear(NEXT_PROFILE_ALARM);
  await chrome.alarms.create(NEXT_PROFILE_ALARM, { when: Date.now() + randomDelayMs(10, 15) });
}

async function startProfileQueue(state) {
  if (!state.profileLinks.length) return finishRun('complete');
  const nextState = { ...state, phase: 'opening-profiles', profileIndex: 0, currentProfileUrl: state.profileLinks[0] };
  await setRunState(nextState);
  try {
    await chrome.tabs.update(nextState.workTabId, { url: nextState.currentProfileUrl, active: true });
  } catch {
    const tab = await chrome.tabs.create({ url: nextState.currentProfileUrl, active: true });
    nextState.workTabId = tab.id;
    await setRunState(nextState);
  }
  await scheduleNextProfile();
}

async function startRun(message, sender) {
  const domain = cleanDomain(message.domain);
  const queries = Array.isArray(message.queries) ? message.queries.map(value => String(value).trim()).filter(Boolean) : [];
  if (!domain || !queries.length) return { started: false, error: 'A domain and at least one query are required.' };

  await chrome.alarms.clear(NEXT_PROFILE_ALARM);
  const current = await getRunState();
  if (current.running) return { started: false, error: 'A search is already running.' };

  const workTab = await chrome.tabs.create({ url: buildSearchUrl(domain, queries[0] || DEFAULT_QUERY), active: true });
  const state = {
    running: true,
    phase: 'searching',
    domain,
    queries,
    queryIndex: 0,
    profileLinks: [],
    profileIndex: -1,
    workTabId: workTab.id,
    sourceTabId: message.sourceTabId || sender.tab?.id || null,
    startedAt: Date.now()
  };
  await setRunState(state);
  return { started: true, workTabId: workTab.id };
}

async function acceptGoogleResults(message, sender) {
  const state = await getRunState();
  if (!state.running || sender.tab?.id !== state.workTabId) return { accepted: false };

  if (message.verificationRequired) {
    await setRunState({ ...state, phase: 'waiting-verification' });
    return { accepted: true, waitingForVerification: true };
  }
  if (state.phase !== 'searching' && state.phase !== 'waiting-verification') return { accepted: false };

  const combined = new Map((state.profileLinks || []).map(link => [link.toLowerCase(), link]));
  for (const link of message.links || []) combined.set(String(link).toLowerCase(), link);
  const nextState = { ...state, phase: 'searching', profileLinks: [...combined.values()] };

  if (state.queryIndex + 1 < state.queries.length) {
    nextState.queryIndex += 1;
    await setRunState(nextState);
    setTimeout(async () => {
      const latest = await getRunState();
      if (!latest.running || latest.workTabId !== nextState.workTabId || latest.queryIndex !== nextState.queryIndex) return;
      await openNextSearch(latest);
    }, randomDelayMs(4, 7));
    return { accepted: true, nextQuery: nextState.queryIndex };
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
  await setRunState(nextState);
  try {
    await chrome.tabs.update(nextState.workTabId, { url: nextState.currentProfileUrl, active: true });
  } catch {
    const tab = await chrome.tabs.create({ url: nextState.currentProfileUrl, active: true });
    nextState.workTabId = tab.id;
    await setRunState(nextState);
  }
  await scheduleNextProfile();
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const state = await getRunState();
  if (state.running && tabId === state.workTabId) await finishRun('stopped');
});
