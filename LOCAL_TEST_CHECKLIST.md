# Local Zotero 9 test checklist

Use a separate Zotero profile and data directory. Back up the profile before
installing a development build.

## Installation

1. Open **Tools → Plugins** in Zotero 9.
2. Choose **Install Plugin From File** and select the supplied test XPI.
3. Restart Zotero.
4. Confirm that **Tools → Citation Map** is present and Zotero closes normally.

## Library and item pane

1. Enable **Citations**, **References**, **Citation rate**, and several
   **More Columns** metrics.
2. Hover each enabled Citation Map column header and verify its definition.
3. Sort ascending and descending by numeric and status columns.
4. Select a paper and inspect **Overview**, **Cited by**, and **References** in
   the Citation Map item-pane section.
5. Open that paper's PDF and confirm the reader pane displays data for the
   parent bibliographic item.
6. Test relationship search, sorting, and **Load more**.
7. Add and remove a manual reference/citing-paper relation to another Zotero
   item. Mark a provider relation incorrect, then restore it.
8. Exercise DOI, PMID, arXiv, ISBN, unique exact-title, and ambiguous-title
   match confirmation where suitable test records are available.

## Graph

1. Open **Tools → Citation Map → Open Citation Map**.
2. Test whole-library, collection, tag, status, and missing-data filters.
3. Test Free/Free, metric/Free, Free/metric, and metric/metric layouts.
4. Confirm logarithmic scale is disabled for incompatible metrics.
5. Test node size, numeric blue-to-red colors, collection colors, labels, and
   **Reset defaults**.
6. Verify deepest collection memberships, up to four slices, and the
   three-colors-plus-gray behavior for highly multi-filed items.
7. Resize the right panel fully to zero, restore it, close/reopen the graph, and
   verify persistence.

## Discovery, import, and export

1. Browse references and citing works that are not in the current library.
2. Confirm external abstracts appear only when available.
3. Use **Missing papers**, inspect a ghost preview, and add a result to several
   collections using check marks in the hierarchical chooser.
4. Export the current filtered graph as PNG, JSON, and CSV and inspect each
   file.

## Shutdown and failure handling

1. Start a refresh, close the graph, then close Zotero.
2. Repeat while a public provider is unavailable or rate-limited.
3. Confirm Zotero exits without an orphan window or lingering process.
