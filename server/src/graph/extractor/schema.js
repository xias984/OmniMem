/**
 * Schema di validazione per l'output dello structured knowledge extractor.
 * Il modello (LLM) produce SOLO questo JSON: nessuna query Cypher viene mai
 * generata a runtime dal modello. Il codice applicativo costruisce le query
 * a partire da questi dati validati.
 */
import { z } from 'zod';
import { RELATION_TYPES, DECISION_STATUSES } from '../schema.js';

export const ENTITY_TYPES = Object.freeze([
  'technology',
  'tool',
  'project',
  'task',
  'file',
  'session',
  'source',
  'person',
  'organization',
  'concept',
  'other',
]);

const confidenceSchema = z.number().min(0).max(1);

const entitySchema = z.object({
  temporary_id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(ENTITY_TYPES),
  aliases: z.array(z.string().min(1)).max(20).default([]),
});

const relationSchema = z.object({
  source: z.string().min(1),
  relationship: z.enum(RELATION_TYPES),
  target: z.string().min(1),
  description: z.string().max(2000).optional().default(''),
  confidence: confidenceSchema,
  evidence_chunk_id: z.string().min(1),
});

const decisionSchema = z.object({
  statement: z.string().min(1),
  status: z.enum(DECISION_STATUSES),
  supersedes: z.string().optional().nullable(),
  confidence: confidenceSchema,
  evidence_chunk_id: z.string().min(1),
});

export const extractionResultSchema = z.object({
  entities: z.array(entitySchema).max(100).default([]),
  relations: z.array(relationSchema).max(200).default([]),
  decisions: z.array(decisionSchema).max(50).default([]),
});

/**
 * Valida l'output grezzo dell'estrattore. Ritorna { ok, data } o
 * { ok: false, error } — non lancia mai, cosi' il chiamante puo' loggare
 * e scartare senza salvataggi parziali.
 */
export function validateExtractionResult(raw) {
  const parsed = extractionResultSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Verifica aggiuntiva (oltre allo schema): ogni evidence_chunk_id citato in
 * relazioni/decisioni deve corrispondere a un chunk realmente passato
 * all'estrattore in questa chiamata. Evita che il modello "inventi" id di
 * chunk inesistenti come falsa evidenza.
 */
export function validateEvidenceIntegrity(data, knownChunkIds) {
  const known = new Set(knownChunkIds);
  const badRelations = data.relations.filter((r) => !known.has(r.evidence_chunk_id));
  const badDecisions = data.decisions.filter((d) => !known.has(d.evidence_chunk_id));
  if (badRelations.length > 0 || badDecisions.length > 0) {
    return {
      ok: false,
      error: new Error(
        `evidence_chunk_id non riconosciuti: relazioni=${badRelations.length}, decisioni=${badDecisions.length}`
      ),
    };
  }
  return { ok: true };
}
