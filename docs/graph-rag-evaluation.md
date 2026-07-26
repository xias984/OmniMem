# OmniMem — Valutazione RAG vettoriale vs Hybrid GraphRAG

## Obiettivo

Confrontare, su un piccolo set di domande rappresentative, cosa recupera il
RAG vettoriale esistente rispetto al retrieval ibrido, per verificare che
l'ibrido migliori (o almeno non peggiori) su query relazionali, causali,
temporali, di dipendenza, decisionali e di contraddizione — mantenendo
invariata la qualità sulle query puramente semantiche.

## Dataset

[`graph-rag-eval-dataset.json`](graph-rag-eval-dataset.json): scenario
"Hearthfall" (coerente con l'esempio guida del task) con 4 memorie seed e 8
query, una per ogni categoria del router (`semantic` incluso implicitamente
da `q1`, `causal`, `decision`, `dependency`, `contradiction`). Per ogni
query il dataset registra:

- `expected_chunks`: id delle memorie seed che devono comparire tra i fatti
  rilevanti;
- `expected_entities` / `expected_relations`: cosa il grafo dovrebbe aver
  estratto ed essere in grado di esporre;
- `expected_active_decision`: quale decisione, se esiste, deve risultare
  **attiva** (mai una superata);
- `must_exclude`: comportamenti scorretti che il context builder non deve
  produrre (es. presentare una decisione superata come corrente, o
  risolvere una contraddizione solo per data/confidence).

## Come eseguire il confronto

1. Avvia Neo4j e ChromaDB, imposta `OMNIMEM_GRAPH_INDEXING_ENABLED=true`
   (vedi `graph-rag-operations.md`).
2. Indicizza le `seed_memories` del dataset con `POST /api/record` (una
   chiamata per memoria, `topic: "Hearthfall"`), oppure incollale a mano
   nell'estensione con Rec.
3. Attendi che il dual write le indicizzi nel grafo (pochi secondi;
   verifica con `GET /api/graph/metrics` che `entities_extracted`/
   `relations_extracted` siano cresciuti).
4. Per ciascuna `query` del dataset, chiama due volte `POST /api/query`:
   - una con `OMNIMEM_GRAPHRAG_ENABLED=false` (baseline vettoriale);
   - una con `OMNIMEM_GRAPHRAG_ENABLED=true` (ibrido).
5. Confronta manualmente (o con uno script, vedi sotto) `chunks`/`context`
   ottenuti contro `expected_*` e `must_exclude`.

In alternativa, con `OMNIMEM_GRAPH_SHADOW_MODE=true` **senza** disattivare
il vettoriale, ogni query in produzione logga già il confronto
(`vector_chunks` vs `hybrid_chunks`, categoria, strategia, fallback) — utile
per un confronto continuo su query reali oltre al dataset fisso.

## Criteri di successo per categoria

| Categoria | Cosa il vettoriale puro tipicamente manca | Cosa l'ibrido deve aggiungere |
|---|---|---|
| `causal` (q2) | Il "perché" richiede collegare la decisione vecchia a quella nuova, non solo un chunk simile | `SUPERSEDES` esplicito tra le due decisioni, entrambe citate |
| `decision` (q3, q7, q8) | Nessuna nozione di stato (attiva/superata) nel RAG puro | Sezione `activeDecisions` vs `historicalDecisions` distinte, mai una superata spacciata per corrente |
| `dependency` (q4, q5) | Nessuna relazione esplicita di blocco tra task | Sezione `dependencies` con `BLOCKED_BY`/`DEPENDS_ON` risolte per nome |
| `contradiction` (q6) | Il vettoriale restituisce entrambi i chunk mescolati, senza segnalare il conflitto | Sezione `contradictions` esplicita, nessuna risoluzione automatica per data |

## Metriche quantitative suggerite (manuali o scriptabili)

- **Recall sui chunk attesi**: quota di `expected_chunks` presente nel
  risultato (per entrambe le modalità).
- **Precisione sulle decisioni**: la decisione riportata come "attiva" nel
  contesto combacia con `expected_active_decision`? (0/1 per query).
- **Violazioni di `must_exclude`**: conteggio di comportamenti scorretti
  osservati nella risposta.
- **Latenza aggiuntiva**: `hybrid_retrieval_duration` da
  `GET /api/graph/metrics` rispetto a `vector_retrieval_duration` — per
  valutare il costo dell'ibrido rispetto al beneficio.

Questo documento descrive la metodologia e fornisce il dataset; l'esecuzione
end-to-end richiede Neo4j e Ollama attivi (non disponibili nell'ambiente in
cui questa implementazione è stata sviluppata e testata in automatico — vedi
il report finale per il dettaglio di cosa è stato verificato con test
automatici vs cosa richiede un ambiente completo).
