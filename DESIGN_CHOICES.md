# Zotero Citation Map — Design Choices

This document records the deliberate product and interaction decisions for the
`0.2.0-dev` redesign. It is organized by the Zotero surface in which a user
encounters the plugin. These decisions are intended to remain stable unless a
later usability test shows a concrete problem.

## 1. Main Zotero library

### Primary columns

The normal column picker exposes these compact paper-level values directly:

- **Citations** — visible by default.
- **References** — visible by default.
- **Citation rate** — directly available but hidden by default.

Citation rate is the average number of citations received during the three most
recent complete calendar years. The more volatile **Citation acceleration** is
not a primary column.

### Additional columns

All other metrics are registered as Zotero custom columns under Zotero's
**More Columns** submenu:

- Impact: citation acceleration, citations last year, FWCI, citation
  percentile, influential citations.
- Status: Open Access and retraction status.
- Source: two-year mean citedness, journal h-index, journal i10-index.
- Library network: library coverage, local/global impact, PageRank,
  betweenness, eigenvector centrality, component size, citation-chain depth.
- Bibliography: structured-reference coverage, reference age, reference-age
  spread, estimated self-citation fraction, future-dated references.
- Data quality: data age, metadata completeness, match confidence and provider.

All numeric columns are sortable. Column widths, positions, hidden state and
sort direction are left to Zotero's normal column-persistence mechanism.

### Metric explanations

Hovering an enabled Citation Map column header displays a concise definition of
the metric and, where useful, an interpretation note. The plugin does not patch
Zotero's generated column-picker menu, because that menu does not expose a
stable public description API.

### Status presentation

Retraction status is available as a column but is also shown as a prominent
warning in the item pane and a warning outline in the graph. Users should not
have to enable a special column to notice a reported retraction.

## 2. Zotero item properties pane

Citation Map registers one collapsible **Citation Map** section in Zotero's
item pane. It is available in both the main library and the PDF-reader context.

### Collapsed summary

The collapsed header shows a compact summary such as:

`128 C · 46 R · 8.3/y`

A retraction warning remains visually prominent when present.

### Internal views

The expanded section has three views:

1. **Overview** — counts, trend metrics, normalized impact, status, source
   metrics, provider, freshness and local network information.
2. **Cited by** — known works citing the selected Zotero item.
3. **References** — known works referenced by the selected Zotero item.

The plugin does not duplicate the abstract for a local Zotero item, because
Zotero already displays it.

### Relationship-list controls

Cited-by and reference lists are loaded on demand. Both views provide local
search and sorting without exposing provider mechanics in the base interface.
References default to provider/bibliography order; cited-by results default to
most recent. Other choices are oldest, most cited, title and in-Zotero-first.
The first 50 matching records are rendered and **Load more** reveals additional
records in groups of 50. External records without a supplied title display a
DOI or provider work ID rather than an unhelpful blank title.

### Provider aggregates and local corrections

The citation and reference totals remain the aggregate values reported by the
active provider. Manual additions and ignored provider relations are displayed
separately under **Data details**. Local corrections do not pretend to
reconstruct a provider's complete aggregate when only a subset of individual
relations is available.

### Match confirmation

- A DOI match is accepted automatically.
- A unique exact normalized-title match is accepted automatically only when
  available metadata is non-contradictory.
- A match found through PMID, arXiv ID or ISBN is shown as provisional and can
  be confirmed with one click.
- Multiple or contradictory exact-title candidates require the user to choose
  a candidate explicitly.
- Confirmed provider identities are stored in Citation Map's private database;
  they are not written into Zotero's `Extra` field.

### Manual citation relationships

Manual relations can only connect two existing Zotero bibliographic items.
Users can add either:

- a **reference**: selected item cites related item; or
- a **citing paper**: related item cites selected item.

The add interface searches the current Zotero library. It does not create a raw
citation count or an unresolved text-only relation. Manual relations are marked
as such, survive provider refreshes and can be removed.

Provider-derived relations can be marked incorrect. This creates a local
ignore rule rather than deleting provider cache data. Ignored relations can be
restored.

## 3. PDF-reader item pane

The same Citation Map section is available when an attachment is open in the
Zotero reader. It acts on the parent bibliographic item. No separate reader-only
abstract or citation editor is introduced.

Manual citation/reference editing is intentionally located in the properties
pane, not directly on PDF annotations or text selections.

## 4. Settings

The normal settings page is intentionally small.

### Data source

The default label is:

**Automatic — Crossref preferred**

Automatic background updates start with Crossref when a DOI is available.
They deliberately avoid broad multi-provider enrichment on every library item.
Richer Semantic Scholar/OpenAlex metadata are requested during an explicit
refresh or when the user opens an on-demand relationship/discovery view. This
keeps no-key public access conservative while retaining the advanced fields.
The provider actually used is shown per item and per count.

No API-key or email setting is provided. Citation Map uses only public,
documented access paths and applies caching, throttling and retry backoff.
OpenAlex is treated as opportunistic public enrichment rather than a required
anonymous dependency. Anonymous failures or rate limits degrade gracefully and
disable further OpenAlex requests for the current Zotero session.

### Matching order

Identifier matching is fixed internally and is not a user-facing preference:

1. DOI
2. PMID
3. arXiv ID
4. ISBN
5. exact normalized full title

Title normalization applies Unicode normalization, lowercasing, punctuation
and symbol replacement with spaces, whitespace collapse and full-string exact
comparison. Words are not concatenated. Author and year metadata are used to
reject contradictory matches.

### Updating and cache

Normal settings include:

- automatic background updates;
- automatic updating of newly added items;
- cache lifetime in days;
- a manual whole-library refresh command, which also attempts optional rich
  metadata enrichment.

Citation data are stored in a plugin-owned SQLite database. Citation Map does
not modify the Zotero `Extra` field.

### Discovery

External papers are always excluded from the initial graph. This is a fixed,
non-configurable default to keep the normal graph local and uncluttered.
External papers appear only after the user deliberately browses references,
citing works or missing-paper recommendations.

### Advanced settings

Advanced options are collapsed by default and include exact-title fallback,
Zotero-local relations, experimental note/PDF DOI extraction, cache clearing
and diagnostic logging. They do not clutter the normal settings view.

### Options deliberately omitted

There are no settings for:

- identifier order;
- journal/status metadata retrieval;
- initial graph layout;
- detail-panel opening;
- detail-panel width persistence;
- a default import collection;
- external papers in the initial graph;
- node appearance defaults.

Those behaviors are automatic or remembered from direct manipulation.

## 5. Citation Map top area

The top area contains:

- library name and graph statistics;
- all-fields-and-tags search;
- collection and tag filters;
- missing-data/status filters;
- **Missing papers**;
- **Export**;
- **Refresh view**.

Search and filters alter the current view only. They are not settings.

### Export

A single **Export** button opens a menu containing exactly three formats:

- PNG graph image;
- JSON graph data;
- CSV citation-link table.

Exports use the currently visible, filtered graph.

## 6. Citation Map graph

### Initial layout

The graph always opens as a completely free, force-directed network. No setting
is required for this default.

### Interaction

The graph supports pan, zoom, fit, selection, double-click navigation to Zotero,
search highlighting and directed citation arrows. Manual relations are drawn as
dashed purple links so that their provenance remains visible.

### Status channels

Node fill is reserved for the selected color encoding. Other states use separate
visual channels:

- selection: strong outer ring;
- search match: yellow halo;
- reported retraction: red warning outline;
- external recommendation preview: ghosted/dashed presentation.

## 7. Axes & appearance overlay

A semi-transparent **Axes & appearance** button sits at the bottom-left of the
graph. It becomes fully opaque on hover or focus. The opened panel is non-modal
and contains three sections.

### X axis

- Metric selector.
- Scale selector: Linear or Logarithmic.
- **Free** is an axis metric.

### Y axis

Identical to the X-axis controls.

### Free-axis behavior

- Free + Free: fully force-directed graph.
- Metric + Free: constrained on the metric axis and free on the other axis.
- Free + Metric: corresponding vertical constraint.
- Metric + Metric: two-dimensional metric plot.

Logarithmic scale is disabled for incompatible values, including metrics that
can be negative.

### Nodes

The Nodes section controls:

- size metric;
- color metric;
- labels (title, author/year, or none).

Node area, not radius, is proportional to a numeric size metric.

### Numeric colors

Numeric color metrics use a perceptually staged gradient with:

- blue = low;
- cyan/yellow transition;
- red = high.

A legend shows the current metric and domain. Robust percentile clipping keeps
one extreme paper from flattening the rest of the color range.

### Reset defaults

Reset restores:

- X axis: Free, Linear;
- Y axis: Free, Linear;
- node size: Citations;
- node color: Collection;
- labels: Title.

It does not clear search, filters, selected collection, external results or the
detail-panel width.

## 8. Collection colors and multi-collection nodes

Collection is the default color encoding.

- Top-level collections receive distinct base hues.
- Subcollections use the same hue with controlled lightness/saturation changes.
- Only deepest memberships are represented; a parent and its selected
  descendant do not create duplicate slices.
- Items in up to four deepest collections are divided into colored node slices.
- Items in more than four collections show the first three relevant colors plus
  one gray slice. The complete collection list remains available in the
  tooltip/detail context.
- Relevance order is: current/deepest memberships, then Zotero collection order.
- Unfiled items are gray.

## 9. Citation Map right detail panel

The detail panel opens by default. It has no separate collapse button.

- Drag its left divider to resize it.
- Drag fully to the right to collapse it to zero, leaving a narrow restore
  handle.
- Double-clicking the handle toggles collapse/restore.
- The last non-zero width and collapsed state are remembered automatically.

For a local paper it provides Overview, Cited by and References access plus
navigation to Zotero and DOI actions.

## 10. External-paper evaluation

External works appear in the right panel when browsing references, citing works
or missing-paper recommendations.

Each external card may show:

- title, authors, journal/source and year;
- citation count;
- Open Access and retraction badges;
- why the work was recommended;
- an abstract disclosure, when the provider supplies an abstract;
- DOI opening and Zotero import actions.

Abstracts are shown here because the work is not yet represented by a normal
Zotero item.

## 11. Adding external papers to Zotero

Clicking **Add to Zotero** expands an embedded hierarchical collection chooser
inside the right panel.

- Zotero's collection/subcollection hierarchy and ordering are preserved.
- Branches are collapsible.
- Collections can be searched.
- Multiple collections can be selected in one operation.
- Selection is displayed as a check symbol beside the collection name rather
  than as a conventional boxed checkbox.
- Selecting no collection adds the paper to the library root.
- After import the card updates in place and identifies the work as present in
  Zotero.

## 12. Missing-paper discovery

Missing-paper recommendations are calculated from references shared by papers
in the current visible graph. Papers already present in the Zotero library are
excluded. The default threshold requires at least two visible papers to point
to the missing work.

Results are ranked first by the number of visible connecting papers, then by
citation count, year and title. Hovering a recommendation can show a temporary
ghost node connected to the relevant local papers.

## 13. Data model and provenance

Citation Map keeps separate records for:

- canonical work identity and provider;
- provider aggregate counts;
- structured references;
- optional work/source metrics;
- manual Zotero-to-Zotero relations;
- ignored provider relations;
- match candidates and confirmation state.

Every graph edge carries provenance. Provider refreshes do not overwrite manual
relations or local correction rules.

## 14. Metric registry

A single metric registry defines:

- label and tooltip;
- category;
- formatting;
- library-column availability;
- item-pane placement;
- graph-axis eligibility;
- log-scale compatibility;
- node-size/color eligibility.

This prevents the library, item pane and graph from developing inconsistent
metric definitions.
