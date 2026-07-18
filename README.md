# Zotero Citation Map

Zotero Citation Map adds citation and reference metrics to Zotero and visualizes citation relationships between papers in an interactive network.

> Status: early development (`0.1.0`). Use a separate Zotero development profile while testing.

## Features

### Citation data

- Sortable **Citations** and **References** columns in the Zotero library.
- Automatic background refresh, enabled by default.
- Manual refresh for one or more selected items from the Zotero context menu.
- Whole-library refresh from **Tools → Citation Map**.
- Provider choices: Automatic, OpenAlex, Semantic Scholar, Crossref, OpenCitations, and INSPIRE-HEP.
- Plugin-owned SQLite cache; Zotero's `Extra` field is not modified.
- Structured outgoing-reference metadata is retained for graph construction.

### Citation graph

- Whole library by default, with collection, subcollection, tag, and missing-data filters.
- Zotero-style all-fields-and-tags search and node highlighting.
- Force-directed graph when both axes are disabled.
- Independent X and Y metrics:
  - publication year;
  - citation count;
  - reference count;
  - no fixed metric.
- Linear and logarithmic scales.
- Collision spacing for papers with identical metric values.
- Node size by citations, references, or a uniform size.
- Labels by title or first author and year.
- Node colors derived from Zotero collection membership.
- Pan, zoom, fit-to-view, details panel, and navigation back to the Zotero item.
- Opens as a Zotero tab and can be moved to a separate window using Zotero's tab menu.

## Data-provider notes

Citation databases do not have identical coverage. Citation and reference totals can therefore differ between providers and from the bibliography printed in a PDF.

The **References** column is the best available declared bibliography total. The cache separately records how many structured references were returned and can be connected to graph nodes. A paper may therefore show 63 references while only 55 references have enough structured metadata for graph construction.

Automatic mode tries compatible providers and preserves provenance for the selected counts. Provider availability and rate limits are controlled by third parties and may change.

## Requirements

- Zotero 9
- Windows, macOS, or Linux supported by Zotero
- Node.js 24 LTS and npm 11.18 or later for development only

## Installation

No public release is available yet. During development:

1. Create a separate Zotero profile and data directory.
2. Clone this repository.
3. Copy `.env.example` to `.env` and set the local Zotero paths.
4. Install dependencies with `npm ci`.
5. Start the development watcher with `npm start`.

`npm start` remains active after Zotero closes because it is a file watcher. Stop it with `Ctrl+C`.

## Development commands

```powershell
npm ci
npm run check
npm run build
npm start
```

Before changing dependencies, review any install-script warnings and update the committed `allowScripts` policy with npm's `approve-scripts` command.

The production XPI and update manifests are written under `.scaffold/build/`.

## Privacy

The plugin has no telemetry or analytics. Requests go directly from Zotero to the selected scholarly-data provider. The request normally contains a scholarly identifier such as a DOI, PMID, arXiv ID, or ISBN. Results are cached locally in a plugin-owned SQLite database.

See [PRIVACY.md](PRIVACY.md) for details.

## Security

Zotero plugins have access to the Zotero library and the local computer. Install only builds from a source and developer you trust. Security reports should follow [SECURITY.md](SECURITY.md).

## Known limitations

- Coverage differs across providers and disciplines.
- Unknown values are distinct from confirmed zero values.
- The current graph displays papers already in Zotero; external citing and referenced papers are not yet expanded as nodes.
- Group-library and multi-library behavior still needs broader testing.
- Citation-provider APIs can change access rules or rate limits independently of this plugin.
- The plugin cache is local to each computer and is not synchronized through Zotero Sync.

## License and attribution

The plugin is licensed under **AGPL-3.0-or-later**. See `LICENSE` and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Zotero Citation Map is an independent community project and is not affiliated with or endorsed by Zotero, OpenAlex, Semantic Scholar, Crossref, OpenCitations, or INSPIRE-HEP.
