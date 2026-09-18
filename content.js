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
  let googlePageProcessing = false;
  let searchPageTabId = null;
  let searchPageRunId = null;
  let searchPageUrl = null;

  function canProcessGooglePage() {
    return enabled && runState.running === true && runState.runId === searchPageRunId && location.href === searchPageUrl &&
      ['searching', 'waiting-verification'].includes(runState.phase) &&
      (runState.searchTabIds || []).includes(searchPageTabId);
  }

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
      count.textContent = `${runState.profileLinks?.length || 0}/${runState.totalProfilesFound || 0}`;
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
      const href = decodeURIComponent(String(rawHref || ''));
      const match = href.match(/linkedin\.com\/in\/([^/?#&\s"']+)/i);
      return match ? `https://www.linkedin.com/in/${match[1]}/` : null;
    } catch {
      return null;
    }
  }

  function collectGoogleRecords() {
    const records = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      const link = linkedInProfileUrl(anchor.href);
      if (!link) continue;
      let container = anchor;
      for (let i = 0; i < 8 && container; i += 1) {
        const div1 = container.querySelector?.('div.YrbPuc');
        const div2 = container.querySelector?.('div.VwiC3b.yXK7lf.p4wth.r025kc.Hdw6tb');
        if (div1 || div2) {
          records.push({ link, div1: div1?.innerText?.trim() || '', div2: div2?.innerText?.trim() || '' });
          break;
        }
        container = container.parentElement;
      }
    }
    return records;
  }
  function collectLinkedInProfiles() {
    // Search the complete document: Google may place results in different
    // containers (and dynamically move them while the page settles).
    return [...new Set([...document.querySelectorAll('a[href]')]
      .map(anchor => linkedInProfileUrl(anchor.href))
      .filter(Boolean))];
  }

  async function reportGooglePage() {
    if (!enabled || !isGooglePage() || googlePageReported || googlePageProcessing) return;
    const marker = new URLSearchParams(location.hash.slice(1));
    if (!marker.get('dmf-run') || !marker.has('dmf-query') || location.pathname !== '/search') return;
    googlePageProcessing = true;
    let context;
    try {
      context = await chrome.runtime.sendMessage({ type: 'GET_SEARCH_PAGE_CONTEXT', url: location.href });
    } catch {
      googlePageProcessing = false;
      return;
    }
    if (!context?.activeSearch || !enabled) {
      googlePageProcessing = false;
      return;
    }
    runState = context.state;
    searchPageTabId = context.tabId;
    searchPageRunId = context.state.runId;
    searchPageUrl = location.href;
    let readyAt = null;
    const startedAt = Date.now();
    const sendResults = () => {
      if (!canProcessGooglePage() || googlePageReported) return;
      googlePageReported = true;
      const needsVerification = verificationRequired();
      chrome.runtime.sendMessage({
        type: 'GOOGLE_RESULTS_READY',
        verificationRequired: needsVerification,
        links: needsVerification ? [] : collectLinkedInProfiles(),
        records: needsVerification ? [] : collectGoogleRecords()
      });
    };
    const poll = () => {
      if (!canProcessGooglePage() || googlePageReported || !isGooglePage()) return;
      if (verificationRequired()) return sendResults();
      if (document.readyState === 'complete' && readyAt === null) {
        readyAt = Date.now();
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      }
      const now = Date.now();
      // Wait for the load event and a settling period so late-rendered result
      // anchors are included, but always report within a bounded interval.
      if ((readyAt !== null && now - readyAt >= 3500) || now - startedAt >= 15000) return sendResults();
      setTimeout(poll, 250);
    };
    if (document.readyState === 'loading') {
      window.addEventListener('load', () => setTimeout(poll, 250), { once: true });
    } else {
      poll();
    }
  }

  function exportToSheet() {
    if (!location.hostname.includes('docs.google.com') || !location.pathname.includes('/spreadsheets')) return;
    chrome.runtime.sendMessage({ type: 'GET_SHEET_ROWS' }, async response => {
      if (!response?.rows?.length) return;
      const tsv = response.rows.map(row => row.map(value => String(value ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
      try { await navigator.clipboard.writeText(tsv); } catch {}
      const cell = document.querySelector('[role="gridcell"], .waffle-grid-container');
      cell?.click();
      const pasted = document.execCommand('paste');
      if (!pasted) {
        const notice = document.createElement('div');
        notice.textContent = 'Sheet data copied. Click cell A1 and press Ctrl+V.';
        notice.style.cssText = 'position:fixed;top:20px;right:20px;z-index:2147483647;padding:12px;background:#161616;color:#fff;border:1px solid #8e44ad;border-radius:8px;font:700 13px Arial';
        document.body.appendChild(notice); setTimeout(() => notice.remove(), 5000);
      }
      chrome.runtime.sendMessage({ type: 'SHEET_EXPORT_DONE' });
    });
  }

  function showCompletionToast(state) {
    const id = 'dmf-completion-toast';
    document.getElementById(id)?.remove();
    const toast = document.createElement('div');
    toast.id = id;
    toast.textContent = `Decision maker search complete: ${state.profileLinks?.length || 0}/${state.totalProfilesFound || 0}`;
    toast.style.cssText = 'position:fixed!important;right:30px!important;bottom:30px!important;z-index:2147483647!important;padding:14px 18px;background:#161616;color:#fff;border:1px solid #8e44ad;border-radius:8px;font:700 14px Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);';
    document.body?.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
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
    exportToSheet();
  });

  chrome.storage.onChanged.addListener(changes => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue !== false;
      if (!enabled) googlePageReported = true;
    }
    if (changes.queries) settings.queries = changes.queries.newValue || [DEFAULT_QUERY];
    if (changes.blacklist) settings.blacklist = changes.blacklist.newValue || [];
    if (changes[RUN_STATE_KEY]) {
      const previous = runState;
      runState = changes[RUN_STATE_KEY].newValue || { running: false, phase: 'idle' };
      if (previous.running && !runState.running && runState.phase === 'complete') showCompletionToast(runState);
    }
    renderControls();
  });
})();


