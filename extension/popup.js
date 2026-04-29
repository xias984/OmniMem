const toggle = document.getElementById('enabled');
const status = document.getElementById('status');

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
