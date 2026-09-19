// Toolbar click: open the downloader tab for the show you're looking at.
// If the downloader is already open (maybe mid-download), reuse that tab.

const APP_URL = chrome.runtime.getURL('app.html');
const SHOW_RE = /^https?:\/\/(?:www\.)?u-tv\.ru\/shows\/([a-z0-9-]+)/i;

async function handleActionClick(tab) {
  const m = tab && tab.url ? tab.url.match(SHOW_RE) : null;
  const slug = m ? m[1].toLowerCase() : null;

  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  const existing = contexts.find((c) => c.documentUrl && c.documentUrl.startsWith(APP_URL) && c.tabId >= 0);
  if (existing) {
    await chrome.tabs.update(existing.tabId, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    if (slug) await chrome.runtime.sendMessage({ type: 'open-show', slug }).catch(() => {});
    return;
  }

  await chrome.tabs.create({
    url: APP_URL + (slug ? `?show=${encodeURIComponent(slug)}` : ''),
    index: tab ? tab.index + 1 : undefined,
    windowId: tab ? tab.windowId : undefined,
  });
}

chrome.action.onClicked.addListener(handleActionClick);

// "Saved: … — click to show the file" works even after the downloader tab is closed.
chrome.notifications.onClicked.addListener((id) => {
  const m = id.match(/-(\d+)$/);
  if (m) chrome.downloads.show(Number(m[1]));
  chrome.notifications.clear(id);
});

// If the downloader tab closes mid-download, don't leave "37%" on the icon: show the NEW count again.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { appTab, newCount } = await chrome.storage.session.get(['appTab', 'newCount']);
  if (tabId !== appTab) return;
  await chrome.storage.session.remove('appTab');
  await chrome.action.setBadgeBackgroundColor({ color: '#e2185b' });
  await chrome.action.setBadgeText({ text: newCount ? String(newCount) : '' });
});
