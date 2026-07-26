const toggle = document.getElementById('enabled');
const status = document.getElementById('status');
const tokenField = document.getElementById('serverToken');
const saveTokenBtn = document.getElementById('saveToken');

chrome.storage.local.get('omnimemPanelOpen', ({ omnimemPanelOpen }) => {
  toggle.checked = !!omnimemPanelOpen;
  status.textContent = omnimemPanelOpen ? 'Attiva su tutti i tab.' : 'Disattivata.';
});

toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  chrome.storage.local.set({ omnimemPanelOpen: enabled }, () => {
    status.textContent = enabled ? 'Attiva su tutti i tab.' : 'Disattivata.';
  });
});

chrome.storage.local.get('omnimemServerToken', ({ omnimemServerToken }) => {
  tokenField.value = omnimemServerToken || '';
});

saveTokenBtn.addEventListener('click', () => {
  chrome.storage.local.set({ omnimemServerToken: tokenField.value.trim() }, () => {
    saveTokenBtn.textContent = 'Salvato ✓';
    setTimeout(() => { saveTokenBtn.textContent = 'Salva token'; }, 1500);
  });
});
