/**
 * Structured knowledge extractor: trasforma chunk di testo in entita',
 * relazioni e decisioni strutturate. Sostituibile e configurabile
 * (config.extractor.provider). Non genera mai Cypher: solo JSON validato.
 */
import { validateExtractionResult, validateEvidenceIntegrity, ENTITY_TYPES } from './schema.js';
import { RELATION_TYPES, DECISION_STATUSES } from '../schema.js';

const EMPTY_RESULT = Object.freeze({ entities: [], relations: [], decisions: [] });

export class KnowledgeExtractor {
  // eslint-disable-next-line no-unused-vars
  async extract(_chunks, _context) {
    throw new Error('extract() non implementato');
  }
}

/** Estrattore no-op: usato quando l'estrazione grafo e' disattivata. */
export class NullExtractor extends KnowledgeExtractor {
  async extract() {
    return { ok: true, data: EMPTY_RESULT };
  }
}

function buildPrompt(chunks, { entityTypes, relationTypes, decisionStatuses }) {
  const chunkList = chunks.map((c) => `- chunk_id="${c.id}": ${c.text.slice(0, 1200)}`).join('\n');
  return [
    'Estrai conoscenza strutturata dai chunk seguenti. Rispondi SOLO con un oggetto JSON valido,',
    'nessun testo prima o dopo, nessun blocco markdown, secondo esattamente questo schema:',
    '{',
    '  "entities": [{"temporary_id": "e1", "name": "...", "type": "<enum>", "aliases": ["..."]}],',
    '  "relations": [{"source": "...", "relationship": "<enum>", "target": "...", "description": "...", "confidence": 0.0-1.0, "evidence_chunk_id": "<uno dei chunk_id qui sotto>"}],',
    '  "decisions": [{"statement": "...", "status": "<enum>", "supersedes": "..."|null, "confidence": 0.0-1.0, "evidence_chunk_id": "<uno dei chunk_id qui sotto>"}]',
    '}',
    `Valori ammessi per "type" delle entita': ${entityTypes.join(', ')}.`,
    `Valori ammessi per "relationship": ${relationTypes.join(', ')}.`,
    `Valori ammessi per "status" delle decisioni: ${decisionStatuses.join(', ')}.`,
    'Usa SEMPRE come evidence_chunk_id uno dei chunk_id elencati sotto, mai un id inventato.',
    'Se non trovi nulla di strutturato, rispondi con array vuoti. Non inventare relazioni prive di riscontro nel testo.',
    '',
    'Chunk:',
    chunkList,
  ].join('\n');
}

function extractJsonBlock(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return candidate.slice(start, end + 1);
}

/**
 * Estrattore basato su Ollama locale (stesso host usato per gli embedding).
 * Richiede output JSON, valida rigorosamente, ritenta un numero limitato di
 * volte, non salva mai risultati parziali.
 */
export class OllamaExtractor extends KnowledgeExtractor {
  constructor({ baseUrl, model, maxRetries = 1, timeoutMs = 30000, entityTypes, relationTypes, decisionStatuses, logger = console }) {
    super();
    this.baseUrl = baseUrl;
    this.model = model;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this.entityTypes = entityTypes;
    this.relationTypes = relationTypes;
    this.decisionStatuses = decisionStatuses;
    this.logger = logger;
  }

  async callModel(prompt) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          prompt,
          format: 'json',
          stream: false,
          options: { temperature: 0 },
        }),
      });
      if (!res.ok) throw new Error(`Ollama extractor error: ${res.status}`);
      const body = await res.json();
      return body.response ?? '';
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * @param {{id: string, text: string}[]} chunks
   * @param {{namespace: string}} context
   */
  async extract(chunks, context = {}) {
    if (!chunks || chunks.length === 0) return { ok: true, data: EMPTY_RESULT };
    const knownChunkIds = chunks.map((c) => c.id);
    const prompt = buildPrompt(chunks, {
      entityTypes: this.entityTypes,
      relationTypes: this.relationTypes,
      decisionStatuses: this.decisionStatuses,
    });

    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const raw = await this.callModel(prompt);
        const jsonBlock = extractJsonBlock(raw);
        if (!jsonBlock) {
          lastError = new Error('Nessun blocco JSON individuabile nella risposta del modello');
          continue;
        }
        let parsedJson;
        try {
          parsedJson = JSON.parse(jsonBlock);
        } catch (err) {
          lastError = new Error(`JSON malformato dal modello: ${err.message}`);
          continue;
        }
        const validation = validateExtractionResult(parsedJson);
        if (!validation.ok) {
          lastError = new Error(`Output estrattore non conforme allo schema: ${validation.error.message}`);
          continue;
        }
        const evidenceCheck = validateEvidenceIntegrity(validation.data, knownChunkIds);
        if (!evidenceCheck.ok) {
          lastError = evidenceCheck.error;
          continue;
        }
        return { ok: true, data: validation.data };
      } catch (err) {
        lastError = err;
      }
    }

    this.logger.error(
      `[graph-extractor] estrazione fallita per namespace=${context.namespace ?? '?'} dopo ${this.maxRetries + 1} tentativi: ${lastError?.message}`
    );
    return { ok: false, error: lastError ?? new Error('estrazione fallita') };
  }
}

export function createExtractor(cfg) {
  if (cfg.extractor.provider === 'none') return new NullExtractor();
  if (cfg.extractor.provider === 'ollama') {
    return new OllamaExtractor({
      baseUrl: cfg.ollamaBaseUrl ?? process.env.OLLAMA_BASE ?? 'http://localhost:11434',
      model: cfg.extractor.model,
      maxRetries: cfg.extractor.maxRetries,
      timeoutMs: cfg.extractor.timeoutMs,
      entityTypes: ENTITY_TYPES,
      relationTypes: RELATION_TYPES,
      decisionStatuses: DECISION_STATUSES,
    });
  }
  throw new Error(`Provider estrattore sconosciuto: ${cfg.extractor.provider}`);
}
