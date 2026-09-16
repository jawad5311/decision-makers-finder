(() => {
  const TOOLBAR_ID = 'dmf-floating-toolbar';
  const BUTTON_ID = 'yt-channel-search-button';
  const DEFAULT_QUERY = 'decision makers';
  let enabled = true;
  let settings = { queries: [DEFAULT_QUERY], blacklist: [] };

  const isGooglePage = () => /(^|\.)google\./i.test(location.hostname);
  const isYouTubePage = () => location.hostname === 'youtube.com' || location.hostname.endsWith('.youtube.com');
  const isLinkedInPage = () => location.hostname === 'linkedin.com' || location.hostname.endsWith('.linkedin.com');
  const isBrowserInternalPage = () => !/^https?:$/.test(location.protocol);

  function isBlacklisted() {
    const host = location.hostname.toLowerCase();
    return settings.blacklist.some(entry => {
      const value = String(entry).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
      return value && (host === value || host.endsWith(`.${value}`));
    });
  }

  function currentDomain() {
    return location.hostname.replace(/^www\./i, '');
  }

  function buildSearchUrl(queryText = DEFAULT_QUERY) {
    const domain = currentDomain();
    const query = String(queryText).trim();
    if (!domain || !query) return null;
    return `https://www.google.com/search?q=${encodeURIComponent(`${domain} ${query}`)}`;
  }

  function removeButton() {
    document.getElementById(TOOLBAR_ID)?.remove();
  }

  function addButton() {
    if (!enabled || isBrowserInternalPage() || isGooglePage() || isYouTubePage() || isLinkedInPage() || isBlacklisted()) return;
    if (!document.body || document.getElementById(BUTTON_ID)) return;

    const query = settings.queries.find(item => String(item).trim()) || DEFAULT_QUERY;
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Find the Decision Makers';
    button.title = `Search: ${currentDomain()} ${query}`;
    button.style.cssText = [
      'width:197px', 'box-sizing:border-box', 'padding:12px 8px',
      'background-color:#8e44ad', 'color:#fff', 'border:none', 'border-radius:8px',
      'font-size:14px', 'font-weight:600', 'cursor:pointer',
      'box-shadow:0 4px 12px rgba(0,0,0,.3)', 'pointer-events:auto', 'white-space:nowrap'
    ].join(';');
    const stop = event => { event.stopImmediatePropagation(); event.stopPropagation(); };
    button.addEventListener('mousedown', stop);
    button.addEventListener('click', event => {
      event.preventDefault();
      stop(event);
      const queries = settings.queries.map(item => String(item).trim()).filter(Boolean);
      if (!queries.length) return;
      chrome.runtime.sendMessage({
        type: 'OPEN_QUERY_SEARCHES',
        domain: currentDomain(),
        queries
      });
    });

    let toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) {
      toolbar = document.createElement('div');
      toolbar.id = TOOLBAR_ID;
      toolbar.style.cssText = 'position:fixed!important;right:30px!important;bottom:30px!important;z-index:2147483647!important;display:flex;flex-direction:column;align-items:flex-start;gap:10px;pointer-events:auto!important;';
      document.body.appendChild(toolbar);
    }
    toolbar.appendChild(button);
  }

  function refresh(next = {}) {
    settings = {
      queries: Array.isArray(next.queries) && next.queries.length ? next.queries : [DEFAULT_QUERY],
      blacklist: Array.isArray(next.blacklist) ? next.blacklist : []
    };
    enabled = next.enabled !== false;
    removeButton();
    addButton();
  }

  chrome.storage.local.get({ enabled: true, queries: [DEFAULT_QUERY], blacklist: [] }, refresh);
  chrome.storage.onChanged.addListener(changes => {
    const next = { enabled, queries: settings.queries, blacklist: settings.blacklist };
    if (changes.enabled) next.enabled = changes.enabled.newValue;
    if (changes.queries) next.queries = changes.queries.newValue;
    if (changes.blacklist) next.blacklist = changes.blacklist.newValue;
    refresh(next);
  });
  chrome.runtime.onMessage.addListener(message => { if (message?.type === 'SET_ENABLED') refresh({ ...settings, enabled: message.enabled }); });
})();
