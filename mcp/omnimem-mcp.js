import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ChromaClient } from 'chromadb';
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const COLLECTION_NAME = 'omnimem';
const CHROMA_URL = process.env.CHROMA_URL ?? 'http://localhost:8000';
const CURSOR_FILE = join(dirname(fileURLToPath(import.meta.url)), '.omnimem-cursors.json');

// Pattern Karpathy — LLM Wiki (https://karpathy.bearblog.dev/llm-wiki/)
// Include nei header solo alla PRIMA chiamata su un topic, per istruire
// l'agente a inizializzare la struttura wiki nella CWD.
const KARPATHY_PROMPT = `LLM Wiki
A pattern for building personal knowledge bases using LLMs.

The core idea
Most people's experience with LLMs and documents looks like RAG: you upload a collection of files, the LLM retrieves relevant chunks at query time, and generates an answer. This works, but the LLM is rediscovering knowledge from scratch on every question. There's no accumulation.

The idea here is different. Instead of just retrieving from raw documents at query time, the LLM incrementally builds and maintains a persistent wiki — a structured, interlinked collection of markdown files that sits between you and the raw sources. When you add a new source, the LLM doesn't just index it for later retrieval. It reads it, extracts the key information, and integrates it into the existing wiki — updating entity pages, revising topic summaries, noting where new data contradicts old claims, strengthening or challenging the evolving synthesis. The knowledge is compiled once and then kept current, not re-derived on every query.

Architecture — three layers
1. Raw sources — your curated collection of source documents. Immutable; the LLM reads from them but never modifies them.
2. The wiki — a directory of LLM-generated markdown files: summaries, entity pages, concept pages, comparisons, an overview, a synthesis. The LLM owns this layer entirely.
3. The schema (CLAUDE.md) — tells the LLM how the wiki is structured, what the conventions are, and what workflows to follow when ingesting sources, answering questions, or maintaining the wiki.

Operations
- Ingest. Read the source, extract key info, write a summary page, update the index, update relevant entity and concept pages, append an entry to the log. A single source might touch 10-15 wiki pages.
- Query. Search relevant pages, read them, synthesize an answer with citations. Good answers can be filed back into the wiki.
- Lint. Periodically check for contradictions between pages, stale claims, orphan pages, missing cross-references, data gaps.

Indexing and logging
- index.md — content-oriented catalog of every page with link + one-line summary, organized by category (entities, concepts, sources). Updated on every ingest.
- log.md — chronological append-only record. Each entry starts with "## [YYYY-MM-DD] ingest|query|lint | <title>" so it's grep-able.

Why this works
The tedious part of maintaining a knowledge base is not the reading or the thinking — it's the bookkeeping. LLMs don't get bored, don't forget to update a cross-reference, and can touch 15 files in one pass. The wiki stays maintained because the cost of maintenance is near zero.`;

async function loadCursors() {
  try {
    return JSON.parse(await readFile(CURSOR_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function saveCursor(topic, ts) {
  const cursors = await loadCursors();
  cursors[topic] = ts;
  await writeFile(CURSOR_FILE, JSON.stringify(cursors, null, 2), 'utf8');
}

const server = new McpServer({ name: 'omnimem', version: '1.0.0' });

async function getCollection() {
  const chroma = new ChromaClient({ path: CHROMA_URL });
  return chroma.getOrCreateCollection({
    name: COLLECTION_NAME,
    metadata: { 'hnsw:space': 'cosine' },
  });
}

// ─── Tool: omnimem ────────────────────────────────────────────────────────────

server.tool(
  'omnimem',
  [
    'Accede alla memoria personale OmniMem (conversazioni AI salvate in ChromaDB) e istruisce',
    'l\'agente a costruire/aggiornare una LLM Wiki (pattern Karpathy) nella directory corrente.',
    'Senza topic: elenca i topic disponibili.',
    'Con topic, prima chiamata: restituisce TUTTI i chunk + istruzioni per inizializzare la wiki',
    '(cartella <topic>_Wiki/ con CLAUDE.md, Index.md, log.md, pagine per entità/concetti).',
    'Con topic, chiamate successive: restituisce SOLO i chunk nuovi (cursore automatico) +',
    'istruzioni per integrarli nella wiki esistente in modo additivo.',
    'Passa full=true per ignorare il cursore.',
  ].join(' '),
  {
    topic: z.string().optional().describe(
      'Topic da recuperare. Se omesso, mostra la lista dei topic disponibili.'
    ),
    full: z.boolean().optional().describe(
      'Se true ignora il cursore e restituisce tutti i chunk del topic. Default: false (incrementale).'
    ),
  },
  async ({ topic, full = false }) => {

    // ── Connessione ChromaDB ──────────────────────────────────────────────
    let collection;
    try {
      collection = await getCollection();
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `Errore ChromaDB: ${err.message}\nAssicurati che ChromaDB sia attivo su ${CHROMA_URL}`,
        }],
      };
    }

    // ── Nessun topic → lista ──────────────────────────────────────────────
    if (!topic) {
      const results = await collection.get({ include: ['metadatas'], limit: 5000 });
      const topics = [
        ...new Set((results.metadatas ?? []).map((m) => m?.topic).filter(Boolean)),
      ].sort();

      if (topics.length === 0) {
        return {
          content: [{
            type: 'text',
            text: "Nessun topic in memoria. Registra prima alcune chat con l'estensione OmniMem.",
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: [
            '## Topic disponibili in OmniMem',
            '',
            ...topics.map((t, i) => `${i + 1}. **${t}**`),
            '',
            'Quale topic vuoi sintetizzare in un briefing?',
          ].join('\n'),
        }],
      };
    }

    // ── Topic fornito → recupera chunk (con cursore incrementale) ────────
    const cursors = await loadCursors();
    const cursor = full ? null : (cursors[topic] ?? null);

    const where = cursor
      ? { $and: [{ topic: { $eq: topic } }, { timestamp: { $gt: cursor } }] }
      : { topic: { $eq: topic } };

    const results = await collection.get({
      where,
      include: ['documents', 'metadatas'],
      limit: 2000,
    });

    const docs = results.documents ?? [];
    const metas = results.metadatas ?? [];

    if (docs.length === 0) {
      if (cursor) {
        const cursorIso = new Date(cursor).toLocaleString('it-IT');
        return {
          content: [{
            type: 'text',
            text: `Nessun nuovo chunk per "${topic}" dopo ${cursorIso}.\n` +
                  `Per recuperare tutto da capo richiama con full=true.`,
          }],
        };
      }
      const allResults = await collection.get({ include: ['metadatas'], limit: 5000 });
      const allTopics = [
        ...new Set((allResults.metadatas ?? []).map((m) => m?.topic).filter(Boolean)),
      ].sort();
      const similar = allTopics.filter(
        (t) =>
          t.toLowerCase().includes(topic.toLowerCase()) ||
          topic.toLowerCase().includes(t.toLowerCase())
      );
      let msg = `Nessun documento per topic: "${topic}"`;
      if (similar.length) msg += `\nTopic simili: ${similar.map((t) => `**${t}**`).join(', ')}`;
      else if (allTopics.length) msg += `\nTopic disponibili: ${allTopics.map((t) => `**${t}**`).join(', ')}`;
      return { content: [{ type: 'text', text: msg }] };
    }

    // ── Ordina per timestamp ──────────────────────────────────────────────
    const entries = docs
      .map((doc, i) => ({ doc, meta: metas[i] }))
      .sort((a, b) => (a.meta?.timestamp ?? 0) - (b.meta?.timestamp ?? 0));

    const platforms = [...new Set(metas.map((m) => m?.platform).filter(Boolean))];

    // ── Aggiorna cursore al massimo timestamp visto ───────────────────────
    const maxTs = Math.max(...metas.map((m) => m?.timestamp ?? 0));
    if (maxTs > 0) await saveCursor(topic, maxTs);

    // ── Intestazione con istruzioni per Claude Code ───────────────────────
    const cursorLine = cursor
      ? `**Modalità:** incrementale (chunk dopo ${new Date(cursor).toLocaleString('it-IT')})`
      : full
        ? '**Modalità:** full (cursore ignorato)'
        : '**Modalità:** prima chiamata (tutti i chunk, cursore inizializzato)';

    const safeTopic = topic.replace(/[\s/\\:*?"<>|]/g, '_');
    const isFirstCall = !cursor;

    // Istruzioni operative differenziate: inizializzazione vs aggiornamento.
    const wikiInstructions = isFirstCall
      ? [
          '## Istruzioni per Claude Code',
          '',
          'Sei chiamato a costruire una **LLM Wiki** secondo il pattern di Andrej Karpathy',
          `(persistente, interlinkata, in markdown) per il topic **"${topic}"** nella **directory di lavoro corrente**.`,
          '',
          '### Pattern Karpathy (riferimento)',
          '',
          KARPATHY_PROMPT,
          '',
          '### Cosa fare adesso',
          '',
          `1. Crea (se non esiste) una sottocartella \`${safeTopic}_Wiki/\` nella CWD.`,
          '2. Dentro quella cartella inizializza:',
          `   - \`CLAUDE.md\` — schema della wiki: convenzioni di naming, formato delle pagine, workflow per ingest/query/lint. Spiega come aggiornare le pagine quando arrivano nuovi chunk OmniMem.`,
          `   - \`Index.md\` — catalogo di tutte le pagine, raggruppate per categoria (entità, concetti, sintesi). Aggiornato a ogni ingest.`,
          `   - \`log.md\` — log cronologico append-only. Ogni voce inizia con \`## [YYYY-MM-DD] ingest | <descrizione>\` per essere grep-abile.`,
          `   - Una pagina di overview \`${safeTopic}.md\` che riassume il topic e linka le pagine figlie.`,
          '3. Leggi i chunk qui sotto. Estrai entità, concetti, decisioni, problemi risolti, TODO. Crea una pagina markdown per ognuno (es. `Architettura.md`, `Personaggi.md`, `Economia.md`...) e interlinka via `[[Nome_Pagina]]`.',
          '4. Aggiorna `Index.md` e appendi una voce a `log.md` con data odierna e numero di chunk processati.',
          '5. Tutte le pagine in italiano. Citazioni verbatim solo dove il "sapore" originale aggiunge valore.',
        ].join('\n')
      : [
          '## Istruzioni per Claude Code (modalità incrementale)',
          '',
          `Esiste già una LLM Wiki per il topic **"${topic}"** (probabile cartella: \`${safeTopic}_Wiki/\` nella CWD, ma verifica anche eventuali wiki preesistenti come \`Cervello_Digitale/${topic}/Wiki/\`).`,
          'Qui sotto trovi SOLO i chunk arrivati dopo l\'ultima sincronizzazione.',
          '',
          '### Cosa fare',
          '',
          '1. Individua la cartella Wiki esistente per il topic. Leggi `CLAUDE.md`, `Index.md` e `log.md` per capire convenzioni e stato.',
          '2. Per ogni nuovo chunk: decidi se aggiorna una pagina esistente, ne crea una nuova, o flagga una contraddizione con quanto già scritto.',
          '3. Tocca solo le pagine impattate. Se una nuova entità/concetto emerge, crea la pagina e linkala dall\'Index.',
          '4. Appendi a `log.md` una voce `## [YYYY-MM-DD] ingest | +${docs.length} chunk` con sommario delle pagine modificate.',
          '5. Mai riscrivere da zero pagine già stabili — integra in modo additivo, segnala revisioni.',
        ].join('\n');

    const header = [
      `# OmniMem — Chunk recuperati per: "${topic}"`,
      `**Chunk totali:** ${docs.length} | **Piattaforme:** ${platforms.join(', ')}`,
      cursorLine,
      '',
      wikiInstructions,
      '',
      '---',
      '',
      `## Chunk grezzi (${docs.length})`,
      '',
    ].join('\n');

    const body = entries
      .map(({ doc, meta }) => {
        const ts = meta?.timestamp
          ? new Date(meta.timestamp).toLocaleString('it-IT')
          : '?';
        return `### [${meta?.platform ?? 'unknown'}] — ${ts}\n\n${doc}`;
      })
      .join('\n\n---\n\n');

    return { content: [{ type: 'text', text: header + body }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
