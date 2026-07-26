/**
 * Client ChromaDB condiviso. Estratto da server.js cosi' che sia il server
 * HTTP sia la CLI di backfill grafo usino la stessa identica collection,
 * senza duplicare la configurazione.
 */
import { ChromaClient } from 'chromadb';

export const COLLECTION_NAME = 'omnimem';
export const CHROMA_URL = process.env.CHROMA_URL ?? 'http://localhost:8000';

const chroma = new ChromaClient({ path: CHROMA_URL });

export async function getCollection() {
  return chroma.getOrCreateCollection({
    name: COLLECTION_NAME,
    metadata: { 'hnsw:space': 'cosine' },
  });
}
