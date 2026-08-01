# Zotero Citation Map:

Zotero Citation Map is a plugin for Zotero 9 that brings citation networks,bibliometric data, and paper discovery directly into your Zotero library.

The project began as a weekend experiment. I wanted to test how far I could take ChatGPT 5.6 SOL while solving a minor annoyance in my own research workflow.

Whenever I wanted to explore the connections between a set of papers, I had to move repeatedly between Zotero and external tools such as ResearchRabbit or Litmaps. I wanted a simple way to inspect those relationships directly inside Zotero.

So I decided to see if something along those lines could be integrated directly inside Zotero... and this plugin is the result!

![zotero-citation-map overview](docs/assets/Registrazione%202026-07-20%20231456.gif)

## Installation:

1. Open the last [release](https://github.com/AlessMor/zotero-citation-map/releases/latest) page.

2. Under **Assets**, download the latest `.xpi` file.

   > Do not download the automatically generated **Source code** `.zip` or `.tar.gz` archives.

3. in Zotero, open **Tools → Plugins**.

5. Drag the downloaded `.xpi` file into the Plugins window and confirm the installation when prompted.

7. Restart Zotero if required.

To **update** the plugin, install the newer `.xpi` in the same way. Zotero willreplace the existing version.

## Main Features

- **See how papers in your library are connected**
  Build an interactive citation map for a library, collection, or selectedpapers. Search and filter the graph, inspect a paper, and return directly toits Zotero item, notes, or PDF.
  ![graph](docs/assets/FreeGraph.png)

- **Focus on one or more papers**
  Explore references, citing papers, or both around one or more "seed" papers. Add or remove seeds, include papers outside Zotero, rank and limit neighbours, and move backward or forward through previous focus states.
  ![FocusView](docs/assets/FocusView.png)

- **Inspect citation data inside Zotero**
  Show citation and reference counts as library columns. Use the item pane to review overview metrics, references, and citing papers; search, sort, and filter long lists; refresh stale data and correct or add custom relationships.
  ![MainLibrary](docs/assets/MainLibrary.png)

- **Customize and export the map**
  Arrange papers by publication year, citation sequence, citation count, and other available metrics. Map values to axes, node size, and colour; filter by metadata and data quality; and export the visible graph as PNG, CSV, or JSON.

- **Discover and add missing papers**
  Explore external references, citing works, and similar papers alongside your Zotero items. Preview their metadata, open the DOI, mark incorrect matches, or add the paper directly to Zotero.

- **Work with multiple independent views**
  Open several Citation Map and Focus View tabs at once. Rename views and use `Open in ›` to create a new view or add a paper to an existing one. Each view keeps its own scope, filters, selection, camera, and navigation history.

- **Control providers and updates**
  Choose which scholarly-data providers to use, which Zotero libraries shouldupdate automatically, and when cached data become stale. Refresh data manually when needed; long updates show progress and can be cancelled.
  ![settings](docs/assets/Settings.png)


## Data sources

Citation and bibliographic data can be retrieved from:

- [Crossref](https://www.crossref.org/)
- [Semantic Scholar](https://www.semanticscholar.org/)
- [OpenCitations](https://opencitations.net/)
- [INSPIRE-HEP](https://inspirehep.net/)
- [OpenAlex](https://openalex.org/) (requires API key)

These services are independent of this project. Their terms, coverage, rate
limits, and data-quality limitations apply. Counts and relationship lists may
differ between providers. The plugin will try to integrate their data, preferring largest citation count.

## Acknowledgements:

The project was mainly inspired by other Zotero plugins:

- [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template): initial template for the plugin.

- [zotero-cita/zotero-cita](https://github.com/zotero-cita/zotero-cita)

- [phdemotions/zotero-citegeist](https://github.com/phdemotions/zotero-citegeist)

- [eschnett/zotero-citationcounts](https://github.com/eschnett/zotero-citationcounts)

- [MuiseDestiny/zotero-style](https://github.com/MuiseDestiny/zotero-style)

- [danieleongari/zotero-openalex](https://github.com/danieleongari/zotero-openalex)

- [zotero-INSPIRE](https://github.com/fkguo/zotero-inspire)