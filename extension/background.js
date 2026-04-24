/**
 * Background service worker — OmniMem
 * Esegue la manipolazione DOM nel main world per bypassare i limiti dell'isolated world.
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'replaceBoxText') {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: (selector, fullText) => {
        const box = document.querySelector(selector);
        if (!box) return 'box_not_found';

        box.focus();

        if (box.tagName === 'TEXTAREA') {
          box.setSelectionRange(0, box.value.length);
          document.execCommand('insertText', false, fullText);
        } else {
          // contenteditable React: selectAll + insertText nel MAIN world
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, fullText);
        }

        return 'ok';
      },
      args: [msg.selector, msg.text],
    })
      .then(([res]) => sendResponse({ ok: true, result: res?.result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));

    return true;
  }
});
