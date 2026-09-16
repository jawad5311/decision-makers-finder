(() => {
  const TOOLBAR_ID = 'dmf-floating-toolbar';
  const START_BUTTON_ID = 'dmf-start-button';
  const STOP_BUTTON_ID = 'dmf-stop-button';
  const PROSPECT_COUNT_ID = 'dmf-prospect-count';
  const RUN_STATE_KEY = 'decisionMakerRunState';
  const DEFAULT_QUERY = 'decision makers';
  let enabled = true;
  let settings = { queries: [DEFAULT_QUERY], blacklist: [] };
  let runState = { running: false, phase: 'idle' };
  let googlePageReported = false;

  const isGooglePage = () => /(^|\.)google\./i.test(location.hostname);
  const isYouTubePage = () => location.hostname === 'youtube.com' || location.hostname.endsWith('.youtube.com');
  const isLinkedInPage = () => location.hostname === 'linkedin.com' || location.hostname.endsWith('.linkedin.com');
  const cleanDomain = () => location.hostname.replace(/^www\./i, '');

  function isBlacklisted() {
    const host = location.hostname.toLowerCase();
    return settings.blacklist.some(entry => {
      const value = String(entry).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
      return value && (host === value || host.endsWith(`.${value}`));
    });
  }

  function canShowStartButton() {
    return enabled && !runState.running && !isGooglePage() && !isYouTubePage() && !isLinkedInPage() && !isBlacklisted();
  }

  function ensureToolbar() {
    let toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) {
      toolbar = document.createElement('div');
      toolbar.id = TOOLBAR_ID;
      toolbar.style.cssText = 'position:fixed!important;right:30px!important;bottom:30px!important;z-index:2147483647!important;display:flex;flex-direction:column;align-items:flex-start;gap:10px;pointer-events:auto!important;';
      document.body.appendChild(toolbar);
    }
    return toolbar;
  }

  function makeButton(id, text, background) {
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.textContent = text;
    button.style.cssText = `width:210px;box-sizing:border-box;padding:12px 8px;background:${background};color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.35);pointer-events:auto;white-space:nowrap;`;
    button.addEventListener('mousedown', event => {
      event.stopImmediatePropagation();
      event.stopPropagation();
    });
    return button;
  }

  function renderControls() {
    if (!document.body) return;
    document.getElementById(START_BUTTON_ID)?.remove();
    document.getElementById(STOP_BUTTON_ID)?.remove();
    document.getElementById(PROSPECT_COUNT_ID)?.remove();

    if (runState.running) {
      const count = document.createElement('div');
      count.id = PROSPECT_COUNT_ID;
      count.textContent = `Unique prospects found: ${runState.profileLinks?.length || 0}`;
      count.style.cssText = 'width:210px;box-sizing:border-box;padding:8px 10px;background:#161616;color:#fff;border:1px solid #8e44ad;border-radius:8px;font-size:13px;font-weight:700;text-align:center;box-shadow:0 3px 10px rgba(0,0,0,.25);';
      ensureToolbar().appendChild(count);
      const stopButton = makeButton(STOP_BUTTON_ID, 'Stop Decision Maker Search', '#c0392b');
      stopButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        chrome.runtime.sendMessage({ type: 'STOP_SEARCH_RUN' });
      });
      ensureToolbar().appendChild(stopButton);
      return;
    }

    if (canShowStartButton()) {
      const startButton = makeButton(START_BUTTON_ID, 'Find the Decision Makers', '#8e44ad');
      startButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        const queries = settings.queries.map(value => String(value).trim()).filter(Boolean);
        if (!queries.length) return;
        chrome.runtime.sendMessage({ type: 'START_SEARCH_RUN', domain: cleanDomain(), queries });
      });
      ensureToolbar().appendChild(startButton);
    }

    const toolbar = document.getElementById(TOOLBAR_ID);
    if (toolbar && !toolbar.children.length) toolbar.remove();
  }

  function verificationRequired() {
    const text = document.body?.innerText || '';
    return location.pathname.startsWith('/sorry/') ||
      Boolean(document.querySelector('iframe[src*="recaptcha"], #captcha, [data-callback*="captcha"]')) ||
      /unusual traffic|verify you are human|not a robot/i.test(text);
  }

  function linkedInProfileUrl(rawHref) {
    try {
      let url = new URL(rawHref, location.href);
      if (/(^|\.)google\./i.test(url.hostname) && url.pathname === '/url') {
        const target = url.searchParams.get('q') || url.searchParams.get('url');
        if (!target) return null;
        url = new URL(target);
      }
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      const match = url.pathname.match(/^\/in\/([^/?#]+)/i);
      if (host !== 'linkedin.com' || !match) return null;
      return `https://www.linkedin.com/in/${match[1]}/`;
    } catch {
      return null;
    }
  }

  function collectLinkedInProfiles() {
    const root = document.querySelector('#search, main, [role="main"]') || document;
    return [...new Set([...root.querySelectorAll('a[href]')].map(anchor => linkedInProfileUrl(anchor.href)).filter(Boolean))];
  }

  function reportGooglePage() {
    if (!isGooglePage() || googlePageReported) return;
    googlePageReported = true;
    setTimeout(() => {
      const needsVerification = verificationRequired();
      chrome.runtime.sendMessage({
        type: 'GOOGLE_RESULTS_READY',
        verificationRequired: needsVerification,
        links: needsVerification ? [] : collectLinkedInProfiles()
      });
    }, 2200);
  }

  chrome.storage.local.get({ enabled: true, queries: [DEFAULT_QUERY], blacklist: [], [RUN_STATE_KEY]: { running: false, phase: 'idle' } }, result => {
    enabled = result.enabled !== false;
    settings = {
      queries: Array.isArray(result.queries) && result.queries.length ? result.queries : [DEFAULT_QUERY],
      blacklist: Array.isArray(result.blacklist) ? result.blacklist : []
    };
    runState = result[RUN_STATE_KEY];
    renderControls();
    reportGooglePage();
  });

  chrome.storage.onChanged.addListener(changes => {
    if (changes.enabled) enabled = changes.enabled.newValue !== false;
    if (changes.queries) settings.queries = changes.queries.newValue || [DEFAULT_QUERY];
    if (changes.blacklist) settings.blacklist = changes.blacklist.newValue || [];
    if (changes[RUN_STATE_KEY]) runState = changes[RUN_STATE_KEY].newValue || { running: false, phase: 'idle' };
    renderControls();
  });
})();
