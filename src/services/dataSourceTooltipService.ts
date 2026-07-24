import type {
  CitationProviderID,
  RelatedWorkMetadata,
} from "../domain/citationTypes";
import type { CitationGraphNode } from "../domain/graphTypes";
import { getCachedCitationGraph } from "./citationGraphService";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";
import { createMetricNodeForItem } from "./itemMetricContext";
import {
  formatMetricValue,
  METRIC_DEFINITIONS,
  SUPPLEMENTARY_PROPERTY_DEFINITIONS,
  metricTooltip,
} from "./metricRegistry";
import {
  citationDataSourceLabel,
  type CitationDataSourceID,
} from "./providerPresentation";
import { getStoredRelationshipEntry } from "./relationshipStoreService";

export type DataSourceID = CitationDataSourceID;

const HTML_NS = "http://www.w3.org/1999/xhtml";

interface DocumentTooltipHandlers {
  mouseover: EventListener;
  mousemove: EventListener;
  mouseout: EventListener;
  focusin: EventListener;
  focusout: EventListener;
  keydown: EventListener;
  tooltip: HTMLElement;
  currentTarget: HTMLElement | null;
  lastX: number;
  lastY: number;
  observer: MutationObserver | null;
}

const documentHandlers = new WeakMap<Document, DocumentTooltipHandlers>();

function providerID(value: unknown): DataSourceID | null {
  const text = String(value ?? "")
    .trim()
    .toLocaleLowerCase();
  if (text === "crossref") return "crossref";
  if (text === "semantic-scholar" || text === "semantic scholar") {
    return "semantic-scholar";
  }
  if (text === "opencitations") return "opencitations";
  if (text === "inspire" || text === "inspire-hep") return "inspire";
  if (text === "openalex") return "openalex";
  if (text === "zotero") return "zotero";
  if (text === "citation-map" || text === "citation map") {
    return "citation-map";
  }
  if (text === "manual") return "manual";
  return null;
}

function normalizedSources(
  values: Array<DataSourceID | CitationProviderID | null | undefined>,
): DataSourceID[] {
  const result: DataSourceID[] = [];
  const seen = new Set<DataSourceID>();
  for (const value of values) {
    const normalized = providerID(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function latestTimestamp(
  ...values: Array<string | null | undefined>
): string | null {
  let latest: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || parsed <= latestTime) continue;
    latest = value;
    latestTime = parsed;
  }
  return latest;
}

function formatUpdate(value: string | null | undefined): string {
  if (!value) return "Not available";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleString()
    : "Not available";
}

export function dataSourceTooltip(
  sources: Array<DataSourceID | CitationProviderID | null | undefined>,
  updatedAt: string | null | undefined,
): string {
  const labels = normalizedSources(sources).map(citationDataSourceLabel);
  return [
    `Sources: ${labels.length ? labels.join(", ") : "Not recorded"}`,
    `Last update: ${formatUpdate(updatedAt)}`,
  ].join("\n");
}

function normalizedField(field: string): string {
  return field
    .trim()
    .toLocaleLowerCase()
    .replace(/[()]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-");
}

function referenceSources(node: CitationGraphNode): DataSourceID[] {
  return normalizedSources([
    node.referenceCountProvider,
    ...node.references.map((reference) => reference.provider),
    ...node.references.flatMap((reference) => reference.dataSources ?? []),
  ]);
}

function primarySource(node: CitationGraphNode): DataSourceID[] {
  return normalizedSources([node.provider]);
}

function openAlexSource(_node: CitationGraphNode): DataSourceID[] {
  return normalizedSources(["openalex"]);
}

function nodeSources(node: CitationGraphNode, field: string): DataSourceID[] {
  switch (normalizedField(field)) {
    case "citations":
    case "citation-count":
      return normalizedSources([node.citationCountProvider ?? node.provider]);
    case "references":
    case "reference-count":
      return normalizedSources([node.referenceCountProvider ?? node.provider]);
    case "structured-references":
      return referenceSources(node);
    case "citations-last-year":
    case "citation-rate":
    case "citation-acceleration":
    case "change-in-annual-citations":
    case "annual-citation-change":
    case "fwci":
    case "citation-percentile":
      return openAlexSource(node);
    case "influential-citations":
    case "influential-citation-count":
      return normalizedSources(["semantic-scholar"]);
    case "two-year-mean-citedness":
    case "2-year-mean-citedness":
    case "journal-h-index":
    case "journal-i10-index":
      return normalizedSources(["openalex"]);
    case "library-coverage":
    case "connections-in-library":
    case "local-global-impact":
    case "localglobal-impact":
    case "pagerank":
    case "betweenness":
    case "eigenvector":
    case "eigenvector-centrality":
    case "component-size":
    case "citation-chain-depth":
    case "reference-coverage":
    case "reference-age-mean":
    case "mean-reference-age":
    case "reference-age-spread":
    case "self-citation-estimate":
    case "estimated-self-citations":
    case "future-references":
    case "future-dated-references":
    case "last-update":
    case "lastupdate":
    case "data-age":
      return normalizedSources(["citation-map", ...referenceSources(node)]);
    case "metadata-completeness":
      return normalizedSources(["zotero", "citation-map"]);
    case "year":
    case "title":
    case "authors":
    case "abstract":
    case "source-title":
    case "doi":
      return normalizedSources(["zotero"]);
    case "open-access":
    case "openaccessstatus":
    case "open-access-status":
    case "retracted":
    case "retractionstatus":
    case "retraction-status":
    case "publication-type":
    case "match-method":
    case "matchmethod":
    case "canonical-provider":
    case "citation-provider":
    case "matched-by":
    case "match-confidence":
    case "updated":
      return primarySource(node);
    case "local-manual-relations":
      return normalizedSources(["manual", "citation-map"]);
    default:
      return primarySource(node);
  }
}

function itemModifiedAt(item: Zotero.Item | null): string | null {
  if (!item) return null;
  const raw = String(
    (item as any).dateModified ?? item.getField?.("dateModified") ?? "",
  ).trim();
  return raw || null;
}

function nodeUpdatedAt(
  node: CitationGraphNode,
  field: string,
  item: Zotero.Item | null,
): string | null {
  switch (normalizedField(field)) {
    case "year":
    case "title":
    case "authors":
    case "abstract":
    case "source-title":
    case "doi":
    case "metadata-completeness":
      return latestTimestamp(itemModifiedAt(item), node.metricsUpdatedAt);
    case "two-year-mean-citedness":
    case "2-year-mean-citedness":
    case "journal-h-index":
    case "journal-i10-index":
      return latestTimestamp(
        node.sourceMetrics?.updatedAt,
        node.metricsUpdatedAt,
      );
    default:
      return node.metricsUpdatedAt;
  }
}

export function nodeFieldDataSourceTooltip(
  node: CitationGraphNode,
  field: string,
  item: Zotero.Item | null = null,
): string {
  return dataSourceTooltip(
    nodeSources(node, field),
    nodeUpdatedAt(node, field, item),
  );
}

export function externalWorkDataSourceTooltip(
  work: RelatedWorkMetadata,
  fallbackUpdatedAt: string | null = null,
): string {
  return dataSourceTooltip(
    work.dataSources?.length ? work.dataSources : [work.provider],
    latestTimestamp(work.updatedAt, fallbackUpdatedAt),
  );
}

function activeRegularItem(document: Document): Zotero.Item | null {
  try {
    const win = document.defaultView as any;
    const pane = win?.ZoteroPane ?? Zotero.getActiveZoteroPane?.();
    const selected = pane?.getSelectedItems?.() ?? [];
    const item = selected[0] as Zotero.Item | undefined;
    return item?.isRegularItem?.() && !item.deleted ? item : null;
  } catch {
    return null;
  }
}

function cachedGraphForItem(item: Zotero.Item | null) {
  const libraryID = Number(item?.libraryID);
  const preferred = Number.isFinite(libraryID)
    ? getCachedCitationGraph(libraryID)
    : null;
  return preferred ?? getCachedCitationGraph(Zotero.Libraries.userLibraryID);
}

function graphNodeForElement(
  document: Document,
  element: Element,
): { node: CitationGraphNode; item: Zotero.Item | null } | null {
  const item = activeRegularItem(document);
  if (
    element.closest(".citation-map-pane-metrics, .citation-map-relation-card")
  ) {
    return item ? { node: createMetricNodeForItem(item), item } : null;
  }

  const detail = element.closest(".cm-detail-panel");
  if (!detail) {
    return item ? { node: createMetricNodeForItem(item), item } : null;
  }
  const heading = String(detail.querySelector("h2")?.textContent ?? "").trim();
  const normalizedTitle = normalizeExactTitle(heading);
  const graph = cachedGraphForItem(item);
  const matches = normalizedTitle
    ? (graph?.nodes ?? []).filter(
        (candidate) => normalizeExactTitle(candidate.title) === normalizedTitle,
      )
    : [];
  if (matches.length === 1) return { node: matches[0], item };
  return item ? { node: createMetricNodeForItem(item), item } : null;
}

function elementPath(event: Event): HTMLElement[] {
  const raw =
    typeof event.composedPath === "function" ? event.composedPath() : [];
  const elements = raw.filter((entry): entry is HTMLElement =>
    Boolean(
      entry && typeof entry === "object" && (entry as Node).nodeType === 1,
    ),
  );
  if (elements.length) return elements;
  return event.target && (event.target as Node).nodeType === 1
    ? [event.target as HTMLElement]
    : [];
}

function normalizedPropertyLabel(value: string): string {
  return normalizedField(value.replace(/\s*\([^)]*\)\s*$/, ""));
}

const PROPERTY_DEFINITIONS = new Map<string, string>();
for (const metric of METRIC_DEFINITIONS) {
  const definition = metricTooltip(metric.id);
  PROPERTY_DEFINITIONS.set(normalizedPropertyLabel(metric.id), definition);
  PROPERTY_DEFINITIONS.set(normalizedPropertyLabel(metric.label), definition);
  if (metric.shortLabel) {
    PROPERTY_DEFINITIONS.set(
      normalizedPropertyLabel(metric.shortLabel),
      definition,
    );
  }
}

for (const property of SUPPLEMENTARY_PROPERTY_DEFINITIONS) {
  PROPERTY_DEFINITIONS.set(
    normalizedPropertyLabel(property.id),
    property.description,
  );
  PROPERTY_DEFINITIONS.set(
    normalizedPropertyLabel(property.label),
    property.description,
  );
}
for (const [label, definition] of Object.entries({
  "structured-references":
    "Number of externally retrieved bibliography entries with enough structured metadata to identify the referenced work.",
  "local-manual-relations":
    "Citation relationships for this paper that were added manually in Citation Map.",
  "top-1":
    "The paper is in the highest 1% of its OpenAlex citation-normalized comparison group for work type, publication year and subfield.",
  "top-10":
    "The paper is in the highest 10% of its OpenAlex citation-normalized comparison group for work type, publication year and subfield.",
  "in-zotero": "This work is already present in the current Zotero library.",
  "ignored-relationship":
    "This provider relationship has been hidden from the citation graph.",
  "manual-relationship":
    "This citation relationship was added manually in Citation Map.",
  "publication-type": "Publication type reported by the scholarly-data source.",
})) {
  PROPERTY_DEFINITIONS.set(label, definition);
}

function propertyDefinition(label: string): string | null {
  return PROPERTY_DEFINITIONS.get(normalizedPropertyLabel(label)) ?? null;
}

function elementTagName(element: Element): string {
  return String(element.localName || element.tagName || "").toLocaleLowerCase();
}

function rowFromPath(path: HTMLElement[]): {
  entry: HTMLElement;
  term: HTMLElement;
  value: HTMLElement;
  label: string;
  isLabel: boolean;
} | null {
  const entry = path.find((candidate) => {
    const tag = elementTagName(candidate);
    return tag === "dt" || tag === "dd";
  });
  if (!entry?.closest(".citation-map-pane-metrics, .cm-metric-list")) {
    return null;
  }
  const isLabel = elementTagName(entry) === "dt";
  const term = (
    isLabel ? entry : entry.previousElementSibling
  ) as HTMLElement | null;
  const value = (
    !isLabel ? entry : entry.nextElementSibling
  ) as HTMLElement | null;
  if (
    !term ||
    !value ||
    elementTagName(term) !== "dt" ||
    elementTagName(value) !== "dd"
  ) {
    return null;
  }
  const label = String(term.textContent ?? "").trim();
  return label ? { entry, term, value, label, isLabel } : null;
}

function selectedRelationshipDirection(
  element: Element,
): "references" | "cited-by" | null {
  const root =
    element.closest(".citation-map-item-pane") ??
    element.closest(".cm-detail-panel") ??
    element.ownerDocument;
  const selected = root.querySelector(
    ".citation-map-pane-tabs button[data-selected='true'], " +
      ".cm-detail-tabs button[data-selected='true']",
  );
  const text = String(selected?.textContent ?? "").toLocaleLowerCase();
  if (text.includes("reference")) return "references";
  if (text.includes("cited")) return "cited-by";
  return null;
}

function providerFromCard(card: Element): DataSourceID | null {
  const text = String(card.textContent ?? "").toLocaleLowerCase();
  if (text.includes("semantic scholar")) return "semantic-scholar";
  if (text.includes("openalex")) return "openalex";
  if (text.includes("opencitations")) return "opencitations";
  if (text.includes("inspire")) return "inspire";
  if (text.includes("crossref")) return "crossref";
  if (text.includes("manual")) return "manual";
  return null;
}

function cardDOI(card: Element): string | null {
  for (const link of card.querySelectorAll("a")) {
    const href = String((link as HTMLAnchorElement).href ?? "");
    const match = href.match(/doi\.org\/(.+)$/i);
    if (!match) continue;
    const decoded = decodeURIComponent(match[1]);
    const normalized = normalizeDOI(decoded);
    if (normalized) return normalized;
  }
  return null;
}

function cardWork(
  document: Document,
  card: Element,
): {
  work: RelatedWorkMetadata | null;
  updatedAt: string | null;
  node: CitationGraphNode | null;
} {
  const context = graphNodeForElement(document, card);
  if (!context) return { work: null, updatedAt: null, node: null };
  const direction = selectedRelationshipDirection(card);
  if (!direction) {
    return {
      work: null,
      updatedAt: context.node.metricsUpdatedAt,
      node: context.node,
    };
  }
  const entry = getStoredRelationshipEntry(context.node, direction);
  const title = normalizeExactTitle(
    card.querySelector("h3, h4")?.textContent ?? "",
  );
  const doi = cardDOI(card);
  const work =
    entry?.works.find((candidate) => {
      const candidateDOI = normalizeDOI(candidate.doi);
      if (doi && candidateDOI === doi) return true;
      return Boolean(title && normalizeExactTitle(candidate.title) === title);
    }) ?? null;
  return {
    work,
    updatedAt: latestTimestamp(entry?.fetchedAt, context.node.metricsUpdatedAt),
    node: context.node,
  };
}

function storedTitle(element: HTMLElement): string | null {
  const stored = element.dataset.citationMapOriginalTitle;
  if (stored) return stored;
  const current = element.getAttribute("title");
  if (!current) return null;
  element.dataset.citationMapOriginalTitle = current;
  element.removeAttribute("title");
  return current;
}

function citationColumnKey(cell: HTMLElement): string | null {
  for (const metric of METRIC_DEFINITIONS) {
    if (metric.column && cell.classList.contains(metric.id)) return metric.id;
  }
  for (const key of SUPPLEMENTARY_PROPERTY_DEFINITIONS.map(
    (property) => property.id,
  )) {
    if (cell.classList.contains(key)) return key;
  }
  return null;
}

function columnDefinition(key: string): string | null {
  const metric = METRIC_DEFINITIONS.find((candidate) => candidate.id === key);
  if (metric) return metricTooltip(metric.id);
  const supplementary = SUPPLEMENTARY_PROPERTY_DEFINITIONS.find(
    (candidate) => candidate.id === key,
  );
  return supplementary?.description ?? null;
}

interface ResolvedTooltip {
  target: HTMLElement;
  text: string;
}

function resolveRowTooltip(
  document: Document,
  path: HTMLElement[],
): ResolvedTooltip | null {
  const row = rowFromPath(path);
  if (!row) return null;
  if (row.isLabel) {
    const definition = propertyDefinition(row.label) ?? storedTitle(row.term);
    return definition ? { target: row.term, text: definition } : null;
  }
  const context = graphNodeForElement(document, row.value);
  if (!context) return null;
  return {
    target: row.value,
    text: nodeFieldDataSourceTooltip(context.node, row.label, context.item),
  };
}

function resolveColumnTooltip(path: HTMLElement[]): ResolvedTooltip | null {
  const cell = path.find((candidate) => candidate.classList?.contains("cell"));
  if (!cell) return null;
  const key = citationColumnKey(cell);
  const isHeader = path.some((candidate) =>
    candidate.classList?.contains("virtualized-table-header"),
  );
  if (isHeader && key) {
    const definition = columnDefinition(key) ?? storedTitle(cell);
    return definition ? { target: cell, text: definition } : null;
  }
  const title = storedTitle(cell);
  return title?.startsWith("Sources:") ? { target: cell, text: title } : null;
}

function resolveExternalCardTooltip(
  document: Document,
  path: HTMLElement[],
): ResolvedTooltip | null {
  if (path.some((candidate) => elementTagName(candidate) === "button")) {
    return null;
  }
  const card = path.find(
    (candidate) =>
      candidate.classList?.contains("citation-map-relation-card") ||
      candidate.classList?.contains("cm-external-card"),
  );
  if (!card) return null;
  const dataElement = path.find((candidate) =>
    ["h3", "h4", "p", "a", "summary", "span"].includes(
      elementTagName(candidate),
    ),
  );
  if (!dataElement || !card.contains(dataElement)) return null;
  const resolved = cardWork(document, card);
  const text = resolved.work
    ? externalWorkDataSourceTooltip(resolved.work, resolved.updatedAt)
    : dataSourceTooltip(
        [providerFromCard(card) ?? resolved.node?.provider ?? null],
        resolved.updatedAt,
      );
  return { target: dataElement, text };
}

function resolveBadgeTooltip(
  document: Document,
  path: HTMLElement[],
): ResolvedTooltip | null {
  const badge = path.find((candidate) =>
    candidate.closest?.(".citation-map-pane-badges, .cm-badges"),
  );
  if (!badge) return null;
  const label = String(badge.textContent ?? "").trim();
  const definition = propertyDefinition(label);
  if (!definition) return null;
  const context = graphNodeForElement(document, badge);
  if (label === "Top 1%" || label === "Top 10%") {
    return {
      target: badge,
      text: `${definition}\nSources: OpenAlex\nLast update: ${formatUpdate(
        context?.node.metricsUpdatedAt,
      )}`,
    };
  }
  return { target: badge, text: definition };
}

function resolveTooltip(
  document: Document,
  event: Event,
): ResolvedTooltip | null {
  const path = elementPath(event);
  return (
    resolveRowTooltip(document, path) ??
    resolveColumnTooltip(path) ??
    resolveBadgeTooltip(document, path) ??
    resolveExternalCardTooltip(document, path)
  );
}

function createTooltip(document: Document): HTMLElement {
  const tooltip = document.createElementNS(HTML_NS, "div");
  tooltip.id = "citation-map-central-tooltip";
  tooltip.setAttribute("role", "tooltip");
  Object.assign(tooltip.style, {
    position: "fixed",
    display: "none",
    maxWidth: "420px",
    padding: "7px 9px",
    borderRadius: "5px",
    border: "1px solid color-mix(in srgb, currentColor 28%, transparent)",
    background: "Canvas",
    color: "CanvasText",
    boxShadow: "0 3px 12px rgba(0, 0, 0, 0.35)",
    fontSize: "12px",
    lineHeight: "1.35",
    whiteSpace: "pre-line",
    pointerEvents: "none",
    zIndex: "2147483647",
  });
  return tooltip;
}

function tooltipHost(
  document: Document,
  target: HTMLElement,
): ParentNode & Node {
  const root = target.getRootNode();
  if (root !== document && "appendChild" in root) {
    return root as ParentNode & Node;
  }
  const paneRoot =
    target.closest(".cm-root, .citation-map-root") ??
    target.closest(".citation-map-item-pane") ??
    target.closest(".cm-detail-panel");
  return (
    paneRoot ??
    document.body ??
    target.parentElement ??
    document.documentElement
  );
}

function attachTooltipToTarget(
  document: Document,
  tooltip: HTMLElement,
  target: HTMLElement,
): void {
  const host = tooltipHost(document, target);
  if (tooltip.parentNode !== host) host.appendChild(tooltip);
}

function positionTooltip(
  document: Document,
  handlers: DocumentTooltipHandlers,
  target: HTMLElement,
  x?: number,
  y?: number,
): void {
  const view = document.defaultView;
  if (!view) return;
  const rect = target.getBoundingClientRect();
  const requestedX = x ?? rect.left + Math.min(rect.width, 20);
  const requestedY = y ?? rect.bottom;
  const margin = 8;
  const offset = 12;
  const width = handlers.tooltip.offsetWidth || 240;
  const height = handlers.tooltip.offsetHeight || 52;
  const left = Math.max(
    margin,
    Math.min(requestedX + offset, view.innerWidth - width - margin),
  );
  const below = requestedY + offset;
  const top =
    below + height <= view.innerHeight - margin
      ? below
      : Math.max(margin, requestedY - height - offset);
  handlers.tooltip.style.left = `${left}px`;
  handlers.tooltip.style.top = `${top}px`;
}

function showTooltip(
  document: Document,
  handlers: DocumentTooltipHandlers,
  resolved: ResolvedTooltip,
  event?: MouseEvent,
): void {
  resolved.target.dataset.citationMapTooltip = resolved.text;
  const currentTitle = resolved.target.getAttribute("title");
  if (currentTitle) {
    resolved.target.dataset.citationMapOriginalTitle ??= currentTitle;
    resolved.target.removeAttribute("title");
  }
  attachTooltipToTarget(document, handlers.tooltip, resolved.target);
  handlers.currentTarget = resolved.target;
  handlers.tooltip.textContent = resolved.text;
  handlers.tooltip.style.display = "block";
  handlers.tooltip.style.visibility = "hidden";
  if (event) {
    handlers.lastX = event.clientX;
    handlers.lastY = event.clientY;
  }
  positionTooltip(
    document,
    handlers,
    resolved.target,
    event?.clientX,
    event?.clientY,
  );
  handlers.tooltip.style.visibility = "visible";
}

function hideTooltip(handlers: DocumentTooltipHandlers): void {
  handlers.currentTarget = null;
  handlers.tooltip.style.display = "none";
}

function createPaneRow(
  document: Document,
  label: string,
  value: string,
): [HTMLElement, HTMLElement] {
  const term = document.createElementNS(HTML_NS, "dt") as HTMLElement;
  const data = document.createElementNS(HTML_NS, "dd") as HTMLElement;
  term.textContent = label;
  data.textContent = value;
  return [term, data];
}

function supplementaryDisplay(node: CitationGraphNode, id: string): string {
  const property = SUPPLEMENTARY_PROPERTY_DEFINITIONS.find(
    (candidate) => candidate.id === id,
  );
  if (!property) return "—";
  const value = property.value(node);
  return value === null || value === undefined || value === ""
    ? "—"
    : property.format(value);
}

function enhanceMetricPanel(document: Document, rows: HTMLElement): void {
  // Only enhance the root Overview list. Advanced/Data-details lists use the
  // same CSS classes and must never be enhanced recursively.
  if (rows.closest("details")) return;
  if (rows.dataset.citationMapRegistryEnhanced === "true") return;
  const context = graphNodeForElement(document, rows);
  if (!context) return;
  rows.dataset.citationMapRegistryEnhanced = "true";
  const node = context.node;
  const isItemPane = rows.classList.contains("citation-map-pane-metrics");
  const main = new Set(["citations", "references"]);
  const labels = new Set<string>();
  for (const termNode of Array.from(rows.querySelectorAll("dt"))) {
    const term = termNode as HTMLElement;
    labels.add(normalizedPropertyLabel(term.textContent ?? ""));
  }

  let details: HTMLDetailsElement | null = null;
  if (isItemPane) {
    const sibling = rows.nextElementSibling;
    details = sibling?.matches("details.citation-map-data-details")
      ? (sibling as HTMLDetailsElement)
      : null;
  }
  if (!details) {
    details = document.createElementNS(
      HTML_NS,
      "details",
    ) as HTMLDetailsElement;
    details.className = isItemPane
      ? "citation-map-data-details"
      : "cm-advanced-details";
    const summary = document.createElementNS(HTML_NS, "summary");
    summary.textContent = "Advanced";
    details.appendChild(summary);
    rows.after(details);
  } else {
    const summary = details.querySelector("summary");
    if (summary) summary.textContent = "Advanced";
  }
  let advanced = details.querySelector("dl") as HTMLElement | null;
  if (!advanced) {
    advanced = document.createElementNS(HTML_NS, "dl") as HTMLElement;
    advanced.className = rows.className;
    details.appendChild(advanced);
  }
  advanced.dataset.citationMapRegistryAdvanced = "true";

  const terms = Array.from(rows.querySelectorAll("dt"));
  for (const termNode of terms) {
    const term = termNode as HTMLElement;
    const value = term.nextElementSibling;
    if (!value || elementTagName(value) !== "dd") continue;
    const key = normalizedPropertyLabel(term.textContent ?? "");
    if (main.has(key)) continue;
    if (
      [
        "provider",
        "canonical-provider",
        "citation-provider",
        "match-confidence",
      ].includes(key)
    ) {
      term.remove();
      value.remove();
      continue;
    }
    if (key === "citation-rate") term.textContent = "Recent citation rate";
    if (key === "citation-acceleration")
      term.textContent = "Change in annual citations";
    if (key === "updated") term.textContent = "Last update";
    advanced.append(term, value);
  }

  for (const metric of METRIC_DEFINITIONS) {
    if (metric.itemPane !== "advanced") continue;
    const aliases = [metric.id, metric.label, metric.shortLabel ?? ""].map(
      normalizedPropertyLabel,
    );
    if (aliases.some((alias) => labels.has(alias))) continue;
    const raw = metric.value(node);
    const formatted = formatMetricValue(metric.id, raw);
    advanced.append(...createPaneRow(document, metric.label, formatted));
  }
  for (const property of SUPPLEMENTARY_PROPERTY_DEFINITIONS) {
    if (property.itemPane !== "advanced") continue;
    const aliases = [property.id, property.label].map(normalizedPropertyLabel);
    if (aliases.some((alias) => labels.has(alias))) continue;
    advanced.append(
      ...createPaneRow(
        document,
        property.label,
        supplementaryDisplay(node, property.id),
      ),
    );
  }

  for (const termNode of Array.from(advanced.querySelectorAll("dt"))) {
    const term = termNode as HTMLElement;
    const key = normalizedPropertyLabel(term.textContent ?? "");
    const value = term.nextElementSibling;
    if (!value || elementTagName(value) !== "dd") continue;
    if (
      [
        "provider",
        "canonical-provider",
        "citation-provider",
        "match-confidence",
        "match-status",
      ].includes(key)
    ) {
      term.remove();
      value.remove();
    } else if (key === "matched-by") {
      term.textContent = "Match method";
    } else if (key === "updated") {
      term.textContent = "Last update";
    }
  }
}

function styleOpenAccessBadges(document: Document): void {
  for (const badgeNode of Array.from(
    document.querySelectorAll(
      ".citation-map-pane-badges span, .cm-badges span",
    ),
  )) {
    const element = badgeNode as HTMLElement;
    if (String(element.textContent ?? "").trim() !== "Open Access") continue;
    const context = graphNodeForElement(document, element);
    const status = String(context?.node.openAccessStatus ?? "open")
      .trim()
      .toLocaleLowerCase();
    const palette: Record<string, [string, string]> = {
      gold: ["#c99700", "#1f1600"],
      diamond: ["#8ad8e8", "#07333c"],
      hybrid: ["#c0c0c0", "#202020"],
      green: ["#69b96b", "#08290a"],
      bronze: ["#b97842", "#241207"],
    };
    const selected = palette[status];
    if (selected) {
      element.style.backgroundColor = selected[0];
      element.style.color = selected[1];
    }
    element.dataset.citationMapOaStatus = status;
  }
}

const METRIC_PANEL_SELECTOR = "dl.citation-map-pane-metrics, dl.cm-metric-list";
const BADGE_SELECTOR = ".citation-map-pane-badges, .cm-badges";

function enhancePropertyPanels(document: Document): void {
  for (const rows of Array.from(
    document.querySelectorAll(METRIC_PANEL_SELECTOR),
  )) {
    const panel = rows as HTMLElement;
    if (panel.closest("details")) continue;
    enhanceMetricPanel(document, panel);
  }
  styleOpenAccessBadges(document);
}

function mutationTouchesPropertyUI(mutation: MutationRecord): boolean {
  const candidates: Node[] = [mutation.target];
  for (const candidate of Array.from(mutation.addedNodes)) {
    if (candidate) candidates.push(candidate);
  }
  for (const candidate of candidates) {
    const element =
      candidate.nodeType === 1
        ? (candidate as Element)
        : candidate.parentElement;
    if (!element) continue;
    if (
      element.matches(METRIC_PANEL_SELECTOR) ||
      element.matches(BADGE_SELECTOR) ||
      Boolean(element.closest(METRIC_PANEL_SELECTOR)) ||
      Boolean(element.closest(BADGE_SELECTOR)) ||
      Boolean(element.querySelector(METRIC_PANEL_SELECTOR)) ||
      Boolean(element.querySelector(BADGE_SELECTOR))
    ) {
      return true;
    }
  }
  return false;
}

export function installDataSourceHoverTooltips(document: Document): void {
  if (documentHandlers.has(document)) return;
  const handlers = {} as DocumentTooltipHandlers;
  handlers.tooltip = createTooltip(document);
  handlers.currentTarget = null;
  handlers.lastX = 0;
  handlers.lastY = 0;
  handlers.observer = null;
  handlers.mouseover = (event) => {
    const resolved = resolveTooltip(document, event);
    if (resolved) {
      showTooltip(document, handlers, resolved, event as MouseEvent);
    } else hideTooltip(handlers);
  };
  handlers.mousemove = (event) => {
    if (!handlers.currentTarget) return;
    const mouse = event as MouseEvent;
    handlers.lastX = mouse.clientX;
    handlers.lastY = mouse.clientY;
    positionTooltip(
      document,
      handlers,
      handlers.currentTarget,
      handlers.lastX,
      handlers.lastY,
    );
  };
  handlers.mouseout = (event) => {
    if (!handlers.currentTarget) return;
    const related = (event as MouseEvent).relatedTarget as Node | null;
    if (related && handlers.currentTarget.contains(related)) return;
    hideTooltip(handlers);
  };
  handlers.focusin = (event) => {
    const resolved = resolveTooltip(document, event);
    if (resolved) showTooltip(document, handlers, resolved);
  };
  handlers.focusout = () => hideTooltip(handlers);
  handlers.keydown = (event) => {
    if ((event as KeyboardEvent).key === "Escape") hideTooltip(handlers);
  };
  document.addEventListener("mouseover", handlers.mouseover, true);
  document.addEventListener("mousemove", handlers.mousemove, true);
  document.addEventListener("mouseout", handlers.mouseout, true);
  document.addEventListener("focusin", handlers.focusin, true);
  document.addEventListener("focusout", handlers.focusout, true);
  document.addEventListener("keydown", handlers.keydown, true);
  enhancePropertyPanels(document);
  const Observer = document.defaultView?.MutationObserver;
  if (Observer) {
    let queued = false;
    handlers.observer = new Observer((mutations) => {
      if (queued || !mutations.some(mutationTouchesPropertyUI)) return;
      queued = true;
      document.defaultView?.queueMicrotask(() => {
        queued = false;
        enhancePropertyPanels(document);
      });
    });
    handlers.observer.observe(document, { childList: true, subtree: true });
  }
  documentHandlers.set(document, handlers);
}

export function uninstallDataSourceHoverTooltips(document: Document): void {
  const handlers = documentHandlers.get(document);
  if (!handlers) return;
  document.removeEventListener("mouseover", handlers.mouseover, true);
  document.removeEventListener("mousemove", handlers.mousemove, true);
  document.removeEventListener("mouseout", handlers.mouseout, true);
  document.removeEventListener("focusin", handlers.focusin, true);
  document.removeEventListener("focusout", handlers.focusout, true);
  document.removeEventListener("keydown", handlers.keydown, true);
  handlers.observer?.disconnect();
  handlers.tooltip.remove();
  for (const node of Array.from(
    document.querySelectorAll("[data-citation-map-original-title]"),
  )) {
    const element = node as HTMLElement;
    const title = element.dataset.citationMapOriginalTitle;
    if (title) element.setAttribute("title", title);
    delete element.dataset.citationMapOriginalTitle;
    delete element.dataset.citationMapTooltip;
  }
  documentHandlers.delete(document);
}
