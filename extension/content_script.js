/**
 * Universal Knowledge Recorder — Content Script
 * Estrae messaggi dalle chat AI note e inietta il contesto RAG nel textarea.
 */

const SERVER_BASE = 'http://localhost:3000';

// ─── Platform registry ────────────────────────────────────────────────────────

function chatgptSetPrompt(box, text) {
  const selector = box.id ? `#${box.id}` : box.tagName.toLowerCase();
  chrome.runtime.sendMessage({ action: 'replaceBoxText', selector, text }, (response) => {
    console.log('[OmniMem] background response:', JSON.stringify(response));
  });
}

const PLATFORMS = {
  'chat.openai.com': {
    name: 'ChatGPT',
    messageSelector: '[data-message-author-role]',
    getRoleAttr: (el) => el.getAttribute('data-message-author-role'),
    getTextContent: (el) => el.querySelector('.markdown, .whitespace-pre-wrap')?.innerText?.trim() ?? el.innerText.trim(),
    promptSelector: '#prompt-textarea',
    getPromptBox: () => document.querySelector('#prompt-textarea'),
    setPrompt: chatgptSetPrompt,
  },
  'chatgpt.com': {
    name: 'ChatGPT',
    messageSelector: '[data-message-author-role]',
    getRoleAttr: (el) => el.getAttribute('data-message-author-role'),
    getTextContent: (el) => el.querySelector('.markdown, .whitespace-pre-wrap')?.innerText?.trim() ?? el.innerText.trim(),
    promptSelector: '#prompt-textarea',
    getPromptBox: () => document.querySelector('#prompt-textarea'),
    setPrompt: chatgptSetPrompt,
  },
  'gemini.google.com': {
    name: 'Gemini',
    messageSelector: 'message-content, .user-request-interior-slot',
    getRoleAttr: (el) => el.tagName.toLowerCase() === 'message-content' ? 'assistant' : 'user',
    getTextContent: (el) => el.innerText?.trim(),
    promptSelector: 'div.ql-editor[contenteditable="true"]',
    getPromptBox: () => document.querySelector('div.ql-editor[contenteditable="true"]'),
    setPrompt: (box, text) => {
      box.focus();
      box.innerText = text;
      box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    },
  },
  'claude.ai': {
    name: 'Claude',
    messageSelector: '[data-is-streaming], .font-claude-message, .human-turn',
    getRoleAttr: (el) => el.classList.contains('human-turn') ? 'user' : 'assistant',
    getTextContent: (el) => el.innerText?.trim(),
    promptSelector: 'div[contenteditable="true"].ProseMirror',
    getPromptBox: () => document.querySelector('div[contenteditable="true"].ProseMirror'),
    setPrompt: (box, text) => {
      box.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    },
  },
  'chat.deepseek.com': {
    name: 'DeepSeek',
    messageSelector: '.message-item',
    getRoleAttr: (el) => el.classList.contains('user-message') ? 'user' : 'assistant',
    getTextContent: (el) => el.querySelector('.message-content')?.innerText?.trim() ?? el.innerText.trim(),
    promptSelector: 'textarea',
    getPromptBox: () => document.querySelector('textarea'),
    setPrompt: (box, text) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    },
  },
};

function detectPlatform() {
  const host = window.location.hostname;
  return Object.entries(PLATFORMS).find(([key]) => host.includes(key))?.[1] ?? null;
}

// ─── Message extraction ───────────────────────────────────────────────────────

function extractMessages(platform) {
  const nodes = document.querySelectorAll(platform.messageSelector);
  const messages = [];

  nodes.forEach((el) => {
    const role = platform.getRoleAttr(el) ?? 'unknown';
    const text = platform.getTextContent(el);
    if (text && text.length > 2) {
      messages.push({ role, text });
    }
  });

  return messages;
}

// ─── Manual target mode (unknown platforms) ──────────────────────────────────

let manualTargetBox = null;

function enterManualTargetMode() {
  showStatus('Clicca sul campo testo della chat per selezionarlo…', 'info');
  document.body.style.cursor = 'crosshair';

  function onClick(e) {
    const el = e.target;
    if (el.tagName === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true') {
      manualTargetBox = el;
      showStatus(`Target acquisito: <${el.tagName.toLowerCase()}>`, 'ok');
    } else {
      showStatus('Elemento non valido. Riprova.', 'warn');
    }
    document.body.style.cursor = '';
    document.removeEventListener('click', onClick, true);
  }

  document.addEventListener('click', onClick, { capture: true, once: false });
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function callServer(path, body) {
  const res = await fetch(`${SERVER_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Server ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Record action ────────────────────────────────────────────────────────────

function findScroller() {
  // Walk all elements and find the one actually scrolled (scrollTop > 0 with overflow scroll/auto)
  let best = null;
  let bestTop = 0;
  const all = document.querySelectorAll('*');
  for (const el of all) {
    if (el.scrollTop > bestTop) {
      const style = getComputedStyle(el);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        bestTop = el.scrollTop;
        best = el;
      }
    }
  }
  return best ?? document.scrollingElement ?? document.documentElement;
}

async function scrollToLoadAll() {
  return new Promise((resolve) => {
    let lastCount = 0;
    let stableRounds = 0;
    const MAX_STABLE = 3;
    const MAX_ROUNDS = 60; // hard cap ~30s
    let round = 0;

    const tick = () => {
      const scroller = findScroller();
      scroller.scrollTop = 0;
      window.scrollTo(0, 0);

      setTimeout(() => {
        const currentCount = document.querySelectorAll(
          '[data-message-author-role], message-content, .user-request-interior-slot, .font-claude-message, .human-turn, .message-item'
        ).length;

        if (currentCount === lastCount) {
          stableRounds++;
        } else {
          stableRounds = 0;
          lastCount = currentCount;
        }

        round++;
        if (stableRounds >= MAX_STABLE || round >= MAX_ROUNDS) {
          resolve(lastCount);
        } else {
          showStatus(`Scorrimento… (${lastCount} messaggi trovati)`, 'info');
          tick();
        }
      }, 600);
    };

    tick();
  });
}

async function recordChat(topic) {
  const platform = detectPlatform();
  if (!platform) {
    showStatus('Piattaforma non riconosciuta.', 'warn');
    return;
  }

  showStatus('Scorrimento pagina per caricare tutta la chat…', 'info');
  await scrollToLoadAll();

  const messages = extractMessages(platform);
  if (messages.length === 0) {
    showStatus('Nessun messaggio trovato.', 'warn');
    return;
  }

  showStatus(`Invio ${messages.length} messaggi…`, 'info');

  let jobId;
  try {
    const res = await callServer('/api/record', {
      messages,
      topic,
      metadata: {
        source_url: window.location.href,
        platform: platform.name,
        timestamp: Date.now(),
      },
    });
    jobId = res.jobId;
  } catch (err) {
    showStatus(`Errore: ${err.message}`, 'error');
    return;
  }

  // Polling con progress bar
  showProgress(0, messages.length);
  const pollInterval = setInterval(async () => {
    try {
      const prog = await (await fetch(`${SERVER_BASE}/api/progress/${jobId}`)).json();
      if (prog.status === 'processing') {
        showProgress(prog.done, prog.total);
      } else if (prog.status === 'done') {
        clearInterval(pollInterval);
        hideProgress();
        showStatus(`✓ Salvati ${prog.chunks_saved} chunk su ChromaDB.`, 'ok');
      } else if (prog.status === 'error') {
        clearInterval(pollInterval);
        hideProgress();
        showStatus(`Errore embedding: ${prog.error}`, 'error');
      }
    } catch (e) {
      clearInterval(pollInterval);
      hideProgress();
      showStatus(`Errore polling: ${e.message}`, 'error');
    }
  }, 1500);
}

// ─── Inject context action ────────────────────────────────────────────────────

async function injectContext(topic, currentQuery) {
  showStatus('Ricerca contesto RAG…', 'info');

  let result;
  try {
    result = await callServer('/api/query', { query: currentQuery, topic, k: 4 });
  } catch (err) {
    showStatus(`Errore query: ${err.message}`, 'error');
    return;
  }

  const { chunks } = result;
  if (!chunks || chunks.length === 0) {
    showStatus('Nessun contesto trovato per questo argomento.', 'warn');
    return;
  }

  const contextPrefix = [
    '--- CONTESTO DALLA TUA MEMORIA PERSONALE ---',
    ...chunks.map((c, i) => `[${i + 1}] ${c}`),
    '--- FINE CONTESTO ---',
    '',
    currentQuery,
  ].join('\n');

  const platform = detectPlatform();
  const box = platform ? platform.getPromptBox() : manualTargetBox;

  if (!box) {
    showStatus('Prompt box non trovato. Usa modalità manuale.', 'warn');
    return;
  }

  platform ? platform.setPrompt(box, contextPrefix) : (() => {  // contextPrefix here is the full contextBlock
    if (box.tagName === 'TEXTAREA') {
      const pos = 0;
      box.setSelectionRange(pos, pos);
      document.execCommand('insertText', false, contextPrefix);
    } else {
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(box, 0);
      range.setEnd(box, 0);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, contextPrefix);
    }
  })();

  showStatus('Contesto iniettato nel prompt.', 'ok');
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function showProgress(done, total, labelText) {
  const bar = document.getElementById('omnimem-progress-bar');
  const label = document.getElementById('omnimem-progress-label');
  const wrap = document.getElementById('omnimem-progress-wrap');
  if (!bar || !wrap) return;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  bar.style.width = `${pct}%`;
  label.textContent = labelText ?? `Embedding ${done}/${total} chunk (${pct}%)`;
  wrap.style.display = 'block';
}

function hideProgress() {
  const wrap = document.getElementById('omnimem-progress-wrap');
  if (wrap) wrap.style.display = 'none';
}

// ─── Topics loader ────────────────────────────────────────────────────────────

async function deleteTopic(topic) {
  const res = await fetch(`${SERVER_BASE}/api/topics/${encodeURIComponent(topic)}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Errore eliminazione');
  return data.deleted;
}

async function loadTopics() {
  const sel = document.getElementById('omnimem-topic');
  if (!sel) return;
  try {
    const res = await fetch(`${SERVER_BASE}/api/topics`);
    const { topics } = await res.json();
    sel.innerHTML = '';
    for (const t of (topics.length ? topics : ['Generale'])) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      sel.appendChild(opt);
    }
    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '＋ Nuovo argomento…';
    sel.appendChild(newOpt);
  } catch {
    sel.innerHTML = '<option value="Generale">Generale</option><option value="__new__">＋ Nuovo argomento…</option>';
  }
}

// ─── Box text reader ─────────────────────────────────────────────────────────

function readBoxText(box) {
  if (!box) return '';
  if (box.tagName === 'TEXTAREA') {
    // React controlled inputs intercettano .value — usa il native getter per leggere il valore reale
    try {
      const nativeGetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').get;
      const val = nativeGetter.call(box).trim();
      if (val) return val;
    } catch {}
    return (box.value ?? '').trim();
  }
  return (box.innerText ?? box.textContent ?? '').trim();
}

// ─── Floating UI ──────────────────────────────────────────────────────────────

let statusTimeout;

function showStatus(msg, level = 'info') {
  const el = document.getElementById('omnimem-status');
  if (!el) return;
  const colors = { info: '#aaa', ok: '#5dba5d', warn: '#d4a017', error: '#e05555' };
  el.textContent = msg;
  el.style.color = colors[level] ?? '#aaa';
  clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => { el.textContent = ''; }, 5000);
}

function buildUI() {
  if (document.getElementById('omnimem-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'omnimem-panel';
  panel.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
    background: #1a1a1a; border: 1px solid #3a3a3a; border-radius: 10px;
    padding: 10px 14px; font-family: system-ui, sans-serif; font-size: 13px;
    box-shadow: 0 4px 20px rgba(0,0,0,.6); min-width: 220px; max-width: 280px;
    user-select: none; color: #e8e8e8;
  `;

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <strong style="font-size:14px;color:#e8e8e8">🧠 OmniMem</strong>
      <button id="omnimem-close" style="background:none;border:none;cursor:pointer;font-size:16px;line-height:1;color:#aaa">×</button>
    </div>

    <div style="margin-bottom:6px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px">
        <label style="font-size:11px;color:#aaa">Argomento</label>
        <button id="omnimem-delete-topic" title="Elimina argomento e tutti i dati" style="background:none;border:none;cursor:pointer;font-size:13px;color:#e05555;padding:0 2px;line-height:1">🗑</button>
      </div>
      <select id="omnimem-topic"
        style="width:100%;box-sizing:border-box;border:1px solid #444;border-radius:5px;padding:4px 6px;font-size:12px;margin-top:2px;background:#2a2a2a;color:#e8e8e8">
        <option value="">Caricamento…</option>
      </select>
      <input id="omnimem-topic-new" type="text" placeholder="Nuovo argomento…"
        style="display:none;width:100%;box-sizing:border-box;border:1px solid #444;border-radius:5px;padding:4px 6px;font-size:12px;margin-top:4px;background:#2a2a2a;color:#e8e8e8"/>
    </div>

    <div style="display:flex;gap:6px;margin-bottom:8px">
      <button id="omnimem-rec" style="flex:1;background:#c0392b;color:#fff;border:none;border-radius:5px;padding:6px;cursor:pointer;font-size:12px">
        ● Rec
      </button>
      <button id="omnimem-inject" style="flex:1;background:#2471a3;color:#fff;border:none;border-radius:5px;padding:6px;cursor:pointer;font-size:12px">
        ↑ Inject
      </button>
    </div>

    <div style="display:flex;gap:6px;margin-bottom:6px">
      <button id="omnimem-manual" style="flex:1;background:#6d4c1f;color:#f0c060;border:none;border-radius:5px;padding:5px;cursor:pointer;font-size:11px">
        ✎ Target manuale
      </button>
    </div>

    <div style="border-top:1px solid #2e2e2e;margin-top:4px;padding-top:6px">
      <div id="omnimem-codebase-toggle" style="cursor:pointer;font-size:11px;color:#888;display:flex;align-items:center;gap:5px;user-select:none">
        <span id="omnimem-codebase-arrow" style="font-size:9px">▶</span> 📁 Ingest codebase
      </div>
      <div id="omnimem-codebase-panel" style="display:none;margin-top:6px">
        <input id="omnimem-codebase-path" type="text" placeholder="C:\percorso\progetto"
          style="width:100%;box-sizing:border-box;border:1px solid #444;border-radius:5px;padding:4px 6px;font-size:11px;margin-bottom:4px;background:#2a2a2a;color:#e8e8e8"/>
        <label style="font-size:10px;color:#666;display:block;margin-bottom:2px">Estensioni (separate da virgola)</label>
        <input id="omnimem-codebase-ext" type="text" value="js,ts,jsx,tsx,php,py,java,cs,go,rb,rs,vue,css,html,sql,md"
          style="width:100%;box-sizing:border-box;border:1px solid #444;border-radius:5px;padding:4px 6px;font-size:11px;margin-bottom:4px;background:#2a2a2a;color:#aaa"/>
        <button id="omnimem-codebase-ingest" style="width:100%;background:#1e5f3f;color:#7ecfaa;border:none;border-radius:5px;padding:5px;cursor:pointer;font-size:11px;font-weight:600">
          📥 Ingest
        </button>
      </div>
    </div>

    <div id="omnimem-progress-wrap" style="display:none;margin-bottom:6px">
      <div style="font-size:10px;color:#aaa;margin-bottom:2px" id="omnimem-progress-label">Embedding…</div>
      <div style="background:#3a3a3a;border-radius:4px;height:8px;overflow:hidden">
        <div id="omnimem-progress-bar" style="height:100%;width:0%;background:#2471a3;border-radius:4px;transition:width .3s"></div>
      </div>
    </div>
    <div id="omnimem-status" style="font-size:11px;color:#aaa;min-height:16px;word-break:break-word"></div>
  `;

  document.body.appendChild(panel);

  document.getElementById('omnimem-close').addEventListener('click', () => panel.remove());

  // Populate topic select from memory
  loadTopics();

  const topicSelect = document.getElementById('omnimem-topic');
  const topicNew = document.getElementById('omnimem-topic-new');
  topicSelect.addEventListener('change', () => {
    topicNew.style.display = topicSelect.value === '__new__' ? 'block' : 'none';
    if (topicSelect.value === '__new__') topicNew.focus();
  });

  function getSelectedTopic() {
    if (topicSelect.value === '__new__') return topicNew.value.trim() || 'Generale';
    return topicSelect.value || 'Generale';
  }

  document.getElementById('omnimem-rec').addEventListener('click', async () => {
    await recordChat(getSelectedTopic());
  });

  document.getElementById('omnimem-inject').addEventListener('click', async () => {
    const topic = getSelectedTopic();
    const platform = detectPlatform();
    const box = platform ? platform.getPromptBox() : manualTargetBox;
    const currentQuery = box ? readBoxText(box) : '';
    await injectContext(topic, currentQuery);
  });

  document.getElementById('omnimem-manual').addEventListener('click', enterManualTargetMode);

  document.getElementById('omnimem-delete-topic').addEventListener('click', async () => {
    const topic = getSelectedTopic();
    if (!topic || topic === 'Generale' && topicSelect.value === '__new__') return;
    if (!confirm(`Eliminare l'argomento "${topic}" e tutti i suoi dati?\nL'operazione è irreversibile.`)) return;
    try {
      const deleted = await deleteTopic(topic);
      showStatus(`Eliminati ${deleted} chunk da "${topic}"`, 'ok');
      await loadTopics();
    } catch (err) {
      showStatus(`Errore: ${err.message}`, 'error');
    }
  });

  // Codebase toggle
  document.getElementById('omnimem-codebase-toggle').addEventListener('click', () => {
    const panel = document.getElementById('omnimem-codebase-panel');
    const arrow = document.getElementById('omnimem-codebase-arrow');
    const open = panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    arrow.textContent = open ? '▼' : '▶';
  });

  // Codebase ingest
  document.getElementById('omnimem-codebase-ingest').addEventListener('click', async () => {
    const path = document.getElementById('omnimem-codebase-path').value.trim();
    const extRaw = document.getElementById('omnimem-codebase-ext').value.trim();
    const topic = getSelectedTopic();

    if (!path) { showStatus('Inserisci il percorso della codebase.', 'warn'); return; }

    const extensions = extRaw ? extRaw.split(',').map((e) => e.trim()).filter(Boolean) : [];

    let jobId;
    try {
      const res = await callServer('/api/ingest-codebase', { path, topic, extensions });
      jobId = res.jobId;
    } catch (err) {
      showStatus(`Errore: ${err.message}`, 'error');
      return;
    }

    showProgress(0, 1, 'Scansione file in corso…');
    const poll = setInterval(async () => {
      try {
        const prog = await (await fetch(`${SERVER_BASE}/api/progress/${jobId}`)).json();
        if (prog.status === 'processing') {
          showProgress(prog.done, prog.total, `File ${prog.done}/${prog.total}…`);
        } else if (prog.status === 'done') {
          clearInterval(poll);
          hideProgress();
          showStatus(`✓ Codebase salvata: ${prog.chunks_saved} chunk nel topic "${topic}".`, 'ok');
        } else if (prog.status === 'error') {
          clearInterval(poll);
          hideProgress();
          showStatus(`Errore ingest: ${prog.error}`, 'error');
        }
      } catch (e) {
        clearInterval(poll);
        hideProgress();
        showStatus(`Errore polling: ${e.message}`, 'error');
      }
    }, 1500);
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

// Listen for toggle message from popup / background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'togglePanel') buildUI();
});

// Auto-build if already enabled (persisted via storage)
chrome.storage.local.get('omnimemPanelOpen', ({ omnimemPanelOpen }) => {
  if (omnimemPanelOpen) buildUI();
});
