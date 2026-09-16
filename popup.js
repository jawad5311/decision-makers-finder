const enabledInput = document.getElementById('enabled');
const queriesInput = document.getElementById('queries');
const saveButton = document.getElementById('save');
const channelSearchButton = document.getElementById('channelSearch');
const status = document.getElementById('status');
const DEFAULT_QUERY = 'decision makers';

function buildChannelSearchUrl(rawUrl, queryText = DEFAULT_QUERY) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const domain = url.hostname.toLowerCase().replace(/^www\./, '');
    const query = String(queryText).trim();
    return domain && query ? `https://www.google.com/search?q=${encodeURIComponent(`${domain} ${query}`)}` : null;
  } catch { return null; }
}

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get({ enabled: true, queries: [DEFAULT_QUERY] });
  enabledInput.checked = stored.enabled !== false;
  queriesInput.value = (stored.queries || [DEFAULT_QUERY]).join('\n');

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const firstQuery = (stored.queries || [DEFAULT_QUERY]).find(value => String(value).trim()) || DEFAULT_QUERY;
  const rawUrl = activeTab?.pendingUrl || activeTab?.url;
  let domain = null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      domain = url.hostname.toLowerCase().replace(/^www\./, '');
    }
  } catch { /* unsupported or unavailable tab */ }
  channelSearchButton.disabled = !activeTab?.id || !domain;
  channelSearchButton.addEventListener('click', async () => {
    if (!activeTab?.id || !domain) return;
    const queries = queriesInput.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    await chrome.runtime.sendMessage({
      type: 'OPEN_QUERY_SEARCHES',
      domain,
      queries: queries.length ? queries : [DEFAULT_QUERY],
      sourceTabId: activeTab.id
    });
    window.close();
  });
});

enabledInput.addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: enabledInput.checked });
  status.textContent = enabledInput.checked ? 'Enabled' : 'Disabled';
});

saveButton.addEventListener('click', async () => {
  const queries = queriesInput.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  await chrome.storage.local.set({ queries: queries.length ? queries : [DEFAULT_QUERY] });
  status.textContent = 'Settings saved';
});

// Kept available for popup integrations and automated checks.
globalThis.buildChannelSearchUrl = buildChannelSearchUrl;
