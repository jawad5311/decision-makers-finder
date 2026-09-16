const RUN_STATE_KEY = 'decisionMakerRunState';
const DEFAULT_QUERY = 'decision makers';
const enabledInput = document.getElementById('enabled');
const queriesInput = document.getElementById('queries');
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const saveButton = document.getElementById('save');
const status = document.getElementById('status');
let activeTab = null;
let activeDomain = null;

function queriesFromInput() {
  const queries = queriesInput.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  return queries.length ? queries : [DEFAULT_QUERY];
}

function domainFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function statusText(state) {
  if (state.phase === 'waiting-verification') return 'Google needs verification. Complete it in the work tab; the queue will then continue.';
  if (state.phase === 'searching') return `Searching query ${Math.min((state.queryIndex || 0) + 1, state.queries?.length || 1)} of ${state.queries?.length || 1}…`;
  if (state.phase === 'opening-profiles') return `Opening profile ${Math.min((state.profileIndex || 0) + 1, state.profileLinks?.length || 1)} of ${state.profileLinks?.length || 1}…`;
  if (state.phase === 'complete') return `Complete — ${state.profileLinks?.length || 0} unique LinkedIn profiles found.`;
  if (state.phase === 'stopped') return 'Search stopped.';
  if (state.phase === 'error') return 'The search stopped because of an error.';
  return '';
}

function renderRunState(state) {
  const running = state?.running === true;
  startButton.style.display = running ? 'none' : 'block';
  stopButton.style.display = running ? 'block' : 'none';
  startButton.disabled = !enabledInput.checked || !activeDomain;
  queriesInput.disabled = running;
  saveButton.disabled = running;
  status.textContent = statusText(state || {});
}

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get({ enabled: true, queries: [DEFAULT_QUERY], [RUN_STATE_KEY]: { running: false, phase: 'idle' } });
  enabledInput.checked = stored.enabled !== false;
  queriesInput.value = (stored.queries || [DEFAULT_QUERY]).join('\n');
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeDomain = domainFromUrl(activeTab?.pendingUrl || activeTab?.url);
  renderRunState(stored[RUN_STATE_KEY]);
});

enabledInput.addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: enabledInput.checked });
  if (!enabledInput.checked) await chrome.runtime.sendMessage({ type: 'STOP_SEARCH_RUN' });
  const state = await chrome.runtime.sendMessage({ type: 'GET_RUN_STATE' });
  renderRunState(state);
});

saveButton.addEventListener('click', async () => {
  await chrome.storage.local.set({ queries: queriesFromInput() });
  status.textContent = 'Queries saved.';
});

startButton.addEventListener('click', async () => {
  if (!activeDomain || !activeTab?.id) return;
  const queries = queriesFromInput();
  await chrome.storage.local.set({ queries });
  const response = await chrome.runtime.sendMessage({
    type: 'START_SEARCH_RUN',
    domain: activeDomain,
    queries,
    sourceTabId: activeTab.id
  });
  if (!response?.started) status.textContent = response?.error || 'Could not start the search.';
});

stopButton.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP_SEARCH_RUN' });
});

chrome.storage.onChanged.addListener(changes => {
  if (changes[RUN_STATE_KEY]) renderRunState(changes[RUN_STATE_KEY].newValue);
});
