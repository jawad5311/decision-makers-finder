const RUN_STATE_KEY = 'decisionMakerRunState';
const NEXT_PROFILE_ALARM = 'dmf-next-profile';
const SEARCH_LAUNCH_GAP_MIN_MS = 2000;
const SEARCH_LAUNCH_GAP_MAX_MS = 5000;
const PROFILE_DELAY_MIN_MS = 15000;
const PROFILE_DELAY_MAX_MS = 30000;
const MAX_PROFILE_TABS = 3;
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
    url: `${buildSearchUrl(state.domain, state.queries[queryIndex], state.linkedIn)}#dmf-run=${encodeURIComponent(state.runId)}&dmf-query=${queryIndex}`,
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
    const launchGap = SEARCH_LAUNCH_GAP_MIN_MS + Math.floor(Math.random() * (SEARCH_LAUNCH_GAP_MAX_MS - SEARCH_LAUNCH_GAP_MIN_MS + 1));
    searchLaunchTimer = setTimeout(() => {
      searchLaunchTimer = null;
      enqueueStateOperation(launchNextSearch).catch(() =>
        enqueueStateOperation(() => finishRun('error'))
      );
    }, launchGap);
  }
}

async function startProfileQueue(state) {
  if (state.openLinkedInProfiles === false) {
    const tab = await chrome.tabs.create({ url: 'https://sheets.new', active: true });
    return setRunState({ ...state, phase: 'exporting-sheet', sheetTabId: tab.id });
  }
  if (!state.profileLinks.length) {
    return finishRun('complete');
  }
  const nextState = {
    ...state,
    phase: 'opening-profiles',
    searchTabIds: [],
    profileIndex: -1,
    currentProfileUrl: null,
    profileTabIds: []
  };
  await setRunState(nextState);
  await openNextProfile(nextState);
}

async function openNextProfile(state) {
  const nextIndex = state.profileIndex + 1;
  if (nextIndex >= state.profileLinks.length) return finishRun('complete');
  const profileUrl = state.profileLinks[nextIndex];
  // Keep the user's current tab untouched once Google research is complete.
  const tab = await chrome.tabs.create({ url: profileUrl, active: false });
  const nextState = {
    ...state,
    profileIndex: nextIndex,
    currentProfileUrl: profileUrl,
    profileTabIds: [...(state.profileTabIds || []), tab.id],
    profileTabOpenedAt: { ...(state.profileTabOpenedAt || {}), [tab.id]: Date.now() }
  };
  await setRunState(nextState);
  if (nextState.profileTabIds.length < MAX_PROFILE_TABS && nextIndex + 1 < nextState.profileLinks.length) {
    await scheduleNextProfile(randomDelayMs(15, 30));
  }
  return nextState;
}

async function scheduleNextProfile(delayMs = randomDelayMs(15, 30)) {
  await chrome.alarms.clear(NEXT_PROFILE_ALARM);
  await chrome.alarms.create(NEXT_PROFILE_ALARM, { when: Date.now() + delayMs });
}

async function startRun(message, sender) {
  const domain = cleanDomain(message.domain);
  const queries = Array.isArray(message.queries) ? message.queries.map(value => String(value).trim()).filter(Boolean) : [];
  const savedSettings = await chrome.storage.local.get({ linkedIn: false, openLinkedInProfiles: true });
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
    runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    phase: 'searching',
    domain,
    queries,
    linkedIn,
    openLinkedInProfiles: typeof message.openLinkedInProfiles === 'boolean' ? message.openLinkedInProfiles : savedSettings.openLinkedInProfiles === true,
    records: [],
    nextQueryIndex: 0,
    queriesCompleted: 0,
    searchTabIds: [],
    searchTabQueries: {},
    verificationTabs: [],
    profileLinks: [],
    totalProfilesFound: 0,
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
  const links = Array.isArray(message.links) ? message.links : [];
  const records = Array.isArray(message.records) ? message.records : [];
  for (const link of links) combined.set(String(link).toLowerCase(), link);
  const nextState = {
    ...state,
    phase: state.verificationTabs.some(id => id !== tabId) ? 'waiting-verification' : 'searching',
    queriesCompleted: state.queriesCompleted + 1,
    searchTabIds: state.searchTabIds.filter(id => id !== tabId),
    verificationTabs: (state.verificationTabs || []).filter(id => id !== tabId),
    profileLinks: [...combined.values()],
    records: [...(state.records || []), ...records],
    totalProfilesFound: (state.totalProfilesFound || 0) + links.length
  };

  await setRunState(nextState);
  await chrome.tabs.remove(tabId).catch(() => undefined);
  if (nextState.nextQueryIndex >= nextState.queries.length && !nextState.searchTabIds.length) {
    await startProfileQueue(nextState);
  }
  return { accepted: true, profiles: nextState.profileLinks.length };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GET_SEARCH_PAGE_CONTEXT') {
    enqueueStateOperation(async () => {
      const state = await getRunState();
      const tabId = sender.tab?.id;
      const pageUrl = new URL(message.url || 'https://invalid.example');
      const marker = new URLSearchParams(pageUrl.hash.slice(1));
      const queryIndex = state.searchTabQueries?.[tabId];
      const expectedUrl = Number.isInteger(queryIndex) ? new URL(buildSearchUrl(state.domain, state.queries[queryIndex], state.linkedIn)) : null;
      return { state, tabId, activeSearch: Boolean(state.runId) && marker.get('dmf-run') === state.runId && marker.get('dmf-query') === String(queryIndex) && expectedUrl?.origin === pageUrl.origin && expectedUrl?.pathname === pageUrl.pathname && expectedUrl?.searchParams.get('q') === pageUrl.searchParams.get('q') && state.running === true &&
        ['searching', 'waiting-verification'].includes(state.phase) &&
        (state.searchTabIds || []).includes(tabId) };
    }).then(sendResponse).catch(() => sendResponse({ activeSearch: false }));
    return true;
  }
  if (message?.type === 'FORCE_NEXT_PROFILE') {
    enqueueStateOperation(async () => {
      const state = await getRunState();
      if (!state.running || state.phase !== 'opening-profiles' || (state.profileTabIds || []).length >= MAX_PROFILE_TABS) return { opened: false };
      await chrome.alarms.clear(NEXT_PROFILE_ALARM);
      await openNextProfile(state);
      return { opened: true };
    }).then(sendResponse);
    return true;
  }
  if (message?.type === 'GET_SHEET_ROWS') {
    getRunState().then(state => sendResponse(state.phase === 'exporting-sheet' ? { rows: [['profile link','div 1 text','div 2 text'], ...state.profileLinks.map(link => { const row = (state.records || []).find(item => item.link === link) || {}; return [link, row.div1 || '', row.div2 || '']; })] } : {}));
    return true;
  }
  if (message?.type === 'SHEET_EXPORT_DONE') {
    enqueueStateOperation(() => finishRun('complete')).then(() => sendResponse({ ok: true }));
    return true;
  }
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

    if ((state.profileTabIds || []).length >= MAX_PROFILE_TABS) return;
    await openNextProfile(state);
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
    } else if (state.phase === 'opening-profiles' && state.profileTabIds?.includes(tabId)) {
      const openedAt = state.profileTabOpenedAt?.[tabId] || Date.now();
      const profileTabIds = state.profileTabIds.filter(id => id !== tabId);
      const profileTabOpenedAt = { ...(state.profileTabOpenedAt || {}) };
      delete profileTabOpenedAt[tabId];
      const nextState = { ...state, profileTabIds, profileTabOpenedAt };
      await setRunState(nextState);
      if (nextState.profileIndex >= nextState.profileLinks.length - 1) {
        return finishRun('complete');
      }
      const remainingDelay = Math.max(0, randomDelayMs(15, 30) - (Date.now() - openedAt));
      if (remainingDelay === 0) await openNextProfile(nextState);
      else await scheduleNextProfile(remainingDelay);
    }
  }).catch(() => enqueueStateOperation(() => finishRun('error')));
});






