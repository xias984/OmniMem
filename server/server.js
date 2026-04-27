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

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true, timestamp: Date.now() }));

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`OmniMem server in ascolto su http://localhost:${PORT}`);
  console.log(`ChromaDB: http://localhost:8000`);
  console.log(`Ollama (${EMBED_MODEL}): ${OLLAMA_BASE}`);
});
