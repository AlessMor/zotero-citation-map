/// <reference lib="dom" />

import { config } from "../../package.json";
import type {
  CitationGraphNode,
  GraphAxisMetric,
  GraphLayoutOptions,
  GraphNodeLabelMode,
  GraphNodeSizeMetric,
  GraphScaleType,
} from "../domain/graphTypes";
import type {
  LibraryCollectionFilter,
  LibrarySnapshot,
  ZoteroPaper,
} from "../domain/types";
import { buildCitationGraph } from "./citationGraphService";
import { CitationGraphRenderer } from "./citationGraphRenderer";
import {
  getExternalCitedBy,
  getExternalReferences,
  getMissingPaperRecommendations,
  importExternalWork,
  type ExternalWork,
} from "./externalDiscoveryService";
import {
  formatGraphMetricValue,
  GRAPH_AXIS_OPTIONS,
  graphMetricLabel,
  graphMetricSupportsLog,
} from "./graphMetricDefinitions";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const styledDocuments = new WeakSet<Document>();
const cleanupByMount = new WeakMap<Element, () => void>();
const NODE_SIZE_PREF = `${config.prefsPrefix}.nodeSizeMetric`;
const NODE_LABEL_PREF = `${config.prefsPrefix}.nodeLabelMode`;

export type GraphViewMode = "tab" | "window";

export interface GraphViewOptions {
  mode: GraphViewMode;
  onSelectPaper: (itemID: number) => void | Promise<void>;
}

function createHTMLElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tagName: K,
): HTMLElementTagNameMap[K] {
  return document.createElementNS(
    HTML_NAMESPACE,
    tagName,
  ) as HTMLElementTagNameMap[K];
}

function createGraphControlIcon(
  document: Document,
  kind: "zoom-in" | "zoom-out" | "fit",
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const appendShape = (
    tagName: "circle" | "path",
    attributes: Record<string, string>,
  ): void => {
    const shape = document.createElementNS(SVG_NAMESPACE, tagName);
    for (const [name, value] of Object.entries(attributes)) {
      shape.setAttribute(name, value);
    }
    shape.setAttribute("fill", "none");
    shape.setAttribute("stroke", "currentColor");
    svg.appendChild(shape);
  };

  if (kind === "fit") {
    appendShape("circle", { cx: "12", cy: "12", r: "6.5" });
    appendShape("circle", { cx: "12", cy: "12", r: "2" });
    appendShape("path", { d: "M12 2v3M12 19v3M2 12h3M19 12h3" });
    return svg;
  }

  appendShape("circle", { cx: "10.5", cy: "10.5", r: "5.5" });
  appendShape("path", { d: "M14.5 14.5 20 20" });
  appendShape("path", { d: "M7.5 10.5h6" });
  if (kind === "zoom-in") {
    appendShape("path", { d: "M10.5 7.5v6" });
  }
  return svg;
}

function clearElement(element: Element): void {
  while (element.firstChild) {
    element.firstChild.remove();
  }
}

function ensureGraphStyle(document: Document): void {
  if (styledDocuments.has(document)) {
    return;
  }

  const stylesheetURL = `chrome://${config.addonRef}/content/graph.css`;

  if (document.head) {
    const link = createHTMLElement(document, "link");
    link.rel = "stylesheet";
    link.href = stylesheetURL;
    document.head.appendChild(link);
  } else {
    const processingInstruction = document.createProcessingInstruction(
      "xml-stylesheet",
      `href="${stylesheetURL}" type="text/css"`,
    );

    document.insertBefore(processingInstruction, document.documentElement);
  }

  styledDocuments.add(document);
}

function createTextElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tagName: K,
  text: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = createHTMLElement(document, tagName);
  element.textContent = text;

  if (className) {
    element.className = className;
  }

  return element;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function createStatisticsSummary(snapshot: LibrarySnapshot): string {
  const statistics = snapshot.statistics;

  return [
    `${formatCount(statistics.totalPapers)} papers`,
    `${formatCount(statistics.withoutYear)} without year`,
    `${formatCount(statistics.withoutDOI)} without DOI`,
    `${formatCount(statistics.withoutCitationData)} missing citation data`,
    `${formatCount(statistics.withoutReferenceData)} missing reference data`,
  ].join(" · ");
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
}

function getFallbackSearchText(paper: ZoteroPaper): string {
  return normalizeSearchText(
    [
      paper.title,
      paper.authors.join(" "),
      paper.doi ?? "",
      paper.tags.join(" "),
      String(paper.year ?? ""),
    ].join(" "),
  );
}

function fallbackSearch(query: string, papers: ZoteroPaper[]): number[] {
  const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return papers.map((paper) => paper.itemID);
  }

  return papers
    .filter((paper) => {
      const text = getFallbackSearchText(paper);
      return tokens.every((token) => text.includes(token));
    })
    .map((paper) => paper.itemID);
}

async function runZoteroSearch(
  query: string,
  snapshot: LibrarySnapshot,
): Promise<number[]> {
  const allowedItemIDs = new Set(snapshot.papers.map((paper) => paper.itemID));

  try {
    const search = new Zotero.Search();
    Reflect.set(search, "libraryID", snapshot.libraryID);
    search.addCondition("quicksearch-fields", "contains", query);

    const itemIDs = await search.search();

    return itemIDs
      .map((itemID: string | number) => Number(itemID))
      .filter((itemID: number) => allowedItemIDs.has(itemID));
  } catch (error) {
    Zotero.debug(
      `Citation Map: Zotero search failed, using local fallback: ${error}`,
    );
    return fallbackSearch(query, snapshot.papers);
  }
}

function createOption(
  document: Document,
  value: string,
  label: string,
): HTMLOptionElement {
  const option = createHTMLElement(document, "option");
  option.value = value;
  option.textContent = label;
  return option;
}

function createLabelledSelect(
  document: Document,
  labelText: string,
  className: string,
): { wrapper: HTMLLabelElement; select: HTMLSelectElement } {
  const wrapper = createHTMLElement(document, "label");
  wrapper.className = `cm-control ${className}`;
  wrapper.appendChild(
    createTextElement(document, "span", labelText, "cm-control-label"),
  );
  const select = createHTMLElement(document, "select");
  select.className = "cm-select";
  wrapper.appendChild(select);
  return { wrapper, select };
}

function createCheckbox(
  document: Document,
  labelText: string,
  checked: boolean,
): { wrapper: HTMLLabelElement; input: HTMLInputElement } {
  const wrapper = createHTMLElement(document, "label");
  wrapper.className = "cm-checkbox-control";
  const input = createHTMLElement(document, "input");
  input.type = "checkbox";
  input.checked = checked;
  wrapper.appendChild(input);
  wrapper.appendChild(createTextElement(document, "span", labelText));
  return { wrapper, input };
}

const COLLECTION_PALETTE = [
  "#4c78a8",
  "#f58518",
  "#54a24b",
  "#e45756",
  "#72b7b2",
  "#b279a2",
  "#ff9da6",
  "#9d755d",
  "#bab0ac",
  "#7f6db0",
  "#2f9c95",
  "#d68c45",
];

const UNFILED_COLOR = "#8b8f98";

interface AxisPicker {
  root: HTMLDivElement;
  button: HTMLButtonElement;
  popover: HTMLDivElement;
  getMetric: () => GraphAxisMetric;
  getScale: () => GraphScaleType;
  setOpen: (open: boolean) => void;
  isOpen: () => boolean;
  onChange: (listener: () => void) => void;
}

interface CollectionVisuals {
  colorByNodeKey: Map<string, string>;
  labelByNodeKey: Map<string, string>;
}

function readNodeSizeMetric(): GraphNodeSizeMetric {
  const value = Zotero.Prefs.get(NODE_SIZE_PREF, true);
  return value === "uniform" || value === "references" ? value : "citations";
}

function readNodeLabelMode(): GraphNodeLabelMode {
  const value = Zotero.Prefs.get(NODE_LABEL_PREF, true);
  return value === "author-year" ? "author-year" : "title";
}

function scaleLabel(scale: GraphScaleType): string {
  return scale === "log" ? "Log" : "Linear";
}

function createAxisPicker(
  document: Document,
  orientation: "x" | "y",
): AxisPicker {
  const root = createHTMLElement(document, "div");
  root.className = `cm-axis-picker cm-${orientation}-axis-picker`;

  const button = createHTMLElement(document, "button");
  button.type = "button";
  button.className = "cm-axis-label-button";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  root.appendChild(button);

  const metricText = createHTMLElement(document, "span");
  metricText.className = "cm-axis-label-metric";
  const scaleText = createHTMLElement(document, "span");
  scaleText.className = "cm-axis-label-scale";
  const chevron = createHTMLElement(document, "span");
  chevron.className = "cm-axis-label-chevron";
  chevron.textContent = "⌄";
  chevron.setAttribute("aria-hidden", "true");
  button.append(metricText, scaleText, chevron);

  const popover = createHTMLElement(document, "div");
  popover.className = "cm-axis-popover";
  popover.hidden = true;
  popover.setAttribute("role", "dialog");
  popover.setAttribute(
    "aria-label",
    `${orientation.toUpperCase()} axis options`,
  );
  root.appendChild(popover);

  popover.appendChild(
    createTextElement(
      document,
      "div",
      `${orientation.toUpperCase()} axis`,
      "cm-axis-popover-title",
    ),
  );
  popover.appendChild(
    createTextElement(
      document,
      "div",
      "Position",
      "cm-axis-popover-section-title",
    ),
  );

  let metric: GraphAxisMetric = "none";
  let scale: GraphScaleType = "linear";
  let changeListener: (() => void) | null = null;
  const metricButtons = new Map<GraphAxisMetric, HTMLButtonElement>();
  const scaleButtons = new Map<GraphScaleType, HTMLButtonElement>();

  const metricList = createHTMLElement(document, "div");
  metricList.className = "cm-axis-option-list";
  let currentGroup = "";
  for (const definition of GRAPH_AXIS_OPTIONS) {
    if (definition.group !== currentGroup) {
      currentGroup = definition.group;
      metricList.appendChild(
        createTextElement(
          document,
          "div",
          currentGroup,
          "cm-axis-option-group",
        ),
      );
    }

    const option = createHTMLElement(document, "button");
    option.type = "button";
    option.className = "cm-axis-option";
    option.textContent = definition.label;
    option.dataset.value = definition.metric;
    option.addEventListener("click", () => {
      metric = definition.metric;
      if (!graphMetricSupportsLog(metric)) {
        scale = "linear";
      }
      updateDisplay();
      changeListener?.();
    });
    metricButtons.set(definition.metric, option);
    metricList.appendChild(option);
  }
  popover.appendChild(metricList);

  const scaleSection = createHTMLElement(document, "div");
  scaleSection.className = "cm-axis-scale-section";
  scaleSection.appendChild(
    createTextElement(
      document,
      "div",
      "Scale",
      "cm-axis-popover-section-title",
    ),
  );
  const scaleList = createHTMLElement(document, "div");
  scaleList.className = "cm-axis-scale-options";
  for (const [value, label] of [
    ["linear", "Linear"],
    ["log", "Logarithmic"],
  ] as Array<[GraphScaleType, string]>) {
    const option = createHTMLElement(document, "button");
    option.type = "button";
    option.className = "cm-axis-option cm-axis-scale-option";
    option.textContent = label;
    option.dataset.value = value;
    option.addEventListener("click", () => {
      if (value === "log" && !graphMetricSupportsLog(metric)) {
        return;
      }
      scale = value;
      updateDisplay();
      changeListener?.();
    });
    scaleButtons.set(value, option);
    scaleList.appendChild(option);
  }
  scaleSection.appendChild(scaleList);
  popover.appendChild(scaleSection);

  const updateDisplay = (): void => {
    metricText.textContent = graphMetricLabel(metric);
    scaleText.textContent = metric === "none" ? "" : scaleLabel(scale);
    scaleText.hidden = metric === "none";
    for (const [value, option] of metricButtons) {
      option.dataset.selected = String(value === metric);
      option.setAttribute("aria-pressed", String(value === metric));
    }
    const supportsLog = graphMetricSupportsLog(metric);
    for (const [value, option] of scaleButtons) {
      option.dataset.selected = String(value === scale);
      option.setAttribute("aria-pressed", String(value === scale));
      option.disabled = metric === "none" || (value === "log" && !supportsLog);
    }
    scaleSection.dataset.disabled = String(metric === "none");
  };

  const setOpen = (open: boolean): void => {
    popover.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    root.dataset.open = String(open);
  };

  button.addEventListener("click", () => setOpen(popover.hidden));
  updateDisplay();

  return {
    root,
    button,
    popover,
    getMetric: () => metric,
    getScale: () => scale,
    setOpen,
    isOpen: () => !popover.hidden,
    onChange: (listener) => {
      changeListener = listener;
    },
  };
}

function collectionDepth(path: string): number {
  return path.split(/\s*(?:\/|›|>)\s*/).filter(Boolean).length;
}

function buildCollectionVisuals(
  snapshot: LibrarySnapshot,
  nodes: CitationGraphNode[],
): CollectionVisuals {
  const collectionsByID = new Map(
    snapshot.collections.map((collection) => [
      collection.collectionID,
      collection,
    ]),
  );
  const topLevelCollections = snapshot.collections
    .filter((collection) => collectionDepth(collection.path) === 1)
    .sort((left, right) => left.path.localeCompare(right.path));
  const colorByCollectionID = new Map<number, string>();
  topLevelCollections.forEach((collection, index) => {
    colorByCollectionID.set(
      collection.collectionID,
      COLLECTION_PALETTE[index % COLLECTION_PALETTE.length],
    );
  });

  const colorByNodeKey = new Map<string, string>();
  const labelByNodeKey = new Map<string, string>();

  for (const node of nodes) {
    const directCollections = node.collectionIDs
      .map((collectionID) => collectionsByID.get(collectionID))
      .filter((collection): collection is LibraryCollectionFilter =>
        Boolean(collection),
      )
      .sort((left, right) => left.path.localeCompare(right.path));

    const topLevelMatches = topLevelCollections.filter((topLevel) =>
      node.collectionIDs.some((collectionID) =>
        topLevel.includedCollectionIDs.includes(collectionID),
      ),
    );
    const primary = topLevelMatches[0] ?? directCollections[0] ?? null;
    const color = primary
      ? (colorByCollectionID.get(primary.collectionID) ??
        COLLECTION_PALETTE[
          hashCollection(primary.path) % COLLECTION_PALETTE.length
        ])
      : UNFILED_COLOR;
    const label =
      directCollections.length > 0
        ? directCollections.map((collection) => collection.path).join(" · ")
        : "Unfiled";

    colorByNodeKey.set(node.key, color);
    labelByNodeKey.set(node.key, label);
  }

  return {
    colorByNodeKey,
    labelByNodeKey,
  };
}

function hashCollection(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function collectionMatches(
  node: CitationGraphNode,
  collection: LibraryCollectionFilter | null,
): boolean {
  if (!collection) {
    return true;
  }

  const includedIDs = new Set(collection.includedCollectionIDs);
  return node.collectionIDs.some((collectionID) =>
    includedIDs.has(collectionID),
  );
}

function createDetailRow(
  document: Document,
  label: string,
  value: string,
): HTMLDivElement {
  const row = createHTMLElement(document, "div");
  row.className = "cm-detail-row";
  row.appendChild(
    createTextElement(document, "span", label, "cm-detail-label"),
  );
  row.appendChild(
    createTextElement(document, "span", value, "cm-detail-value"),
  );
  return row;
}

function formatNullableMetric(
  metric: GraphAxisMetric,
  value: number | null,
): string {
  return value === null ? "—" : formatGraphMetricValue(metric, value);
}

function downloadTextFile(
  document: Document,
  filename: string,
  content: string,
  mimeType: string,
): void {
  const view = document.defaultView;
  if (!view) return;
  const blob = new view.Blob([content], { type: mimeType });
  const url = view.URL.createObjectURL(blob);
  const anchor = createHTMLElement(document, "a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.documentElement.appendChild(anchor);
  anchor.click();
  anchor.remove();
  view.setTimeout(() => view.URL.revokeObjectURL(url), 1000);
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportGraphJSON(
  document: Document,
  snapshot: LibrarySnapshot,
  graph: ReturnType<typeof buildCitationGraph>,
): void {
  downloadTextFile(
    document,
    `citation-map-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(
      {
        format: "zotero-citation-map",
        version: 1,
        exportedAt: new Date().toISOString(),
        library: { id: snapshot.libraryID, name: snapshot.libraryName },
        nodes: graph.nodes,
        edges: graph.edges,
      },
      null,
      2,
    ),
    "application/json",
  );
}

function exportGraphCSV(
  document: Document,
  graph: ReturnType<typeof buildCitationGraph>,
): void {
  const nodeByKey = new Map(graph.nodes.map((node) => [node.key, node]));
  const lines = [
    ["source_key", "source_title", "target_key", "target_title"].join(","),
    ...graph.edges.map((edge) => {
      const source = nodeByKey.get(edge.source);
      const target = nodeByKey.get(edge.target);
      return [
        edge.source,
        source?.title ?? "",
        edge.target,
        target?.title ?? "",
      ]
        .map(csvCell)
        .join(",");
    }),
  ];
  downloadTextFile(
    document,
    `citation-map-edges-${new Date().toISOString().slice(0, 10)}.csv`,
    lines.join("\n"),
    "text/csv;charset=utf-8",
  );
}

async function importGraphJSON(
  document: Document,
  snapshot: LibrarySnapshot,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const input = createHTMLElement(document, "input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.hidden = true;
    document.documentElement.appendChild(input);
    input.addEventListener(
      "change",
      async () => {
        try {
          const file = input.files?.[0];
          if (!file) {
            resolve(0);
            return;
          }
          const parsed = JSON.parse(await file.text()) as {
            nodes?: Array<{
              doi?: string | null;
              title?: string;
              providerWorkID?: string;
            }>;
          };
          const localDOIs = new Set(
            snapshot.papers
              .map((paper) => normalizeSearchText(paper.doi ?? ""))
              .filter(Boolean),
          );
          let imported = 0;
          for (const node of parsed.nodes ?? []) {
            const doi = node.doi?.trim() ?? "";
            if (!doi || localDOIs.has(normalizeSearchText(doi))) continue;
            const work: ExternalWork = {
              providerWorkID: node.providerWorkID ?? "imported-json",
              doi,
              title: node.title?.trim() || doi,
              year: null,
              authors: [],
              citationCount: null,
              referenceCount: null,
            };
            const items = await importExternalWork(work, snapshot.libraryID);
            if (items.length > 0) {
              imported += items.length;
              localDOIs.add(normalizeSearchText(doi));
            }
          }
          resolve(imported);
        } catch (error) {
          reject(error);
        } finally {
          input.remove();
        }
      },
      { once: true },
    );
    input.click();
  });
}

export function destroyCitationMapView(mount: Element): void {
  cleanupByMount.get(mount)?.();
  cleanupByMount.delete(mount);
}

export function renderCitationMapView(
  document: Document,
  mount: Element,
  snapshot: LibrarySnapshot,
  options: GraphViewOptions,
): HTMLElement {
  destroyCitationMapView(mount);
  ensureGraphStyle(document);
  clearElement(mount);

  const graph = buildCitationGraph(snapshot);
  const collectionVisuals = buildCollectionVisuals(snapshot, graph.nodes);
  const root = createHTMLElement(document, "div");
  root.className = "citation-map-root";
  root.dataset.mode = options.mode;

  const header = createHTMLElement(document, "header");
  header.className = "cm-page-header";

  const headingGroup = createHTMLElement(document, "div");
  headingGroup.className = "cm-heading-group";

  const titleRow = createHTMLElement(document, "div");
  titleRow.className = "cm-title-row";
  const titleIcon = createHTMLElement(document, "img");
  titleIcon.className = "cm-title-icon";
  titleIcon.src = `chrome://${config.addonRef}/content/icons/network.svg`;
  titleIcon.alt = "";
  titleRow.appendChild(titleIcon);
  titleRow.appendChild(createTextElement(document, "h1", "Citation Map"));
  headingGroup.appendChild(titleRow);
  headingGroup.appendChild(
    createTextElement(
      document,
      "p",
      `${snapshot.libraryName} · loaded ${new Date(
        snapshot.generatedAt,
      ).toLocaleString()}`,
      "cm-subtitle",
    ),
  );
  headingGroup.appendChild(
    createTextElement(
      document,
      "p",
      createStatisticsSummary(snapshot),
      "cm-statistics-summary",
    ),
  );
  header.appendChild(headingGroup);

  const headerActions = createHTMLElement(document, "div");
  headerActions.className = "cm-header-actions";

  const searchFilterRow = createHTMLElement(document, "div");
  searchFilterRow.className = "cm-search-filter-row";

  const searchInput = createHTMLElement(document, "input");
  searchInput.type = "search";
  searchInput.className = "cm-search-input";
  searchInput.placeholder = "Search all fields and tags";
  searchInput.setAttribute("aria-label", "Search all fields and tags");
  searchInput.autocomplete = "off";
  searchFilterRow.appendChild(searchInput);

  const collectionControl = createLabelledSelect(
    document,
    "Collection",
    "cm-filter-control cm-compact-control",
  );
  collectionControl.select.appendChild(
    createOption(document, "all", "Whole library"),
  );
  for (const collection of snapshot.collections) {
    collectionControl.select.appendChild(
      createOption(document, String(collection.collectionID), collection.path),
    );
  }
  searchFilterRow.appendChild(collectionControl.wrapper);

  const tagControl = createLabelledSelect(
    document,
    "Tag",
    "cm-filter-control cm-compact-control",
  );
  tagControl.select.appendChild(createOption(document, "all", "All tags"));
  for (const tag of snapshot.tags) {
    tagControl.select.appendChild(createOption(document, tag, tag));
  }
  searchFilterRow.appendChild(tagControl.wrapper);
  headerActions.appendChild(searchFilterRow);

  const searchStatus = createTextElement(
    document,
    "span",
    "",
    "cm-search-status",
  );
  searchStatus.setAttribute("aria-live", "polite");
  headerActions.appendChild(searchStatus);

  header.appendChild(headerActions);
  root.appendChild(header);

  const toolbar = createHTMLElement(document, "div");
  toolbar.className = "cm-toolbar";

  const missingControls = createHTMLElement(document, "div");
  missingControls.className = "cm-missing-controls";
  missingControls.appendChild(
    createTextElement(document, "span", "Include missing:", "cm-control-label"),
  );
  const missingYear = createCheckbox(document, "year", true);
  const missingCitations = createCheckbox(document, "citations", true);
  const missingReferences = createCheckbox(document, "references", true);
  missingControls.append(
    missingYear.wrapper,
    missingCitations.wrapper,
    missingReferences.wrapper,
  );
  toolbar.appendChild(missingControls);

  const discoveryActions = createHTMLElement(document, "div");
  discoveryActions.className = "cm-discovery-actions";
  const recommendationsButton = createHTMLElement(document, "button");
  recommendationsButton.type = "button";
  recommendationsButton.textContent = "Missing papers";
  const exportJSONButton = createHTMLElement(document, "button");
  exportJSONButton.type = "button";
  exportJSONButton.textContent = "Export JSON";
  const exportCSVButton = createHTMLElement(document, "button");
  exportCSVButton.type = "button";
  exportCSVButton.textContent = "Export CSV";
  const importJSONButton = createHTMLElement(document, "button");
  importJSONButton.type = "button";
  importJSONButton.textContent = "Import JSON";
  discoveryActions.append(
    recommendationsButton,
    exportJSONButton,
    exportCSVButton,
    importJSONButton,
  );
  toolbar.appendChild(discoveryActions);

  const graphStatus = createTextElement(
    document,
    "span",
    "",
    "cm-graph-status",
  );
  toolbar.appendChild(graphStatus);
  root.appendChild(toolbar);

  const main = createHTMLElement(document, "main");
  main.className = "cm-main";

  const graphShell = createHTMLElement(document, "section");
  graphShell.className = "cm-graph-shell";
  graphShell.setAttribute("aria-label", "Citation graph");

  const graphStage = createHTMLElement(document, "div");
  graphStage.className = "cm-graph-stage";

  const yAxisDock = createHTMLElement(document, "div");
  yAxisDock.className = "cm-axis-dock cm-y-axis-dock";

  const yAxisCanvas = createHTMLElement(document, "canvas");
  yAxisCanvas.className = "cm-axis-canvas cm-y-axis-canvas";
  yAxisCanvas.setAttribute("aria-hidden", "true");
  yAxisDock.appendChild(yAxisCanvas);

  const yAxisPicker = createAxisPicker(document, "y");
  const xAxisPicker = createAxisPicker(document, "x");
  graphStage.appendChild(yAxisDock);

  const graphSurface = createHTMLElement(document, "div");
  graphSurface.className = "cm-graph-surface";

  const canvas = createHTMLElement(document, "canvas");
  canvas.className = "cm-graph-canvas";
  canvas.setAttribute(
    "aria-label",
    "Interactive citation graph. Arrows point from citing papers to cited papers.",
  );
  graphSurface.appendChild(canvas);

  const tooltip = createHTMLElement(document, "div");
  tooltip.className = "cm-node-tooltip";
  tooltip.hidden = true;
  graphSurface.appendChild(tooltip);

  const emptyState = createHTMLElement(document, "div");
  emptyState.className = "cm-graph-empty-state";
  emptyState.hidden = true;
  emptyState.appendChild(
    createTextElement(document, "h2", "No papers to display"),
  );
  const emptyStateText = createTextElement(
    document,
    "p",
    "Change the filters to include papers in the graph.",
  );
  emptyState.appendChild(emptyStateText);
  graphSurface.appendChild(emptyState);

  graphSurface.append(yAxisPicker.root, xAxisPicker.root);

  const zoomControls = createHTMLElement(document, "div");
  zoomControls.className = "cm-zoom-controls";

  const zoomInButton = createHTMLElement(document, "button");
  zoomInButton.type = "button";
  zoomInButton.className = "cm-graph-icon-button";
  zoomInButton.title = "Zoom in";
  zoomInButton.setAttribute("aria-label", "Zoom in");
  zoomInButton.appendChild(createGraphControlIcon(document, "zoom-in"));

  const zoomOutButton = createHTMLElement(document, "button");
  zoomOutButton.type = "button";
  zoomOutButton.className = "cm-graph-icon-button";
  zoomOutButton.title = "Zoom out";
  zoomOutButton.setAttribute("aria-label", "Zoom out");
  zoomOutButton.appendChild(createGraphControlIcon(document, "zoom-out"));

  const fitButton = createHTMLElement(document, "button");
  fitButton.type = "button";
  fitButton.className = "cm-graph-icon-button";
  fitButton.title = "Fit graph (keyboard: F)";
  fitButton.setAttribute("aria-label", "Fit graph");
  fitButton.appendChild(createGraphControlIcon(document, "fit"));

  zoomControls.append(zoomInButton, zoomOutButton, fitButton);
  graphSurface.appendChild(zoomControls);

  graphStage.appendChild(graphSurface);

  const axisCorner = createHTMLElement(document, "div");
  axisCorner.className = "cm-axis-corner";
  graphStage.appendChild(axisCorner);

  const xAxisDock = createHTMLElement(document, "div");
  xAxisDock.className = "cm-axis-dock cm-x-axis-dock";

  const xAxisCanvas = createHTMLElement(document, "canvas");
  xAxisCanvas.className = "cm-axis-canvas cm-x-axis-canvas";
  xAxisCanvas.setAttribute("aria-hidden", "true");
  xAxisDock.appendChild(xAxisCanvas);

  graphStage.appendChild(xAxisDock);

  graphShell.appendChild(graphStage);

  const detailPanel = createHTMLElement(document, "aside");
  detailPanel.className = "cm-detail-panel";
  detailPanel.setAttribute("aria-label", "Selected paper details");

  let selectedNode: CitationGraphNode | null = null;

  const renderExternalWorks = (
    title: string,
    works: ExternalWork[],
    backNode: CitationGraphNode | null,
  ): void => {
    clearElement(detailPanel);
    const heading = createHTMLElement(document, "div");
    heading.className = "cm-external-heading";
    const backButton = createHTMLElement(document, "button");
    backButton.type = "button";
    backButton.textContent = "Back";
    backButton.addEventListener("click", () => renderDetails(backNode));
    heading.append(backButton, createTextElement(document, "h2", title));
    detailPanel.appendChild(heading);

    if (works.length === 0) {
      detailPanel.appendChild(
        createTextElement(
          document,
          "p",
          "No external works were found.",
          "cm-detail-placeholder",
        ),
      );
      return;
    }

    const localDOIs = new Set(
      snapshot.papers
        .map((paper) => normalizeSearchText(paper.doi ?? ""))
        .filter(Boolean),
    );
    const list = createHTMLElement(document, "div");
    list.className = "cm-external-list";
    for (const work of works) {
      const card = createHTMLElement(document, "article");
      card.className = "cm-external-work";
      card.appendChild(createTextElement(document, "h3", work.title));
      const metadata = [
        work.authors.slice(0, 3).join(", "),
        work.year ? String(work.year) : "",
        work.citationCount === null
          ? ""
          : `${formatCount(work.citationCount)} citations`,
        work.recommendationScore
          ? `cited by ${work.recommendationScore} library papers`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      if (metadata) {
        card.appendChild(
          createTextElement(document, "p", metadata, "cm-external-meta"),
        );
      }
      const actions = createHTMLElement(document, "div");
      actions.className = "cm-detail-actions";
      if (work.doi) {
        const openButton = createHTMLElement(document, "button");
        openButton.type = "button";
        openButton.textContent = "Open DOI";
        openButton.addEventListener("click", () => {
          Zotero.launchURL(
            `https://doi.org/${encodeURIComponent(work.doi ?? "")}`,
          );
        });
        actions.appendChild(openButton);

        const normalizedDOI = normalizeSearchText(work.doi);
        const addButton = createHTMLElement(document, "button");
        addButton.type = "button";
        const alreadyLocal = localDOIs.has(normalizedDOI);
        addButton.disabled = alreadyLocal;
        addButton.textContent = alreadyLocal
          ? "Already in Zotero"
          : "Add to Zotero";
        addButton.addEventListener("click", async () => {
          addButton.disabled = true;
          addButton.textContent = "Adding…";
          try {
            const items = await importExternalWork(work, snapshot.libraryID);
            if (items.length === 0) throw new Error("No item was imported.");
            localDOIs.add(normalizedDOI);
            addButton.textContent = "Added";
          } catch (error) {
            Zotero.logError(
              error instanceof Error ? error : new Error(String(error)),
            );
            addButton.disabled = false;
            addButton.textContent = "Import failed";
          }
        });
        actions.appendChild(addButton);
      }
      card.appendChild(actions);
      list.appendChild(card);
    }
    detailPanel.appendChild(list);
  };

  const showLoading = (title: string): void => {
    clearElement(detailPanel);
    detailPanel.appendChild(createTextElement(document, "h2", title));
    detailPanel.appendChild(
      createTextElement(
        document,
        "p",
        "Loading from OpenAlex…",
        "cm-detail-placeholder",
      ),
    );
  };

  const renderDetails = (node: CitationGraphNode | null): void => {
    selectedNode = node;
    clearElement(detailPanel);
    if (!node) {
      detailPanel.appendChild(
        createTextElement(document, "h2", "Paper details"),
      );
      detailPanel.appendChild(
        createTextElement(
          document,
          "p",
          "Select a node. Use References or Cited by to browse papers outside the current Zotero graph.",
          "cm-detail-placeholder",
        ),
      );
      return;
    }

    detailPanel.appendChild(createTextElement(document, "h2", node.title));
    detailPanel.appendChild(
      createTextElement(
        document,
        "p",
        node.authors.length > 0 ? node.authors.join(", ") : "Unknown author",
        "cm-detail-authors",
      ),
    );
    const rows = createHTMLElement(document, "div");
    rows.className = "cm-detail-rows";
    rows.append(
      createDetailRow(document, "Year", node.year ? String(node.year) : "—"),
      createDetailRow(
        document,
        "Citations",
        node.citationCount === null ? "—" : formatCount(node.citationCount),
      ),
      createDetailRow(
        document,
        "References",
        node.referenceCount === null ? "—" : formatCount(node.referenceCount),
      ),
      createDetailRow(
        document,
        "Library coverage",
        formatNullableMetric("library-coverage", node.libraryCoverage),
      ),
      createDetailRow(
        document,
        "Citation velocity",
        formatNullableMetric("citation-velocity", node.citationVelocity),
      ),
      createDetailRow(
        document,
        "Citation acceleration",
        formatNullableMetric(
          "citation-acceleration",
          node.citationAcceleration,
        ),
      ),
    );
    detailPanel.appendChild(rows);

    const actions = createHTMLElement(document, "div");
    actions.className = "cm-detail-actions";
    const showButton = createHTMLElement(document, "button");
    showButton.type = "button";
    showButton.textContent = "Show in Zotero";
    showButton.addEventListener(
      "click",
      () => void options.onSelectPaper(node.itemID),
    );
    actions.appendChild(showButton);

    const referencesButton = createHTMLElement(document, "button");
    referencesButton.type = "button";
    referencesButton.textContent = "References";
    referencesButton.addEventListener("click", async () => {
      showLoading("References");
      const works = await getExternalReferences(node);
      renderExternalWorks("References", works, node);
    });
    actions.appendChild(referencesButton);

    const citedByButton = createHTMLElement(document, "button");
    citedByButton.type = "button";
    citedByButton.textContent = "Cited by";
    citedByButton.disabled = !node.providerWorkID;
    citedByButton.addEventListener("click", async () => {
      showLoading("Cited by");
      const works = await getExternalCitedBy(node);
      renderExternalWorks("Cited by", works, node);
    });
    actions.appendChild(citedByButton);

    if (node.doi) {
      const doiButton = createHTMLElement(document, "button");
      doiButton.type = "button";
      doiButton.textContent = "Open DOI";
      doiButton.addEventListener("click", () => {
        Zotero.launchURL(
          `https://doi.org/${encodeURIComponent(node.doi ?? "")}`,
        );
      });
      actions.appendChild(doiButton);
    }
    detailPanel.appendChild(actions);
  };

  renderDetails(null);
  graphShell.appendChild(detailPanel);
  main.appendChild(graphShell);
  root.appendChild(main);
  mount.appendChild(root);

  const renderer = new CitationGraphRenderer({
    root,
    canvas,
    xAxisCanvas,
    yAxisCanvas,
    tooltip,
    model: graph,
    nodeSizeMetric: readNodeSizeMetric(),
    nodeLabelMode: readNodeLabelMode(),
    collectionColorByNodeKey: collectionVisuals.colorByNodeKey,
    collectionLabelByNodeKey: collectionVisuals.labelByNodeKey,
    onSelectionChange: renderDetails,
    onOpenNode: (node) => options.onSelectPaper(node.itemID),
  });

  const nodeKeyByItemID = new Map(
    graph.nodes.map((node) => [node.itemID, node.key]),
  );
  let visibleNodeKeys = new Set(graph.nodes.map((node) => node.key));
  let searchTimer: number | null = null;
  let searchGeneration = 0;

  recommendationsButton.addEventListener("click", async () => {
    showLoading("Missing papers");
    recommendationsButton.disabled = true;
    try {
      const visibleNodes = graph.nodes.filter((node) =>
        visibleNodeKeys.has(node.key),
      );
      const works = await getMissingPaperRecommendations(visibleNodes);
      renderExternalWorks("Missing papers", works, selectedNode);
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
      renderExternalWorks("Missing papers", [], selectedNode);
    } finally {
      recommendationsButton.disabled = false;
    }
  });

  exportJSONButton.addEventListener("click", () =>
    exportGraphJSON(document, snapshot, graph),
  );
  exportCSVButton.addEventListener("click", () =>
    exportGraphCSV(document, graph),
  );
  importJSONButton.addEventListener("click", async () => {
    importJSONButton.disabled = true;
    const original = importJSONButton.textContent;
    importJSONButton.textContent = "Importing…";
    try {
      const imported = await importGraphJSON(document, snapshot);
      importJSONButton.textContent =
        imported > 0 ? `Imported ${imported}` : "Nothing imported";
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
      importJSONButton.textContent = "Import failed";
    } finally {
      document.defaultView?.setTimeout(() => {
        importJSONButton.textContent = original;
        importJSONButton.disabled = false;
      }, 2500);
    }
  });

  const getCollectionFilter = (): LibraryCollectionFilter | null => {
    const collectionID = Number(collectionControl.select.value);
    return Number.isFinite(collectionID)
      ? (snapshot.collections.find(
          (collection) => collection.collectionID === collectionID,
        ) ?? null)
      : null;
  };

  const updateGraphStatus = (): void => {
    const visibleEdges = renderer.getVisibleEdgeCount();
    graphStatus.textContent =
      `${formatCount(visibleNodeKeys.size)} papers · ` +
      `${formatCount(visibleEdges)} citation links · ` +
      `${formatCount(graph.statistics.resolvedNodes)} papers with cached data`;
  };

  const applyFilters = (): void => {
    const collection = getCollectionFilter();
    const selectedTag = tagControl.select.value;

    visibleNodeKeys = new Set(
      graph.nodes
        .filter((node) => {
          if (!collectionMatches(node, collection)) {
            return false;
          }
          if (selectedTag !== "all" && !node.tags.includes(selectedTag)) {
            return false;
          }
          if (!missingYear.input.checked && node.year === null) {
            return false;
          }
          if (!missingCitations.input.checked && node.citationCount === null) {
            return false;
          }
          if (
            !missingReferences.input.checked &&
            node.referenceCount === null
          ) {
            return false;
          }
          return true;
        })
        .map((node) => node.key),
    );

    const graphIsEmpty = visibleNodeKeys.size === 0;
    emptyState.hidden = !graphIsEmpty;
    canvas.hidden = graphIsEmpty;
    xAxisCanvas.hidden = graphIsEmpty;
    yAxisCanvas.hidden = graphIsEmpty;
    xAxisPicker.root.hidden = graphIsEmpty;
    yAxisPicker.root.hidden = graphIsEmpty;
    zoomControls.hidden = graphIsEmpty;
    renderer.setVisibleKeys(visibleNodeKeys);
    updateGraphStatus();

    if (searchInput.value.trim()) {
      void applySearch();
    }
  };

  const currentLayout = (): GraphLayoutOptions => ({
    xMetric: xAxisPicker.getMetric(),
    xScale: xAxisPicker.getScale(),
    yMetric: yAxisPicker.getMetric(),
    yScale: yAxisPicker.getScale(),
  });

  const applyLayout = (): void => {
    renderer.setLayout(currentLayout());
  };

  const applySearch = async (): Promise<void> => {
    const generation = ++searchGeneration;
    const query = searchInput.value.trim();

    if (!query) {
      searchStatus.textContent = "";
      renderer.setSearchMatches(null);
      return;
    }

    searchStatus.textContent = "Searching…";
    const matchingItemIDs = await runZoteroSearch(query, snapshot);

    if (generation !== searchGeneration) {
      return;
    }

    const matchingKeys = new Set(
      matchingItemIDs
        .map((itemID) => nodeKeyByItemID.get(itemID))
        .filter((key): key is string => Boolean(key)),
    );
    const visibleMatches = [...matchingKeys].filter((key) =>
      visibleNodeKeys.has(key),
    );

    renderer.setSearchMatches(matchingKeys);
    searchStatus.textContent = `${formatCount(visibleMatches.length)} match${
      visibleMatches.length === 1 ? "" : "es"
    } in current graph`;
  };

  const scheduleSearch = (): void => {
    if (searchTimer !== null) {
      document.defaultView?.clearTimeout(searchTimer);
    }

    searchTimer =
      document.defaultView?.setTimeout(() => {
        searchTimer = null;
        void applySearch();
      }, 250) ?? null;
  };

  searchInput.addEventListener("input", scheduleSearch);
  searchInput.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      searchInput.value = "";
      void applySearch();
    } else if (event.key === "Enter") {
      if (searchTimer !== null) {
        document.defaultView?.clearTimeout(searchTimer);
        searchTimer = null;
      }
      void applySearch();
    }
  });

  for (const control of [
    collectionControl.select,
    tagControl.select,
    missingYear.input,
    missingCitations.input,
    missingReferences.input,
  ]) {
    control.addEventListener("change", applyFilters);
  }

  xAxisPicker.onChange(applyLayout);
  yAxisPicker.onChange(applyLayout);

  const closeAxisMenus = (except?: AxisPicker): void => {
    if (except !== xAxisPicker) xAxisPicker.setOpen(false);
    if (except !== yAxisPicker) yAxisPicker.setOpen(false);
  };

  xAxisPicker.button.addEventListener("click", () => {
    if (xAxisPicker.isOpen()) closeAxisMenus(xAxisPicker);
  });
  yAxisPicker.button.addEventListener("click", () => {
    if (yAxisPicker.isOpen()) closeAxisMenus(yAxisPicker);
  });

  const documentPointerListener = (event: Event): void => {
    const target = event.target as Node | null;
    if (
      target &&
      (xAxisPicker.root.contains(target) || yAxisPicker.root.contains(target))
    ) {
      return;
    }
    closeAxisMenus();
  };
  const documentKeyListener = (event: KeyboardEvent): void => {
    if (event.key === "Escape") closeAxisMenus();
  };
  document.addEventListener("pointerdown", documentPointerListener, true);
  document.addEventListener("keydown", documentKeyListener, true);

  zoomInButton.addEventListener("click", () => renderer.zoomBy(1.25));
  zoomOutButton.addEventListener("click", () => renderer.zoomBy(0.8));
  fitButton.addEventListener("click", () => renderer.fitView());

  const nodeSizeObserverID = Zotero.Prefs.registerObserver(
    NODE_SIZE_PREF,
    () => renderer.setNodeSizeMetric(readNodeSizeMetric()),
    true,
  );
  const nodeLabelObserverID = Zotero.Prefs.registerObserver(
    NODE_LABEL_PREF,
    () => renderer.setNodeLabelMode(readNodeLabelMode()),
    true,
  );

  applyLayout();
  applyFilters();

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    if (searchTimer !== null) {
      document.defaultView?.clearTimeout(searchTimer);
      searchTimer = null;
    }
    document.removeEventListener("pointerdown", documentPointerListener, true);
    document.removeEventListener("keydown", documentKeyListener, true);
    document.defaultView?.removeEventListener("unload", cleanup);
    Zotero.Prefs.unregisterObserver(nodeSizeObserverID);
    Zotero.Prefs.unregisterObserver(nodeLabelObserverID);
    renderer.destroy();
  };
  document.defaultView?.addEventListener("unload", cleanup, { once: true });
  cleanupByMount.set(mount, cleanup);

  return root;
}
