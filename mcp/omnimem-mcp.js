import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ChromaClient } from 'chromadb';
import { z } from 'zod';

const COLLECTION_NAME = 'omnimem';
const CHROMA_URL = process.env.CHROMA_URL ?? 'http://localhost:8000';

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
    'Accede alla memoria personale OmniMem (conversazioni AI salvate in ChromaDB).',
    'Senza topic: elenca i topic disponibili.',
    'Con topic: recupera tutti i chunk salvati per quel topic, ordinati per timestamp,',
    'e restituisce il testo grezzo strutturato pronto per essere sintetizzato in un briefing.',
    'Dopo aver ricevuto i chunk, genera tu stesso il briefing in italiano e salvalo in un file .md',
    'con sezioni: obiettivo, architettura tecnica, stato attuale, decisioni chiave, problemi risolti, TODO.',
  ].join(' '),
  {
    topic: z.string().optional().describe(
      'Topic da recuperare. Se omesso, mostra la lista dei topic disponibili.'
    ),
  },
  async ({ topic }) => {

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

    // ── Topic fornito → recupera chunk ───────────────────────────────────
    const results = await collection.get({
      where: { topic: { $eq: topic } },
      include: ['documents', 'metadatas'],
      limit: 2000,
    });

    const docs = results.documents ?? [];
    const metas = results.metadatas ?? [];

    if (docs.length === 0) {
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

    // ── Intestazione con istruzioni per Claude Code ───────────────────────
    const header = [
      `# OmniMem — Chunk recuperati per: "${topic}"`,
      `**Chunk totali:** ${docs.length} | **Piattaforme:** ${platforms.join(', ')}`,
      '',
      '> Sintetizza questi chunk in un briefing strutturato in italiano.',
      '> Sezioni richieste:',
      '> 1. Obiettivo e panoramica del progetto',
      '> 2. Architettura tecnica e scelte implementative',
      '> 3. Stato attuale (cosa è fatto, cosa manca)',
      '> 4. Decisioni chiave e motivazioni',
      '> 5. Problemi risolti (specialmente quelli non ovvi)',
      '> 6. TODO e cose aperte',
      '> ',
      `> Salva il risultato in \`${topic.replace(/[\s/\\:*?"<>|]/g, '_')}_briefing.md\``,
      '',
      '---',
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
