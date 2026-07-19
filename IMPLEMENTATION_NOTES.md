# Implementation notes for local testing

## Scope

This snapshot implements the agreed 0.2.0-dev design across the provider layer,
private cache, library columns, item pane, graph, discovery/import workflow and
exports.

## Validation performed

- Strict TypeScript validation with `tsc -p tsconfig.validation.json`.
- Local-module import audit.
- SQLite upsert-column/parameter count audit.
- Packaging audit excluding local build caches.

## Items to exercise in Zotero

1. Fresh installation and cache creation.
2. Conservative automatic Crossref-preferred lookup for DOI items, followed
   by richer enrichment during explicit refreshes.
3. PMID/arXiv/ISBN provisional-match confirmation.
4. Exact-title unique and ambiguous-match behavior.
5. Library-column visibility, sorting and header tooltips.
6. Item-pane rendering in both library and PDF-reader tabs.
7. Manual reference/cited-by relation creation and removal.
8. Ignore/restore provider relation behavior.
9. Free/free, metric/free and metric/metric graph layouts.
10. Numeric color legends and multi-collection slice rendering.
11. Detail-panel resize-to-zero and restore persistence.
12. Missing-paper results and multi-collection import.
13. PNG, JSON and CSV export.
14. Clean Zotero shutdown while a graph and API request are active.

## Known environment limitation

The implementation environment did not have network access for installing the
repository's npm dependencies. Therefore the standard scaffold XPI build was
not executed here. The source-level strict TypeScript validation passed; run
`npm install` followed by `npm run build` in the normal development environment
to create the production XPI.

## Relationship lists

The item-pane Cited by and References views include local search, relevant sort
choices, and incremental rendering in groups of 50. Provider aggregate totals
remain independent from the number of relation records currently retrieved.
