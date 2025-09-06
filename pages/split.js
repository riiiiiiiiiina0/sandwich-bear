const defaultTitle = 'Sandwich Bear';
const defaultFavicon = '../icons/icon-128x128.png';

function setTitle(text) {
  document.title = text || defaultTitle;
}

function ensureFaviconLink() {
  let link = document.querySelector('link[rel="icon"]');
  if (!(link instanceof HTMLLinkElement)) {
    const newLink = document.createElement('link');
    newLink.rel = 'icon';
    document.head.appendChild(newLink);
    return newLink;
  }
  return link;
}

function setFavicon(href) {
  const link = ensureFaviconLink();
  if (link instanceof HTMLLinkElement) {
    link.href = href || defaultFavicon;
  }
}

// Initialize defaults
setTitle(defaultTitle);
setFavicon(defaultFavicon);

// Connect to background via chrome.runtime Port to receive targeted messages
// Listen to direct runtime messages from the background
try {
  chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    if (!message || typeof message !== 'object') return;
    const { type, payload } = message;
    if (type === 'split:updateMeta') {
      const { title, favicon } = payload || {};
      setTitle(title);
      setFavicon(favicon);
    } else if (type === 'split:resetMeta') {
      const titles =
        payload && Array.isArray(payload.titles) ? payload.titles : [];
      const joined = titles.length > 0 ? titles.join(' | ') : defaultTitle;
      setTitle(joined);
      setFavicon(defaultFavicon);
    }
  });
} catch (_e) {
  // ignore
}
