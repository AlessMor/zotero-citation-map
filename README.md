# Zotero Citation Map

Zotero Citation Map adds citation and reference metrics to Zotero and visualizes citation relationships between papers in an interactive graph.

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

## Requirements

- Zotero 9
- Windows, macOS, or Linux supported by Zotero
- Node.js 24 LTS and npm 11.18 or later for development

## Installation

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
