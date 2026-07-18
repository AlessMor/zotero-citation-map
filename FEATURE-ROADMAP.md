# Feature roadmap

## Recommended next milestone: provenance and quality

Add the following sortable Zotero columns and graph metrics before adding more discovery features:

1. **Reference coverage** = structured references / declared references.
2. **Data provider** for citation and reference counts.
3. **Last updated** date.
4. **Match method** (DOI, PMID, arXiv, ISBN, confirmed title match).
5. **Match confidence** for non-identifier matches.
6. **Retraction flag**.

These make current counts auditable and explain differences between a PDF bibliography and provider-resolved references.

## High-value OpenAlex metrics

- Field-Weighted Citation Impact (FWCI).
- Citation-normalized percentile and top-1% / top-10% flags.
- Citations by year and citation velocity.
- Open-access status.
- Primary topic, field, and domain.
- Source 2-year mean citedness, h-index, and i10-index.
- Retraction status.

Useful graph encodings:

- axis: FWCI, percentile, citation velocity;
- node size: FWCI, local PageRank, citation velocity;
- node color: topic, open-access status, retraction status;
- filter: top percentile, topic, source, retracted, open access.

## High-value Semantic Scholar metrics

- Influential citation count.
- Citation intent and context, when available.
- Similar-paper recommendations.

Citation-intent data should be presented with provider provenance and should not be treated as equivalent to conventional citation totals.

## Local graph analytics requiring no additional API

- In-library citations and references.
- Connected-component identifier and component size.
- PageRank or eigenvector centrality.
- Betweenness centrality.
- Bibliographic coupling strength.
- Co-citation strength.
- Citation-chain depth.
- Isolated-node indicator.

These metrics are reproducible for the current graph scope and avoid external API cost.

## Discovery and workflow

- Expand one hop to external references or citing works.
- Rank missing papers by the number of library papers that cite them.
- Add an external paper to Zotero from the graph.
- Save graph views, filters, axes, and pinned positions.
- Export SVG/PNG, JSON, CSV edge lists, and GraphML.
- Add lasso selection and neighborhood isolation.
- Support group libraries and multi-library selection.

## Data-quality safeguards

- Do not silently mix a count from one provider with graph edges from another without displaying provenance.
- Keep `null` (unknown) distinct from `0` (confirmed zero).
- Display declared and resolved reference counts separately.
- Require user confirmation for ambiguous title matches.
- Store schema version and provider response version in the cache.
- Add migrations and a cache-clear/backup workflow.
