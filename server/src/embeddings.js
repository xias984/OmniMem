/**
 * Client di embedding Ollama condiviso (estratto da server.js). Usato dal
 * retrieval vettoriale esistente, e riusato dall'entity resolver per il
 * confronto semantico nella fascia ambigua del matching fuzzy.
 */
export const OLLAMA_BASE = process.env.OLLAMA_BASE ?? 'http://localhost:11434';
export const EMBED_MODEL = process.env.EMBED_MODEL ?? 'nomic-embed-text';

export async function embed(texts) {
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

/** Comodo per l'uso singolo-testo (entity resolver, router...): ritorna un solo vettore. */
export async function embedOne(text) {
  const [vector] = await embed(text);
  return vector;
}
