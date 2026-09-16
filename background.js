function buildSearchUrl(domain, query) {
  const cleanDomain = String(domain || '').toLowerCase().replace(/^www\./, '').trim();
  const cleanQuery = String(query || '').trim();
  if (!cleanDomain || !cleanQuery || !/^[a-z0-9.-]+$/i.test(cleanDomain)) return null;
  return `https://www.google.com/search?q=${encodeURIComponent(`${cleanDomain} ${cleanQuery}`)}`;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'OPEN_QUERY_SEARCHES') return;

  const queries = Array.isArray(message.queries)
    ? message.queries.map(query => String(query).trim()).filter(Boolean)
    : [];
  const urls = queries.map(query => buildSearchUrl(message.domain, query)).filter(Boolean);
  if (!urls.length) {
    sendResponse({ opened: 0 });
    return;
  }

  const currentTabId = message.sourceTabId || sender.tab?.id;
  const firstAction = currentTabId
    ? chrome.tabs.update(currentTabId, { url: urls[0] })
    : chrome.tabs.create({ url: urls[0], active: true });
  const additionalTabs = urls.slice(1).map(url => chrome.tabs.create({ url, active: false }));

  Promise.all([firstAction, ...additionalTabs]).then(() => sendResponse({ opened: urls.length }))
    .catch(error => sendResponse({ opened: 0, error: String(error) }));
  return true;
});
