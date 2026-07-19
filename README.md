# Zotero Citation Map

Zotero Citation Map adds citation and reference metrics to Zotero, provides a
paper-level citation inspector, and visualizes relationships between papers in
an interactive graph.

This repository snapshot contains the `0.2.0-dev` implementation of the
redesigned interface documented in [`DESIGN_CHOICES.md`](DESIGN_CHOICES.md).

## Requirements

- Zotero 9
- Windows, macOS, or Linux supported by Zotero
- Node.js 24 and npm 11.18 or later for the standard scaffold build

## Main features

### Zotero library

- Primary sortable columns for **Citations** and **References**.
- Optional primary **Citation rate** column.
- Additional impact, status, source, network, bibliography and data-quality
  columns under Zotero's More Columns submenu.
- Metric definitions on column-header hover.
- Plugin-owned SQLite cache; Zotero's `Extra` field is not modified.

### Citation Map item pane

- Overview, Cited by and References views in the normal library and PDF reader.
- Provider provenance, data freshness and match confirmation.
- Manual citation/reference relations restricted to existing Zotero items.
- Local correction rules for incorrect provider relations.

### Citation graph

- Whole-library, collection, tag, status and missing-data filters.
- Free force graph or independently constrained X/Y metric axes.
- Linear and logarithmic scales where valid.
- Node size by numeric metrics.
- Node color by collection/category or a blue-to-red numeric gradient.
- Hierarchical collection colors and sliced multi-collection nodes.
- Resizable/collapsible detail panel.
- Missing-paper discovery and multi-collection Zotero importing.
- PNG, JSON and CSV export.

### Providers

Automatic mode is **Crossref preferred**. Background refreshes use a
conservative base lookup; explicit refreshes and on-demand citation browsing
may enrich records using other free, documented public services:

- Crossref
- Semantic Scholar
- OpenCitations
- INSPIRE-HEP
- OpenAlex, opportunistically when anonymous public access is available

No API key or email address is requested.

## Matching

Citation Map tries identifiers in this fixed order:

1. DOI
2. PMID
3. arXiv ID
4. ISBN
5. exact normalized full title

Unique, non-contradictory exact-title matches are accepted automatically.
Fallback-identifier and ambiguous matches are confirmed in the item pane.

## Development setup

1. Create a separate Zotero profile and data directory for testing.
2. Copy `.env.example` to `.env` and set the local Zotero paths.
3. Install dependencies with `npm install` (or `npm ci` when a lockfile is
   available).
4. Run `npm run check`.
5. Run `npm start` for the development watcher, or `npm run build` for an XPI.

The production XPI and update manifests are written under `.scaffold/build/` by
`zotero-plugin-scaffold`.

## Validation in this snapshot

The source was validated with strict TypeScript 5.8 using
`tsconfig.validation.json`. The normal scaffold build still requires the npm
dependencies listed in `package.json`.

## Design documentation

All agreed interaction and data decisions are recorded by Zotero surface in
[`DESIGN_CHOICES.md`](DESIGN_CHOICES.md).

## License

AGPL-3.0-or-later.
