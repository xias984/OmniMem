document.getElementById('toggle').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' }, () => {
      if (chrome.runtime.lastError) {
        // Content script non disponibile su questa pagina (chrome://, new tab, ecc.)
        console.warn('[OmniMem]', chrome.runtime.lastError.message);
      }
    });
    chrome.storage.local.set({ omnimemPanelOpen: true });
    window.close();
  });
});
