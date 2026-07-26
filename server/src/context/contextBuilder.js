/**
 * Context builder: trasforma il risultato del retriever ibrido in un
 * contesto strutturato per il modello, con sezioni distinte (fatti attuali,
 * decisioni attive/superate, entita' correlate, dipendenze, contraddizioni,
 * evidence, fonti), provenienza esplicita e rispetto del token budget.
 *
 * Limite noto: la provenienza (source_url/platform) di un chunk trovato
 * SOLO tramite espansione grafo (non anche dal vettoriale) e' incompleta
 * in questa prima versione, perche' il nodo Chunk nel grafo non porta con
 * se' i metadati della Memory a cui appartiene se non viene esplicitamente
 * risolta con un hop aggiuntivo verso CHUNK_OF -> Memory. Documentato in
 * docs/graph-rag-architecture.md come estensione futura.
 */

function estimateTokens(text, charsPerToken) {
  return Math.ceil((text ?? '').length / charsPerToken);
}

function buildProvenance(result) {
  return {
    chunk_id: result.id,
    source_url: result.metadata?.source_url ?? null,
    platform: result.metadata?.platform ?? null,
    timestamp: result.metadata?.timestamp ?? null,
  };
}

function findNode(nodes, id) {
  return nodes.find((n) => n.id === id) ?? null;
}

/**
 * @param {{query:string, namespace:string, retrieval:object}} input retrieval = output di hybridRetrieve
 * @param {{tokenBudget:number, charsPerToken:number}} config
 */
export function buildContext({ query, namespace, retrieval }, config) {
  const budgetChars = config.tokenBudget * config.charsPerToken;
  let usedChars = 0;
  const renderedChunkIds = new Set();
  const sourcesByUrl = new Map();

  const sections = {
    currentFacts: [],
    activeDecisions: [],
    historicalDecisions: [],
    relatedEntities: [],
    dependencies: [],
    contradictions: [],
    evidence: [],
    sources: [],
  };

  const nodes = retrieval.nodes ?? [];
  const edges = retrieval.edges ?? [];
  const decisions = retrieval.decisions ?? [];
  const budgetExceeded = { value: false };

  function tryAdd(list, item, textForBudgetEstimate) {
    const cost = (textForBudgetEstimate ?? '').length;
    if (usedChars + cost > budgetChars) {
      budgetExceeded.value = true;
      return false;
    }
    usedChars += cost;
    list.push(item);
    return true;
  }

  // ── 1. Decisioni attive (priorita' massima: mai presentare una decisione
  //       superata come se fosse quella corrente) ──────────────────────────
  for (const d of decisions.filter((d) => d.status === 'active')) {
    tryAdd(
      sections.activeDecisions,
      { statement: d.name, confidence: d.confidence ?? null, evidenceChunkId: d.metadata?.evidence_chunk_id ?? null },
      d.name
    );
  }

  // ── 2. Decisioni storiche/superate/rifiutate, mai spacciate per correnti ──
  for (const d of decisions.filter((d) => d.status !== 'active')) {
    const supersedingEdge = edges.find((e) => e.type === 'SUPERSEDES' && e.toId === d.id);
    const supersedingNode = supersedingEdge ? findNode(nodes, supersedingEdge.fromId) : null;
    tryAdd(
      sections.historicalDecisions,
      {
        statement: d.name,
        status: d.status,
        supersededBy: supersedingNode?.name ?? null,
        isStub: Boolean(d.metadata?.stub),
      },
      d.name
    );
  }

  // ── 3. Contraddizioni: esplicitate, non risolte automaticamente per data ──
  for (const c of retrieval.contradictions ?? []) {
    const a = findNode(nodes, c.fromId);
    const b = findNode(nodes, c.toId);
    const label = `${a?.name ?? c.fromId} vs ${b?.name ?? c.toId}`;
    tryAdd(sections.contradictions, { a: a?.name ?? c.fromId, b: b?.name ?? c.toId, resolved: false }, label);
  }

  // ── 4. Fatti attuali: i chunk piu' rilevanti (gia' deduplicati a monte) ──
  for (const r of retrieval.results ?? []) {
    if (renderedChunkIds.has(r.id)) continue; // mai lo stesso chunk due volte
    const added = tryAdd(sections.currentFacts, { id: r.id, text: r.text, score: r.score, provenance: buildProvenance(r) }, r.text);
    if (!added) continue;
    renderedChunkIds.add(r.id);
    sections.evidence.push({ chunk_id: r.id, provenance: buildProvenance(r) });
    const sourceUrl = r.metadata?.source_url;
    if (sourceUrl && !sourcesByUrl.has(sourceUrl)) {
      sourcesByUrl.set(sourceUrl, { source_url: sourceUrl, platform: r.metadata?.platform ?? null });
    }
  }

  // ── 5. Entita' correlate ──────────────────────────────────────────────────
  for (const e of retrieval.entities ?? []) {
    tryAdd(sections.relatedEntities, { name: e.name, type: e.type, aliases: e.aliases ?? [] }, e.name);
  }

  // ── 6. Dipendenze (DEPENDS_ON / BLOCKED_BY) ───────────────────────────────
  for (const edge of edges.filter((e) => e.type === 'DEPENDS_ON' || e.type === 'BLOCKED_BY')) {
    const from = findNode(nodes, edge.fromId);
    const to = findNode(nodes, edge.toId);
    const label = `${from?.name ?? edge.fromId} ${edge.type} ${to?.name ?? edge.toId}`;
    tryAdd(sections.dependencies, { from: from?.name ?? edge.fromId, type: edge.type, to: to?.name ?? edge.toId, confidence: edge.confidence ?? null }, label);
  }

  sections.sources = [...sourcesByUrl.values()];

  return {
    query,
    namespace,
    category: retrieval.category,
    usedGraph: retrieval.usedGraph,
    fallbackToVector: retrieval.fallbackToVector,
    tokenBudget: config.tokenBudget,
    estimatedTokensUsed: estimateTokens('x'.repeat(usedChars), config.charsPerToken),
    truncatedByBudget: budgetExceeded.value,
    sections,
  };
}

/** Serializza il contesto in markdown pronto per essere iniettato nel prompt. */
export function renderContextMarkdown(context) {
  const lines = [`# Contesto OmniMem (namespace: ${context.namespace}, categoria: ${context.category})`];
  if (context.fallbackToVector) lines.push('_Nota: retrieval grafo non disponibile in questa risposta, fallback al solo vettoriale._');

  if (context.sections.activeDecisions.length) {
    lines.push('\n## Decisioni attive');
    for (const d of context.sections.activeDecisions) lines.push(`- ${d.statement} (confidence: ${d.confidence ?? 'n/d'})`);
  }
  if (context.sections.historicalDecisions.length) {
    lines.push('\n## Decisioni storiche o superate (NON correnti)');
    for (const d of context.sections.historicalDecisions) {
      const supersededNote = d.supersededBy ? ` — sostituita da: ${d.supersededBy}` : '';
      lines.push(`- [${d.status}] ${d.statement}${supersededNote}`);
    }
  }
  if (context.sections.contradictions.length) {
    lines.push('\n## Contraddizioni rilevate (non risolte automaticamente)');
    for (const c of context.sections.contradictions) lines.push(`- ${c.a} vs ${c.b}`);
  }
  if (context.sections.currentFacts.length) {
    lines.push('\n## Fatti rilevanti');
    context.sections.currentFacts.forEach((f, i) => {
      lines.push(`[${i + 1}] (score ${f.score?.toFixed?.(2) ?? f.score}) ${f.text}`);
    });
  }
  if (context.sections.relatedEntities.length) {
    lines.push('\n## Entita correlate');
    for (const e of context.sections.relatedEntities) lines.push(`- ${e.name} (${e.type})`);
  }
  if (context.sections.dependencies.length) {
    lines.push('\n## Dipendenze');
    for (const d of context.sections.dependencies) lines.push(`- ${d.from} --${d.type}--> ${d.to}`);
  }
  if (context.sections.sources.length) {
    lines.push('\n## Fonti');
    for (const s of context.sections.sources) lines.push(`- ${s.source_url} (${s.platform ?? 'sconosciuta'})`);
  }
  return lines.join('\n');
}
