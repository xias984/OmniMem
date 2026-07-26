import { normalizeName } from '../../src/ids.js';

/**
 * Doppio di test per GraphRepository: stessa interfaccia pubblica, stato in
 * memoria. Riproduce la semantica reale (merge idempotente di nodi/relazioni,
 * ricerca per alias/tipo) senza richiedere un'istanza Neo4j.
 */
export class InMemoryGraphRepo {
  constructor() {
    this.nodes = new Map(); // key: namespace::label::id -> props
    this.relations = new Map(); // key: namespace::fromId::type::toId -> props
  }

  key(namespace, label, id) {
    return `${namespace}::${label}::${id}`;
  }

  async upsertNode(label, props) {
    const key = this.key(props.namespace, label, props.id);
    const existing = this.nodes.get(key) ?? {};
    const merged = {
      ...existing,
      ...props,
      name_normalized: props.name ? normalizeName(props.name) : existing.name_normalized,
      __label: label,
    };
    this.nodes.set(key, merged);
    return { ok: true, node: merged };
  }

  async upsertRelation({ fromLabel, fromId, toLabel, toId, type, namespace, confidence, sourceChunkIds, extractorVersion, metadata }) {
    if (!sourceChunkIds || sourceChunkIds.length === 0) {
      return { ok: false, error: new Error('relazione senza evidenza rifiutata') };
    }
    const relKey = `${namespace}::${fromId}::${type}::${toId}`;
    const existing = this.relations.get(relKey);
    const merged = {
      fromLabel, fromId, toLabel, toId, type, namespace,
      confidence: Math.max(existing?.confidence ?? 0, confidence ?? 0),
      source_chunk_ids: Array.from(new Set([...(existing?.source_chunk_ids ?? []), ...sourceChunkIds])),
      extractor_version: extractorVersion,
      metadata: metadata ?? existing?.metadata ?? {},
    };
    this.relations.set(relKey, merged);
    return { ok: true, relation: merged };
  }

  async findEntity(namespace, id, label = 'Entity') {
    return this.nodes.get(this.key(namespace, label, id)) ?? null;
  }

  async findEntitiesByAlias(namespace, alias, { label = 'Entity' } = {}) {
    const normalized = normalizeName(alias);
    const out = [];
    for (const [key, node] of this.nodes) {
      if (!key.startsWith(`${namespace}::${label}::`)) continue;
      if (node.name_normalized === normalized || (node.aliases ?? []).map(normalizeName).includes(normalized)) {
        out.push(node);
      }
    }
    return out;
  }

  async findEntitiesByType(namespace, entityType, { label = 'Entity' } = {}) {
    const out = [];
    for (const [key, node] of this.nodes) {
      if (!key.startsWith(`${namespace}::${label}::`)) continue;
      if (node.type === entityType) out.push(node);
    }
    return out;
  }

  async findChunksByEntity(namespace, entityId) {
    const chunkIds = [];
    for (const rel of this.relations.values()) {
      if (rel.namespace === namespace && rel.type === 'MENTIONS' && rel.toId === entityId) chunkIds.push(rel.fromId);
    }
    return chunkIds.map((id) => this.nodes.get(this.key(namespace, 'Chunk', id))).filter(Boolean);
  }

  async findActiveDecisions(namespace) {
    return [...this.nodes.values()].filter((n) => n.__label === 'Decision' && n.namespace === namespace && n.status === 'active');
  }

  async findSupersededDecisions(namespace) {
    return [...this.nodes.values()].filter((n) => n.__label === 'Decision' && n.namespace === namespace && n.status === 'superseded');
  }

  async findContradictions(namespace) {
    return [...this.relations.values()].filter((r) => r.namespace === namespace && r.type === 'CONTRADICTS');
  }

  async healthCheck() {
    return { healthy: true, latencyMs: 0 };
  }
}
