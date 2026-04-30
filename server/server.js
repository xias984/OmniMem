/**
 * Universal Knowledge Recorder — Local Bridge Server
 * Express + ChromaDB + Ollama embeddings + Tesseract OCR
 *
 * Avvio: node server.js
 * Dipendenze: npm install express chromadb cors tesseract.js
 * Prerequisito: Ollama in esecuzione con `nomic-embed-text` pullato.
 */

import express from 'express';
import cors from 'cors';
import { ChromaClient } from 'chromadb';
import Tesseract from 'tesseract.js';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative } from 'path';

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
const COLLECTION_NAME = 'omnimem';
const OLLAMA_BASE = process.env.OLLAMA_BASE ?? 'http://localhost:11434';
const EMBED_MODEL = process.env.EMBED_MODEL ?? 'nomic-embed-text';
const CHUNK_SIZE = 800;   // caratteri per chunk
const CHUNK_OVERLAP = 80; // overlap per preservare contesto numerico

// ─── ChromaDB ─────────────────────────────────────────────────────────────────

const CHROMA_URL = process.env.CHROMA_URL ?? 'http://localhost:8000';
const chroma = new ChromaClient({ path: CHROMA_URL });

async function getCollection() {
  return chroma.getOrCreateCollection({
    name: COLLECTION_NAME,
    metadata: { 'hnsw:space': 'cosine' },
  });
}

// ─── Embedding via Ollama ─────────────────────────────────────────────────────

async function embed(texts) {
  const inputs = Array.isArray(texts) ? texts : [texts];
  const embeddings = [];

  for (const text of inputs) {
    const res = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    });
    if (!res.ok) throw new Error(`Ollama embedding error: ${res.status}`);
    const { embedding } = await res.json();
    embeddings.push(embedding);
  }

  return embeddings;
}

// ─── Semantic chunking con overlap ────────────────────────────────────────────

/**
 * Divide il testo rispettando i confini di messaggio (doppio newline),
 * con overlap per non spezzare numeri o entità critiche.
 */
function chunkMessages(messages) {
  const chunks = [];

  for (const { role, text } of messages) {
    const header = `[${role.toUpperCase()}]`;
    const full = `${header} ${text}`;

    if (full.length <= CHUNK_SIZE) {
      chunks.push(full);
      continue;
    }

    // Split su paragrafi naturali prima
    const paragraphs = full.split(/\n{2,}/);
    let current = '';

    for (const para of paragraphs) {
      if ((current + '\n\n' + para).length <= CHUNK_SIZE) {
        current = current ? current + '\n\n' + para : para;
      } else {
        if (current) chunks.push(current);
        // Paragrafo troppo lungo: split grezzo con overlap
        if (para.length > CHUNK_SIZE) {
          let i = 0;
          while (i < para.length) {
            chunks.push(para.slice(i, i + CHUNK_SIZE));
            i += CHUNK_SIZE - CHUNK_OVERLAP;
          }
          current = '';
        } else {
          current = para;
        }
      }
    }
    if (current) chunks.push(current);
  }

  return chunks.filter((c) => c.trim().length > 0);
}

// ─── OCR ──────────────────────────────────────────────────────────────────────

async function ocrBase64(base64Image) {
  const buffer = Buffer.from(base64Image, 'base64');
  const { data: { text } } = await Tesseract.recognize(buffer, 'ita+eng');
  return text.trim();
}

// ─── ID generation ────────────────────────────────────────────────────────────

function makeId(metadata, chunkIndex) {
  const base = `${metadata.source_url}_${chunkIndex}`;
  return base.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ─── Job store (processing asincrono) ────────────────────────────────────────

const jobs = new Map();

function makeJobId() {
  return Math.random().toString(36).slice(2, 10);
}

async function processRecord(body, jobId) {
  const job = jobs.get(jobId);
  try {
    const { messages, topic, metadata, imageBase64 } = body;
    let allMessages = [...messages];

    if (imageBase64) {
      const ocrText = await ocrBase64(imageBase64);
      if (ocrText) allMessages.push({ role: 'ocr', text: ocrText });
    }

    const chunks = chunkMessages(allMessages);
    job.total = chunks.length;

    const embeddings = [];
    for (let i = 0; i < chunks.length; i++) {
      const [emb] = await embed(chunks[i]);
      embeddings.push(emb);
      job.done = i + 1;
    }

    const collection = await getCollection();
    const ids = chunks.map((_, i) => makeId(metadata, i));
    const metadatas = chunks.map(() => ({
      source_url: metadata.source_url ?? '',
      platform: metadata.platform ?? 'unknown',
      topic: topic ?? 'Generale',
      timestamp: metadata.timestamp ?? Date.now(),
    }));

    await collection.upsert({ ids, embeddings, documents: chunks, metadatas });

    job.status = 'done';
    job.chunks_saved = chunks.length;
    console.log(`[omnimem:record] job ${jobId} completato: ${chunks.length} chunk`);
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    console.error(`[omnimem:record] job ${jobId} errore:`, err.message);
  }

  // Pulisce il job dopo 10 minuti
  setTimeout(() => jobs.delete(jobId), 600_000);
}

// ─── Codebase ingestion ───────────────────────────────────────────────────────

const DEFAULT_CODE_EXTENSIONS = new Set([
  'js','ts','jsx','tsx','mjs','cjs',
  'php','py','java','cs','go','rb','rs','cpp','c','h','hpp',
  'vue','svelte','html','css','scss','sass','less',
  'sql','sh','bash','yaml','yml','json','toml','md','txt',
]);

const SKIP_DIRS = new Set([
  'node_modules','.git','dist','build','vendor','.next','__pycache__',
  '.venv','venv','coverage','.cache','.idea','.vscode','target','out',
]);

// Pattern di file da saltare sempre (lock files, minified, generated)
const SKIP_FILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /composer\.lock$/,
  /\.min\.(js|css)$/,
  /\.bundle\.js$/,
  /\.chunk\.js$/,
];

function shouldSkipFile(filename) {
  return SKIP_FILE_PATTERNS.some((re) => re.test(filename));
}

function walkDir(dir, extSet, files = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return files; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walkDir(full, extSet, files);
      } else {
        if (shouldSkipFile(entry)) continue;
        const ext = extname(entry).toLowerCase().replace('.', '');
        if (extSet.has(ext)) files.push(full);
      }
    } catch {}
  }
  return files;
}

function chunkCode(relPath, content) {
  const header = `[FILE: ${relPath}]`;
  const lines = content.split('\n');
  const chunks = [];
  let current = header + '\n';
  const OVERLAP_LINES = 5;

  for (const line of lines) {
    if ((current + line + '\n').length > CHUNK_SIZE && current.trim() !== header) {
      chunks.push(current.trim());
      const tail = current.split('\n').slice(-(OVERLAP_LINES + 1)).join('\n');
      current = header + '\n' + tail + '\n' + line + '\n';
    } else {
      current += line + '\n';
    }
  }
  if (current.trim() && current.trim() !== header) chunks.push(current.trim());
  return chunks;
}

// Traduce un path host (es. "C:\daniel\memory-ext-ai") nel path container
// (es. "/workspace/memory-ext-ai") quando il server gira in Docker con
// CODEBASE_HOST_PATH bind-mountato su /workspace. No-op fuori da Docker.
function translateHostPath(rootPath) {
  const hostPrefix = process.env.CODEBASE_HOST_PATH;
  if (!hostPrefix || hostPrefix === '.') return rootPath;
  const normalize = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const normRoot = normalize(rootPath);
  const normPrefix = normalize(hostPrefix);
  if (normRoot === normPrefix) return '/workspace';
  if (normRoot.startsWith(normPrefix + '/')) {
    return '/workspace' + rootPath.replace(/\\/g, '/').slice(hostPrefix.length);
  }
  return rootPath;
}

async function processIngestCodebase(body, jobId) {
  const job = jobs.get(jobId);
  try {
    const { path: rawPath, topic, extensions } = body;
    const rootPath = translateHostPath(rawPath);
    if (rootPath !== rawPath) {
      console.log(`[ingest-codebase] path host "${rawPath}" → container "${rootPath}"`);
    }
    const extSet = extensions?.length
      ? new Set(extensions.map((e) => e.toLowerCase().replace(/^\./, '')))
      : DEFAULT_CODE_EXTENSIONS;

    const files = walkDir(rootPath, extSet);
    if (files.length === 0) {
      job.status = 'done';
      job.chunks_saved = 0;
      return;
    }

    // Prima passata: conta i chunk totali per progress bar accurata
    const fileChunks = [];
    for (const filePath of files) {
      const relPath = relative(rootPath, filePath).replace(/\\/g, '/');
      let content;
      try { content = readFileSync(filePath, 'utf-8'); } catch { fileChunks.push([]); continue; }
      if (content.length > 200_000) { fileChunks.push([]); continue; }
      fileChunks.push(chunkCode(relPath, content));
    }

    const totalChunkCount = fileChunks.reduce((s, c) => s + c.length, 0);
    job.total = totalChunkCount || 1;
    job.done = 0;

    const collection = await getCollection();
    let savedChunks = 0;

    for (let fi = 0; fi < files.length; fi++) {
      const chunks = fileChunks[fi];
      if (chunks.length === 0) continue;

      const filePath = files[fi];
      const relPath = relative(rootPath, filePath).replace(/\\/g, '/');

      const embeddings = [];
      for (const chunk of chunks) {
        const [emb] = await embed(chunk);
        embeddings.push(emb);
        job.done += 1; // progresso per chunk
      }

      const baseId = `codebase_${topic}_${relPath}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      const ids = chunks.map((_, ci) => `${baseId}_${ci}`);
      const metadatas = chunks.map(() => ({
        source_url: `file://${filePath}`,
        platform: 'codebase',
        topic: topic ?? 'Generale',
        timestamp: Date.now(),
        file_path: relPath,
      }));

      await collection.upsert({ ids, embeddings, documents: chunks, metadatas });
      savedChunks += chunks.length;
    }

    job.status = 'done';
    job.chunks_saved = savedChunks;
    console.log(`[ingest-codebase] job ${jobId} completato: ${savedChunks} chunk da ${files.length} file`);
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    console.error(`[ingest-codebase] job ${jobId} errore:`, err.message);
  }
  setTimeout(() => jobs.delete(jobId), 600_000);
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();

app.use(cors({ origin: true }));

app.use(express.json({ limit: '20mb' }));

// ─── POST /api/record ─────────────────────────────────────────────────────────

app.post('/api/record', (req, res) => {
  const { messages, topic } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages vuoto o mancante' });
  }

  const jobId = makeJobId();
  jobs.set(jobId, { status: 'processing', done: 0, total: messages.length, error: null });

  // Risponde subito con il jobId — il processing avviene in background
  res.json({ ok: true, jobId, total_messages: messages.length });

  processRecord(req.body, jobId);
});

// ─── GET /api/progress/:jobId ─────────────────────────────────────────────────

app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job non trovato o scaduto' });
  res.json(job);
});

// ─── POST /api/query ──────────────────────────────────────────────────────────

app.post('/api/query', async (req, res) => {
  try {
    const { query, topic, k = 4 } = req.body;

    if (!query) return res.status(400).json({ error: 'query mancante' });

    const [queryEmbedding] = await embed(query);
    const collection = await getCollection();

    const whereClause = topic && topic !== 'Generale'
      ? { topic: { $eq: topic } }
      : undefined;

    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: k,
      where: whereClause,
    });

    const chunks = results.documents?.[0] ?? [];
    const distances = results.distances?.[0] ?? [];
    const metas = results.metadatas?.[0] ?? [];

    // Filtra risultati con similarità coseno < 0.75 (distanza > 0.25)
    const filtered = chunks
      .map((doc, i) => ({ doc, dist: distances[i], meta: metas[i] }))
      .filter(({ dist }) => dist <= 0.75)
      .map(({ doc, meta }) => `[${meta?.platform ?? '?'} — ${meta?.topic ?? '?'}]\n${doc}`);

    res.json({ ok: true, chunks: filtered });
  } catch (err) {
    console.error('[query]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/topics ─────────────────────────────────────────────────────────

app.get('/api/topics', async (req, res) => {
  try {
    const collection = await getCollection();
    const results = await collection.get({ include: ['metadatas'], limit: 5000 });
    const metas = results.metadatas ?? [];
    const topics = [...new Set(metas.map((m) => m?.topic).filter(Boolean))].sort();
    res.json({ ok: true, topics });
  } catch (err) {
    console.error('[topics]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/topics/:topic ───────────────────────────────────────────────

app.delete('/api/topics/:topic', async (req, res) => {
  try {
    const topic = decodeURIComponent(req.params.topic);
    const collection = await getCollection();

    // Recupera gli ID dei documenti da eliminare
    const results = await collection.get({
      where: { topic: { $eq: topic } },
      include: [],
      limit: 10000,
    });

    const ids = results.ids ?? [];
    if (ids.length === 0) {
      return res.status(404).json({ error: `Nessun documento trovato per topic: ${topic}` });
    }

    await collection.delete({ ids });
    console.log(`[delete-topic] Eliminati ${ids.length} chunk per topic "${topic}"`);
    res.json({ ok: true, deleted: ids.length });
  } catch (err) {
    console.error('[delete-topic]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/ingest-codebase ───────────────────────────────────────────────

app.post('/api/ingest-codebase', (req, res) => {
  const { path: rootPath, topic, extensions } = req.body;
  if (!rootPath) return res.status(400).json({ error: 'path mancante' });
  if (!topic) return res.status(400).json({ error: 'topic mancante' });

  const jobId = makeJobId();
  jobs.set(jobId, { status: 'processing', done: 0, total: 0, chunks_saved: 0 });
  processIngestCodebase({ path: rootPath, topic, extensions }, jobId);
  res.json({ ok: true, jobId });
});

// ─── GET /api/export/:topic ───────────────────────────────────────────────────

app.get('/api/export/:topic', async (req, res) => {
  try {
    const topic = decodeURIComponent(req.params.topic);
    const collection = await getCollection();

    // Recupera tutti i documenti per quel topic (fino a 500)
    const results = await collection.get({
      where: { topic: { $eq: topic } },
      include: ['documents', 'metadatas'],
      limit: 500,
    });

    const docs = results.documents ?? [];
    const metas = results.metadatas ?? [];

    if (docs.length === 0) {
      return res.status(404).json({ error: `Nessun documento trovato per topic: ${topic}` });
    }

    // Raggruppa per piattaforma e ordina per timestamp
    const entries = docs
      .map((doc, i) => ({ doc, meta: metas[i] }))
      .sort((a, b) => (a.meta?.timestamp ?? 0) - (b.meta?.timestamp ?? 0));

    const lines = [
      `# Memoria: ${topic}`,
      `_Esportato il ${new Date().toISOString()}_`,
      '',
      `**Totale chunk:** ${docs.length}`,
      '',
      '---',
      '',
    ];

    for (const { doc, meta } of entries) {
      const ts = meta?.timestamp ? new Date(meta.timestamp).toLocaleString('it-IT') : '?';
      lines.push(`### [${meta?.platform ?? 'unknown'}] — ${ts}`);
      if (meta?.source_url) lines.push(`_Fonte: ${meta.source_url}_`);
      lines.push('');
      lines.push(doc);
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${topic.replace(/\s+/g, '_')}.md"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('[export]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/stats ──────────────────────────────────────────────────────────

app.get('/api/stats', async (_req, res) => {
  try {
    const collection = await getCollection();
    const results = await collection.get({ include: ['metadatas'], limit: 100000 });
    const metas = results.metadatas ?? [];

    const byTopic = new Map();
    for (const m of metas) {
      const topic = m?.topic ?? 'Generale';
      const platform = m?.platform ?? 'unknown';
      const source = m?.source_url ?? '';
      const ts = m?.timestamp ?? 0;

      if (!byTopic.has(topic)) {
        byTopic.set(topic, {
          topic,
          chunks: 0,
          platforms: new Map(),
          sources: new Set(),
          last_timestamp: 0,
        });
      }
      const t = byTopic.get(topic);
      t.chunks += 1;
      t.platforms.set(platform, (t.platforms.get(platform) ?? 0) + 1);
      if (source) t.sources.add(source);
      if (ts > t.last_timestamp) t.last_timestamp = ts;
    }

    const topics = [...byTopic.values()]
      .map((t) => ({
        topic: t.topic,
        chunks: t.chunks,
        platforms: Object.fromEntries(t.platforms),
        sources_count: t.sources.size,
        last_timestamp: t.last_timestamp,
      }))
      .sort((a, b) => b.last_timestamp - a.last_timestamp);

    res.json({
      ok: true,
      total_chunks: metas.length,
      total_topics: topics.length,
      topics,
    });
  } catch (err) {
    console.error('[stats]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/browse ─────────────────────────────────────────────────────────

app.get('/api/browse', async (req, res) => {
  try {
    const topic = req.query.topic;
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;

    const collection = await getCollection();
    const results = await collection.get({
      where: topic ? { topic: { $eq: topic } } : undefined,
      include: ['documents', 'metadatas'],
      limit: limit + offset,
    });

    const docs = results.documents ?? [];
    const metas = results.metadatas ?? [];
    const ids = results.ids ?? [];

    const items = docs
      .map((doc, i) => ({ id: ids[i], doc, meta: metas[i] }))
      .sort((a, b) => (b.meta?.timestamp ?? 0) - (a.meta?.timestamp ?? 0))
      .slice(offset, offset + limit);

    res.json({ ok: true, total: docs.length, items });
  } catch (err) {
    console.error('[browse]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET / — Dashboard HTML ──────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(DASHBOARD_HTML);
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true, timestamp: Date.now() }));

// ─── Dashboard HTML ──────────────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<title>OmniMem — Dashboard</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'><defs><radialGradient id='n' cx='.5' cy='.5' r='.5'><stop offset='0' stop-color='%237fd47f'/><stop offset='1' stop-color='%233d9a3d'/></radialGradient></defs><rect width='128' height='128' rx='28' fill='%231f1f1f'/><g stroke='%235dba5d' stroke-width='5' stroke-linecap='round' opacity='.85'><line x1='64' y1='64' x2='32' y2='34'/><line x1='64' y1='64' x2='100' y2='38'/><line x1='64' y1='64' x2='36' y2='98'/><line x1='64' y1='64' x2='98' y2='96'/></g><g fill='url(%23n)'><circle cx='32' cy='34' r='12'/><circle cx='100' cy='38' r='12'/><circle cx='36' cy='98' r='12'/><circle cx='98' cy='96' r='12'/></g><circle cx='64' cy='64' r='22' fill='url(%23n)'/><circle cx='64' cy='64' r='9' fill='%23eaffea' opacity='.85'/></svg>">
<style>
  :root {
    --bg: #141a16;
    --bg-soft: #0f1a14;
    --card: #1c2520;
    --card-2: #232d27;
    --border: #2a3530;
    --border-soft: #1f2a24;
    --text: #e6f0e8;
    --muted: #8a9a90;
    --accent: #5dba5d;
    --accent-hi: #7fd47f;
    --accent-lo: #3d9a3d;
    --info: #60b8f0;
    --info-bg: #1f3a4d;
    --err: #e07070;
    --err-bg: #2a1a1a;
  }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif;
         background: radial-gradient(ellipse at top, #1a2620 0%, var(--bg) 55%, var(--bg-soft) 100%);
         color: var(--text); margin: 0; padding: 24px; max-width: 1100px; margin: 0 auto;
         min-height: 100vh; }
  h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: 0.2px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
  .summary { display: flex; gap: 20px; margin-bottom: 24px; }
  .stat { background: linear-gradient(180deg, var(--card) 0%, var(--card-2) 100%);
          border: 1px solid var(--border); border-radius: 10px; padding: 14px 20px; flex: 1;
          box-shadow: 0 1px 0 rgba(127,212,127,0.04) inset; }
  .stat .v { font-size: 28px; font-weight: 600;
             background: linear-gradient(180deg, var(--accent-hi), var(--accent));
             -webkit-background-clip: text; background-clip: text; color: transparent; }
  .stat .l { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; }
  table { width: 100%; border-collapse: collapse; background: var(--card);
          border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border-soft); font-size: 13px; }
  th { background: var(--card-2); color: var(--muted); font-weight: 500; font-size: 11px;
       text-transform: uppercase; letter-spacing: 0.6px; }
  tr:last-child td { border-bottom: none; }
  tr.topic-row { cursor: pointer; transition: background 0.15s; }
  tr.topic-row:hover { background: rgba(93,186,93,0.07); }
  .badge { display: inline-block; background: #2a3530; color: #c5d4ca; border-radius: 4px;
           padding: 2px 7px; font-size: 11px; margin-right: 4px; }
  .platform-codebase { background: rgba(93,186,93,0.18); color: var(--accent-hi);
                       border: 1px solid rgba(93,186,93,0.3); }
  .platform-Manual { background: var(--info-bg); color: var(--info);
                     border: 1px solid rgba(96,184,240,0.25); }
  .browse { display: none; background: var(--bg-soft); padding: 14px 18px;
            border-top: 1px solid var(--border-soft); }
  .browse.open { display: block; }
  .chunk { background: var(--card-2); border-left: 3px solid var(--accent); padding: 8px 12px;
           margin: 6px 0; border-radius: 4px; font-size: 12px; }
  .chunk-meta { color: var(--muted); font-size: 10px; margin-bottom: 4px; }
  .chunk-text { white-space: pre-wrap; word-break: break-word; color: #cfd8d2;
                max-height: 200px; overflow: auto; }
  .err { color: var(--err); padding: 14px; background: var(--err-bg); border-radius: 6px;
         border: 1px solid rgba(224,112,112,0.25); }
  button.refresh { background: linear-gradient(180deg, var(--accent) 0%, var(--accent-lo) 100%);
                   color: #0f1a14; border: none; border-radius: 6px; padding: 6px 14px;
                   cursor: pointer; font-size: 12px; font-weight: 600;
                   box-shadow: 0 1px 0 rgba(127,212,127,0.3) inset, 0 1px 4px rgba(0,0,0,0.3); }
  button.refresh:hover { background: linear-gradient(180deg, var(--accent-hi) 0%, var(--accent) 100%); }
  a { color: var(--accent-hi); text-decoration: none; }
  a:hover { text-decoration: underline; color: #a3e8a3; }
  ::selection { background: rgba(93,186,93,0.35); color: #fff; }
</style>
</head>
<body>
<h1 style="display:flex;align-items:center;gap:10px">
<svg width="28" height="28" viewBox="0 0 128 128" aria-hidden="true">
  <defs><radialGradient id="hn" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#7fd47f"/><stop offset="1" stop-color="#3d9a3d"/></radialGradient></defs>
  <rect width="128" height="128" rx="28" fill="#1f1f1f"/>
  <g stroke="#5dba5d" stroke-width="5" stroke-linecap="round" opacity=".85">
    <line x1="64" y1="64" x2="32" y2="34"/><line x1="64" y1="64" x2="100" y2="38"/>
    <line x1="64" y1="64" x2="36" y2="98"/><line x1="64" y1="64" x2="98" y2="96"/>
  </g>
  <g fill="url(#hn)"><circle cx="32" cy="34" r="12"/><circle cx="100" cy="38" r="12"/><circle cx="36" cy="98" r="12"/><circle cx="98" cy="96" r="12"/></g>
  <circle cx="64" cy="64" r="22" fill="url(#hn)"/>
  <circle cx="64" cy="64" r="9" fill="#eaffea" opacity=".85"/>
</svg>
OmniMem Dashboard</h1>
<div class="sub">Riepilogo dei dati registrati su ChromaDB. <button class="refresh" onclick="loadStats()">↻ Aggiorna</button></div>
<div id="root">Caricamento…</div>

<script>
const $ = (id) => document.getElementById(id);
let openTopic = null;

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('it-IT');
}

function platformBadge(name, count) {
  const cls = name === 'codebase' ? 'platform-codebase'
            : name.startsWith('Manual') ? 'platform-Manual' : '';
  return \`<span class="badge \${cls}">\${name} ×\${count}</span>\`;
}

async function loadStats() {
  $('root').innerHTML = 'Caricamento…';
  try {
    const r = await fetch('/api/stats');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);

    const summary = \`
      <div class="summary">
        <div class="stat"><div class="v">\${data.total_chunks}</div><div class="l">Chunk totali</div></div>
        <div class="stat"><div class="v">\${data.total_topics}</div><div class="l">Argomenti</div></div>
      </div>\`;

    const rows = data.topics.map((t) => {
      const platforms = Object.entries(t.platforms)
        .sort((a, b) => b[1] - a[1])
        .map(([p, c]) => platformBadge(p, c)).join('');
      return \`
        <tr class="topic-row" data-topic="\${encodeURIComponent(t.topic)}" onclick="toggleBrowse('\${encodeURIComponent(t.topic)}')">
          <td><strong>\${t.topic}</strong></td>
          <td>\${t.chunks}</td>
          <td>\${platforms}</td>
          <td>\${t.sources_count}</td>
          <td>\${fmtDate(t.last_timestamp)}</td>
          <td><a href="/api/export/\${encodeURIComponent(t.topic)}" onclick="event.stopPropagation()">⬇ MD</a></td>
        </tr>
        <tr><td colspan="6" class="browse" id="browse-\${encodeURIComponent(t.topic)}"></td></tr>\`;
    }).join('');

    $('root').innerHTML = summary + (data.topics.length === 0
      ? '<p style="color:#888">Nessun dato registrato.</p>'
      : \`<table>
          <thead><tr><th>Argomento</th><th>Chunk</th><th>Piattaforme</th><th>Fonti</th><th>Ultimo aggiornamento</th><th></th></tr></thead>
          <tbody>\${rows}</tbody>
        </table>\`);
  } catch (err) {
    $('root').innerHTML = \`<div class="err">Errore: \${err.message}</div>\`;
  }
}

async function toggleBrowse(topicEnc) {
  const topic = decodeURIComponent(topicEnc);
  const cell = $(\`browse-\${topicEnc}\`);
  if (cell.classList.contains('open')) {
    cell.classList.remove('open');
    cell.innerHTML = '';
    return;
  }
  cell.classList.add('open');
  cell.innerHTML = '<em style="color:#888">Caricamento chunk…</em>';
  try {
    const r = await fetch(\`/api/browse?topic=\${topicEnc}&limit=20\`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    if (data.items.length === 0) { cell.innerHTML = '<em>Vuoto.</em>'; return; }

    cell.innerHTML = data.items.map((it) => {
      const m = it.meta ?? {};
      const src = m.source_url ? \`<a href="\${m.source_url}" target="_blank">\${m.source_url}</a>\` : '';
      return \`<div class="chunk">
        <div class="chunk-meta">[\${m.platform ?? '?'}] \${fmtDate(m.timestamp)} \${src}</div>
        <div class="chunk-text">\${escapeHtml(it.doc)}</div>
      </div>\`;
    }).join('') + (data.total > 20 ? \`<div style="color:#888;font-size:11px;margin-top:6px">Mostrati 20 di \${data.total}.</div>\` : '');
  } catch (err) {
    cell.innerHTML = \`<div class="err">Errore: \${err.message}</div>\`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

loadStats();
</script>
</body>
</html>`;

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`OmniMem server in ascolto su http://localhost:${PORT}`);
  console.log(`ChromaDB: http://localhost:8000`);
  console.log(`Ollama (${EMBED_MODEL}): ${OLLAMA_BASE}`);
});
