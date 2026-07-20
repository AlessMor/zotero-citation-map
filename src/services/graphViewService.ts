/// <reference lib="dom" />

import { config } from "../../package.json";
import type {
  CitationGraphNode,
  GraphAxisMetric,
  GraphLayoutOptions,
  GraphNodeColorMetric,
  GraphNodeSizeMetric,
  GraphScaleType,
} from "../domain/graphTypes";
import type {
  LibraryCollectionFilter,
  LibrarySnapshot,
  ZoteroPaper,
} from "../domain/types";
import { buildCitationGraph } from "./citationGraphService";
import {
  CitationGraphRenderer,
  type GhostPreview,
} from "./citationGraphRenderer";
import {
  getExternalCitedBy,
  getExternalReferences,
  getMissingPaperRecommendations,
  hydrateExternalWorksMetadata,
  importExternalWork,
  type ExternalWork,
} from "./externalDiscoveryService";
import {
  exportGraphCSV,
  exportGraphJSON,
  exportGraphPNG,
} from "./exportService";
import {
  axisMetricDefinitions,
  formatMetricValue,
  getMetricDefinition,
  nodeColorMetricDefinitions,
  nodeSizeMetricDefinitions,
} from "./metricRegistry";
import {
  ensureSourceMetricsForNodes,
  graphLayoutUsesSourceMetrics,
} from "./sourceMetricsService";
import {
  getDetailPanelCollapsed,
  getDetailPanelWidth,
  getGraphAppearance,
  resetGraphAppearance,
  setDetailPanelCollapsed,
  setDetailPanelWidth,
  setGraphAppearance,
} from "./citationPreferences";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const cleanupByMount = new WeakMap<Element, () => void>();

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export interface GraphViewOptions {
  mode: "tab" | "window";
  onSelectPaper: (itemID: number) => void | Promise<void>;
  initialItemID?: number | null;
}

interface CollectionVisuals {
  colorsByNodeKey: Map<string, string[]>;
  labelsByNodeKey: Map<string, string[]>;
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElementNS(
    HTML_NS,
    tag,
  ) as HTMLElementTagNameMap[K];
  if (className) node.className = className;
  return node;
}

function text<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  content: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = element(document, tag, className);
  node.textContent = content;
  return node;
}

function clear(node: Element): void {
  node.replaceChildren();
}

function ensureStyles(document: Document): void {
  const id = `${config.addonRef}-graph-stylesheet`;
  const href = `chrome://${config.addonRef}/content/graph.css`;
  let link = document.getElementById(id) as HTMLLinkElement | null;
  if (!link) {
    link = element(document, "link");
    link.id = id;
    link.rel = "stylesheet";
    (document.head ?? document.documentElement).appendChild(link);
  }
  if (link.getAttribute("href") !== href) link.setAttribute("href", href);
}

function icon(
  document: Document,
  name: "search" | "filter" | "similar" | "export" | "refresh",
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("cm-icon", `cm-icon-${name}`);
  const paths: Record<typeof name, string[]> = {
    search: [
      "M10.5 4a6.5 6.5 0 1 0 3.95 11.66L20 21.2l1.2-1.2-5.55-5.55A6.5 6.5 0 0 0 10.5 4Zm0 1.8a4.7 4.7 0 1 1 0 9.4 4.7 4.7 0 0 1 0-9.4Z",
    ],
    filter: ["M3 5h18l-7 8v5.5l-4 2V13Z"],
    similar: [
      "M7 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm10 10a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM9.5 7h5l2.5 3.5M7 10v4h7",
    ],
    export: ["M5 3h12l2 2v16H5Zm3 2v5h8V5Zm0 9v5h8v-5Z"],
    refresh: [
      "M19.5 7.2V3.5l-1.8 1.8A8 8 0 1 0 20 13h-2a6 6 0 1 1-1.72-4.2l-2.03 2.03H20V5.1Z",
    ],
  };
  svg.setAttribute("fill", "currentColor");
  for (const d of paths[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
  }
  return svg;
}

function networkLogo(document: Document): HTMLSpanElement {
  const logo = element(document, "span", "cm-network-logo");
  logo.setAttribute("aria-hidden", "true");
  return logo;
}

function iconButtonContent(
  document: Document,
  name: Parameters<typeof icon>[1],
  label: string,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(icon(document, name), text(document, "span", label));
  return fragment;
}

function formatCount(value: number | null): string {
  return value === null
    ? "—"
    : new Intl.NumberFormat(undefined, { useGrouping: false }).format(value);
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
}

function paperSearchText(paper: ZoteroPaper): string {
  return normalizeSearch(
    [
      paper.title,
      paper.authors.join(" "),
      paper.doi ?? "",
      paper.sourceTitle ?? "",
      paper.abstract ?? "",
      paper.year ?? "",
    ].join(" "),
  );
}

function externalWorkTitle(work: ExternalWork): string {
  return (
    work.title?.trim() ||
    work.doi?.trim() ||
    work.providerWorkID?.trim() ||
    "Untitled work"
  );
}

function externalWorkMetadataText(work: ExternalWork): string {
  return [
    work.authors.slice(0, 4).join(", "),
    work.sourceTitle,
    work.year,
    work.citationCount === null || work.citationCount === undefined
      ? ""
      : `${formatCount(work.citationCount)} citations`,
    work.recommendationScore
      ? `connected to ${work.recommendationScore} visible papers`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function colorForCollection(id: number, depth: number): string {
  const hue = (id * 47 + depth * 19) % 360;
  return `hsl(${hue} ${Math.max(42, 65 - depth * 5)}% ${Math.min(67, 45 + depth * 7)}%)`;
}

function buildCollectionVisuals(
  snapshot: LibrarySnapshot,
  nodes: CitationGraphNode[],
): CollectionVisuals {
  const byID = new Map(
    snapshot.collections.map((collection) => [
      collection.collectionID,
      collection,
    ]),
  );
  const colorsByNodeKey = new Map<string, string[]>();
  const labelsByNodeKey = new Map<string, string[]>();
  for (const node of nodes) {
    const memberships = node.collectionIDs
      .map((id) => byID.get(id))
      .filter((entry): entry is LibraryCollectionFilter => Boolean(entry))
      .sort((left, right) => right.depth - left.depth);
    const shown = memberships.slice(0, 4);
    colorsByNodeKey.set(
      node.key,
      shown.map((collection) =>
        colorForCollection(collection.collectionID, collection.depth),
      ),
    );
    labelsByNodeKey.set(
      node.key,
      memberships.length
        ? memberships.map((collection) => collection.path)
        : ["Unfiled"],
    );
  }
  return { colorsByNodeKey, labelsByNodeKey };
}

function metricDescription(definition: {
  description: string;
  interpretation?: string;
}): string {
  return [definition.description, definition.interpretation]
    .filter(Boolean)
    .join(" ");
}

function createGroupedMetricSelect(
  document: Document,
  definitions: ReturnType<typeof axisMetricDefinitions>,
  selected: string,
  includeFree = false,
): HTMLSelectElement {
  const select = element(document, "select", "cm-select");
  if (includeFree) {
    const option = element(document, "option");
    option.value = "free";
    option.textContent = "Free";
    option.title = "Position nodes freely along this axis.";
    option.dataset.metricDescription = option.title;
    select.appendChild(option);
  }
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const definition of definitions) {
    let group = groups.get(definition.group);
    if (!group) {
      group = element(document, "optgroup");
      group.label = definition.group;
      groups.set(definition.group, group);
      select.appendChild(group);
    }
    const option = element(document, "option");
    option.value = definition.id;
    option.textContent = definition.label;
    option.title = metricDescription(definition);
    option.dataset.metricDescription = option.title;
    group.appendChild(option);
  }
  select.value = selected;
  return select;
}

function createScaleSelect(
  document: Document,
  selected: GraphScaleType,
): HTMLSelectElement {
  const select = element(document, "select", "cm-select");
  for (const [value, label] of [
    ["linear", "Linear"],
    ["log", "Logarithmic"],
  ] as const) {
    const option = element(document, "option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = selected;
  return select;
}

function createMetricHelp(
  document: Document,
  select: HTMLSelectElement,
  fallback: string,
): HTMLParagraphElement {
  const help = text(document, "p", fallback, "cm-metric-help");
  const showSelected = (): void => {
    const option = select.selectedOptions[0];
    const description =
      option?.dataset.metricDescription || option?.title || fallback;
    help.textContent = description;
    select.title = description;
  };
  const showHovered = (event: Event): void => {
    const option = (event.target as Element | null)?.closest?.(
      "option",
    ) as HTMLOptionElement | null;
    const description = option?.dataset.metricDescription || option?.title;
    if (description) help.textContent = description;
  };
  for (const eventName of ["input", "change", "command"]) {
    select.addEventListener(eventName, showSelected);
  }
  select.addEventListener("mouseover", showHovered, true);
  select.addEventListener("mousemove", showHovered, true);
  select.addEventListener("mouseleave", showSelected);
  showSelected();
  return help;
}

function controlRow(
  document: Document,
  label: string,
  control: HTMLElement,
  help?: HTMLElement,
): HTMLDivElement {
  const row = element(document, "div", "cm-appearance-row-wrap");
  const line = element(document, "label", "cm-appearance-row");
  line.append(text(document, "span", label), control);
  row.appendChild(line);
  if (help) row.appendChild(help);
  return row;
}

function createAxesAppearance(
  document: Document,
  initial: GraphLayoutOptions,
  onChange: (layout: GraphLayoutOptions) => void,
): {
  root: HTMLDivElement;
  button: HTMLButtonElement;
  panel: HTMLDivElement;
  setLayout: (layout: GraphLayoutOptions) => void;
  close: () => void;
} {
  const root = element(document, "div", "cm-appearance-control");
  const button = element(
    document,
    "button",
    "cm-overlay-button cm-appearance-button",
  );
  button.type = "button";
  button.textContent = "⚙";
  button.title = "Axes and appearance";
  button.setAttribute("aria-label", "Axes and appearance");
  button.setAttribute("aria-expanded", "false");
  const panel = element(document, "div", "cm-appearance-panel");
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Axes and appearance");
  panel.append(text(document, "h2", "Axes & appearance"));

  const xMetric = createGroupedMetricSelect(
    document,
    axisMetricDefinitions(),
    initial.xMetric,
    true,
  );
  const xScale = createScaleSelect(document, initial.xScale);
  const yMetric = createGroupedMetricSelect(
    document,
    axisMetricDefinitions(),
    initial.yMetric,
    true,
  );
  const yScale = createScaleSelect(document, initial.yScale);
  const sizeMetric = createGroupedMetricSelect(
    document,
    nodeSizeMetricDefinitions(),
    initial.nodeSizeMetric,
  );
  const uniform = element(document, "option");
  uniform.value = "uniform";
  uniform.textContent = "Uniform";
  uniform.title = "Display every visible node with the same size.";
  uniform.dataset.metricDescription = uniform.title;
  sizeMetric.prepend(uniform);
  sizeMetric.value = initial.nodeSizeMetric;

  const colorMetric = element(document, "select", "cm-select");
  const categorical = element(document, "optgroup");
  categorical.label = "Categories";
  for (const [value, label, description] of [
    [
      "collection",
      "Collection",
      "Colour nodes by their Zotero collection membership.",
    ],
    [
      "publication-type",
      "Publication type",
      "Colour nodes by the publication type reported by the provider.",
    ],
    [
      "provider",
      "Provider",
      "Colour nodes by the scholarly-data provider used for the item.",
    ],
    [
      "open-access",
      "Open Access",
      "Distinguish works reported as openly accessible.",
    ],
    ["retraction", "Retraction", "Highlight works reported as retracted."],
  ]) {
    const option = element(document, "option");
    option.value = value;
    option.textContent = label;
    option.title = description;
    option.dataset.metricDescription = description;
    categorical.appendChild(option);
  }
  colorMetric.appendChild(categorical);
  const numericGroups = new Map<string, HTMLOptGroupElement>();
  for (const definition of nodeColorMetricDefinitions()) {
    let group = numericGroups.get(definition.group);
    if (!group) {
      group = element(document, "optgroup");
      group.label = definition.group;
      numericGroups.set(definition.group, group);
      colorMetric.appendChild(group);
    }
    const option = element(document, "option");
    option.value = definition.id;
    option.textContent = definition.label;
    option.title = metricDescription(definition);
    option.dataset.metricDescription = option.title;
    group.appendChild(option);
  }
  colorMetric.value = initial.nodeColorMetric;

  const labels = element(document, "select", "cm-select");
  for (const [value, label] of [
    ["title", "Title"],
    ["author-year", "Author (year)"],
    ["none", "No labels"],
  ]) {
    const option = element(document, "option");
    option.value = value;
    option.textContent = label;
    labels.appendChild(option);
  }
  labels.value = initial.nodeLabelMode;

  const section = (titleValue: string): HTMLFieldSetElement => {
    const fieldset = element(document, "fieldset", "cm-appearance-section");
    fieldset.append(text(document, "legend", titleValue));
    panel.appendChild(fieldset);
    return fieldset;
  };
  const xSection = section("X axis");
  xSection.append(
    controlRow(
      document,
      "Metric",
      xMetric,
      createMetricHelp(document, xMetric, "Choose horizontal position."),
    ),
    controlRow(document, "Scale", xScale),
  );
  const ySection = section("Y axis");
  ySection.append(
    controlRow(
      document,
      "Metric",
      yMetric,
      createMetricHelp(document, yMetric, "Choose vertical position."),
    ),
    controlRow(document, "Scale", yScale),
  );
  const nodeSection = section("Nodes");
  nodeSection.append(
    controlRow(
      document,
      "Size",
      sizeMetric,
      createMetricHelp(
        document,
        sizeMetric,
        "Visible minimum and maximum values map to the plugin minimum and maximum node sizes.",
      ),
    ),
    controlRow(
      document,
      "Colour",
      colorMetric,
      createMetricHelp(document, colorMetric, "Choose node colour."),
    ),
    controlRow(document, "Labels", labels),
  );
  const actions = element(document, "div", "cm-appearance-actions");
  const reset = element(document, "button", "cm-secondary-button");
  reset.type = "button";
  reset.textContent = "Reset defaults";
  actions.appendChild(reset);
  panel.appendChild(actions);
  root.append(button, panel);

  const read = (): GraphLayoutOptions => ({
    xMetric: xMetric.value as GraphAxisMetric,
    xScale: xScale.value as GraphScaleType,
    yMetric: yMetric.value as GraphAxisMetric,
    yScale: yScale.value as GraphScaleType,
    nodeSizeMetric: sizeMetric.value as GraphNodeSizeMetric,
    nodeColorMetric: colorMetric.value as GraphNodeColorMetric,
    nodeLabelMode: labels.value as GraphLayoutOptions["nodeLabelMode"],
  });
  const updateAvailability = (): void => {
    for (const [metric, scale] of [
      [xMetric, xScale],
      [yMetric, yScale],
    ] as const) {
      const selected = metric.value as GraphAxisMetric;
      const logarithmic = scale.querySelector(
        'option[value="log"]',
      ) as HTMLOptionElement | null;
      const enabled =
        selected !== "free" && getMetricDefinition(selected).graph.logarithmic;
      if (logarithmic) logarithmic.disabled = !enabled;
      if (!enabled && scale.value === "log") scale.value = "linear";
      scale.disabled = selected === "free";
    }
  };
  let last = JSON.stringify(initial);
  const commit = (layout: GraphLayoutOptions, force = false): void => {
    const signature = JSON.stringify(layout);
    if (!force && signature === last) return;
    onChange(layout);
    setGraphAppearance(layout);
    last = signature;
  };
  for (const control of [
    xMetric,
    xScale,
    yMetric,
    yScale,
    sizeMetric,
    colorMetric,
    labels,
  ]) {
    const applySelection = (): void => {
      updateAvailability();
      commit(read());
    };
    control.addEventListener("input", applySelection);
    control.addEventListener("change", applySelection);
  }
  const close = (): void => {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };
  button.addEventListener("click", () => {
    if (panel.hidden) {
      panel.hidden = false;
      button.setAttribute("aria-expanded", "true");
    } else {
      close();
    }
  });
  const setControls = (layout: GraphLayoutOptions): void => {
    xMetric.value = layout.xMetric;
    xScale.value = layout.xScale;
    yMetric.value = layout.yMetric;
    yScale.value = layout.yScale;
    sizeMetric.value = layout.nodeSizeMetric;
    colorMetric.value = layout.nodeColorMetric;
    labels.value = layout.nodeLabelMode;
    updateAvailability();
  };
  const setLayout = (layout: GraphLayoutOptions): void => {
    setControls(layout);
    commit(layout, true);
  };
  reset.addEventListener("click", () => setLayout(resetGraphAppearance()));
  updateAvailability();
  return { root, button, panel, setLayout, close };
}

function localPaperByKey(snapshot: LibrarySnapshot): Map<string, ZoteroPaper> {
  return new Map(snapshot.papers.map((paper) => [paper.itemKey, paper]));
}

function createCollectionChooser(
  document: Document,
  snapshot: LibrarySnapshot,
): { root: HTMLDivElement; selected: Set<number> } {
  const root = element(document, "div", "cm-collection-chooser");
  const selected = new Set<number>();
  const search = element(document, "input", "cm-collection-search");
  search.type = "search";
  search.placeholder = "Search collections";
  const list = element(document, "div", "cm-collection-tree");
  const render = (): void => {
    clear(list);
    const query = normalizeSearch(search.value);
    for (const collection of snapshot.collections) {
      if (query && !normalizeSearch(collection.path).includes(query)) continue;
      const label = element(document, "label", "cm-collection-choice");
      label.style.paddingInlineStart = `${collection.depth * 15 + 5}px`;
      const checkbox = element(document, "input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(collection.collectionID);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(collection.collectionID);
        else selected.delete(collection.collectionID);
      });
      label.append(checkbox, text(document, "span", collection.name));
      list.appendChild(label);
    }
  };
  search.addEventListener("input", render);
  root.append(search, list);
  render();
  return { root, selected };
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
  ensureStyles(document);
  clear(mount);
  const model = buildCitationGraph(snapshot);
  const paperByKey = localPaperByKey(snapshot);
  const visuals = buildCollectionVisuals(snapshot, model.nodes);
  let visibleKeys = new Set(model.nodes.map((node) => node.key));
  let selectedNode: CitationGraphNode | null = null;
  let renderer: CitationGraphRenderer | null = null;
  let cleaned = false;
  const initialLayout = getGraphAppearance();
  const selectPaper = async (itemID: number): Promise<void> => {
    try {
      await options.onSelectPaper(itemID);
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };

  const root = element(document, "div", "citation-map-root");
  root.dataset.mode = options.mode;
  const header = element(document, "header", "cm-header");
  const identity = element(document, "div", "cm-header-identity");
  const titleRow = element(document, "div", "cm-title-row");
  titleRow.append(networkLogo(document), text(document, "h1", "Citation Map"));
  const summary = text(
    document,
    "p",
    `${formatCount(snapshot.statistics.totalPapers)} papers - ${formatCount(model.statistics.edges)} citation links`,
    "cm-library-summary",
  );
  identity.append(titleRow, summary);
  header.appendChild(identity);

  const toolbar = element(document, "div", "cm-header-toolbar");
  const searchWrap = element(document, "label", "cm-search-wrap");
  searchWrap.appendChild(icon(document, "search"));
  const search = element(document, "input", "cm-search");
  search.type = "search";
  search.placeholder = "Search all fields";
  search.setAttribute("aria-label", "Search all fields");
  searchWrap.appendChild(search);
  const filterButton = element(
    document,
    "button",
    "cm-primary-button cm-filter-button",
  );
  filterButton.type = "button";
  filterButton.append(iconButtonContent(document, "filter", "Filters"));
  filterButton.setAttribute("aria-expanded", "false");
  const similarButton = element(document, "button", "cm-toolbar-button");
  similarButton.type = "button";
  similarButton.append(iconButtonContent(document, "similar", "Similar"));
  const exportWrap = element(document, "div", "cm-menu-wrapper");
  const exportButton = element(document, "button", "cm-toolbar-button");
  exportButton.type = "button";
  exportButton.append(iconButtonContent(document, "export", "Export"));
  exportButton.setAttribute("aria-expanded", "false");
  const exportMenu = element(document, "div", "cm-export-menu");
  exportMenu.hidden = true;
  for (const [format, label] of [
    ["png", "PNG image"],
    ["json", "JSON graph data"],
    ["csv", "CSV citation links"],
  ]) {
    const button = element(document, "button");
    button.type = "button";
    button.dataset.format = format;
    button.textContent = label;
    exportMenu.appendChild(button);
  }
  exportWrap.append(exportButton, exportMenu);
  const refreshButton = element(document, "button", "cm-toolbar-button");
  refreshButton.type = "button";
  refreshButton.append(iconButtonContent(document, "refresh", "Refresh"));
  toolbar.append(
    searchWrap,
    filterButton,
    similarButton,
    exportWrap,
    refreshButton,
  );
  header.appendChild(toolbar);
  root.appendChild(header);

  const filterPanel = element(document, "div", "cm-filter-panel");
  filterPanel.hidden = true;
  const makeCheck = (label: string, checked: boolean): HTMLLabelElement => {
    const wrapper = element(document, "label", "cm-check-control");
    const input = element(document, "input");
    input.type = "checkbox";
    input.checked = checked;
    wrapper.append(input, text(document, "span", label));
    return wrapper;
  };
  const includeMissingYear = makeCheck("Include missing year", true);
  const includeMissingCitations = makeCheck("Include missing citations", true);
  const includeMissingReferences = makeCheck(
    "Include missing references",
    true,
  );
  const openAccessOnly = makeCheck("Open Access only", false);
  const excludeRetracted = makeCheck("Exclude retracted", false);
  const collection = element(document, "select", "cm-select");
  collection.setAttribute("aria-label", "Library filter");
  const allCollections = element(document, "option");
  allCollections.value = "all";
  allCollections.textContent = "Whole library";
  collection.appendChild(allCollections);
  for (const entry of snapshot.collections) {
    const option = element(document, "option");
    option.value = String(entry.collectionID);
    option.textContent = `${"  ".repeat(entry.depth)}${entry.name}`;
    collection.appendChild(option);
  }
  const tag = element(document, "select", "cm-select");
  tag.setAttribute("aria-label", "Tag filter");
  const allTags = element(document, "option");
  allTags.value = "all";
  allTags.textContent = "All tags";
  tag.appendChild(allTags);
  for (const value of snapshot.tags) {
    const option = element(document, "option");
    option.value = value;
    option.textContent = value;
    tag.appendChild(option);
  }
  const collectionLabel = element(document, "label", "cm-filter-select");
  collectionLabel.append(text(document, "span", "Library"), collection);
  const tagLabel = element(document, "label", "cm-filter-select");
  tagLabel.append(text(document, "span", "Tag"), tag);
  filterPanel.append(
    includeMissingYear,
    includeMissingCitations,
    includeMissingReferences,
    openAccessOnly,
    excludeRetracted,
    collectionLabel,
    tagLabel,
  );
  root.appendChild(filterPanel);

  const main = element(document, "main", "cm-main");
  const graphArea = element(document, "section", "cm-graph-area");
  const canvas = element(document, "canvas", "cm-graph-canvas");
  canvas.setAttribute(
    "aria-label",
    "Interactive citation graph. Arrows point from citing papers to cited papers.",
  );
  graphArea.appendChild(canvas);
  const zoom = element(document, "div", "cm-zoom-controls");
  for (const [action, label, description] of [
    ["in", "+", "Zoom in"],
    ["out", "−", "Zoom out"],
    ["fit", "⌖", "Fit graph to view"],
  ]) {
    const button = element(document, "button", "cm-overlay-button");
    button.type = "button";
    button.dataset.action = action;
    button.textContent = label;
    button.title = description;
    zoom.appendChild(button);
  }
  graphArea.appendChild(zoom);
  let currentLayout = initialLayout;
  let sourceMetricsRefreshActive = false;
  const refreshSourceMetricsForLayout = (layout: GraphLayoutOptions): void => {
    if (!graphLayoutUsesSourceMetrics(layout) || sourceMetricsRefreshActive)
      return;
    sourceMetricsRefreshActive = true;
    const candidates = model.nodes.filter((node) => visibleKeys.has(node.key));
    void ensureSourceMetricsForNodes(candidates, () => {
      if (cleaned || !graphLayoutUsesSourceMetrics(currentLayout)) return;
      renderer?.setLayout(currentLayout);
      renderer?.fitView();
    })
      .then((updated) => {
        if (
          !updated ||
          cleaned ||
          !graphLayoutUsesSourceMetrics(currentLayout)
        ) {
          return;
        }
        renderer?.setLayout(currentLayout);
        renderer?.fitView();
        if (selectedNode) renderOverview(selectedNode);
      })
      .finally(() => {
        sourceMetricsRefreshActive = false;
      });
  };
  const appearance = createAxesAppearance(document, initialLayout, (layout) => {
    currentLayout = layout;
    renderer?.setLayout(layout);
    renderer?.fitView();
    refreshSourceMetricsForLayout(layout);
  });
  graphArea.appendChild(appearance.root);

  const detailShell = element(document, "div", "cm-detail-shell");
  const resizer = element(document, "div", "cm-detail-resizer");
  resizer.tabIndex = 0;
  resizer.setAttribute("role", "separator");
  const detail = element(document, "aside", "cm-detail-panel");
  detailShell.append(resizer, detail);
  const initialWidth = clamp(
    getDetailPanelWidth(),
    260,
    Math.max(260, (mount.getBoundingClientRect().width || 900) * 0.7),
  );
  const collapsed = getDetailPanelCollapsed();
  detailShell.style.width = collapsed ? "8px" : `${initialWidth}px`;
  detailShell.dataset.collapsed = String(collapsed);
  main.append(graphArea, detailShell);
  root.appendChild(main);
  mount.appendChild(root);

  const updateSummary = (): void => {
    summary.textContent = `${formatCount(visibleKeys.size)} papers - ${formatCount(renderer?.getVisibleEdgeCount() ?? 0)} citation links`;
  };

  const showLoading = (heading: string): void => {
    clear(detail);
    detail.append(
      text(document, "h2", heading),
      text(document, "p", "Loading…", "cm-placeholder"),
    );
  };

  const renderExternalWorks = (
    headingValue: string,
    works: ExternalWork[],
    backNode: CitationGraphNode | null,
  ): void => {
    clear(detail);
    const heading = element(document, "div", "cm-detail-heading");
    const back = element(document, "button", "cm-secondary-button");
    back.type = "button";
    back.textContent = "Back";
    back.addEventListener("click", () => renderOverview(backNode));
    heading.append(back, text(document, "h2", headingValue));
    detail.appendChild(heading);
    if (!works.length) {
      detail.append(
        text(document, "p", "No external works were found.", "cm-placeholder"),
      );
      return;
    }
    const list = element(document, "div", "cm-external-list");
    const rendered: Array<{
      work: ExternalWork;
      card: HTMLElement;
      title: HTMLElement;
      metadata: HTMLElement;
    }> = [];
    for (const work of works) {
      const card = element(document, "article", "cm-external-card");
      if (work.isRetracted) card.classList.add("cm-external-retracted");
      const title = text(document, "h3", externalWorkTitle(work));
      const metadata = text(
        document,
        "p",
        externalWorkMetadataText(work),
        "cm-detail-meta",
      );
      card.append(title, metadata);
      const badges = element(document, "div", "cm-badges");
      if (work.inLibraryItemKey)
        badges.append(text(document, "span", "In Zotero"));
      if (work.isOpenAccess)
        badges.append(text(document, "span", "Open Access"));
      if (work.isRetracted)
        badges.append(text(document, "span", "Retracted", "cm-badge-danger"));
      if (badges.childElementCount) card.appendChild(badges);
      if (work.abstract) {
        const disclosure = element(
          document,
          "details",
          "cm-abstract-disclosure",
        );
        disclosure.append(
          text(document, "summary", "Abstract"),
          text(document, "p", work.abstract),
        );
        card.appendChild(disclosure);
      }
      const cardActions = element(document, "div", "cm-detail-actions");
      if (work.doi) {
        const open = element(document, "button", "cm-secondary-button");
        open.type = "button";
        open.textContent = "Open DOI";
        open.addEventListener("click", () =>
          Zotero.launchURL(
            `https://doi.org/${encodeURIComponent(work.doi ?? "")}`,
          ),
        );
        cardActions.appendChild(open);
      }
      if (work.inLibraryItemKey) {
        const paper = paperByKey.get(work.inLibraryItemKey);
        const show = element(document, "button", "cm-primary-button");
        show.type = "button";
        show.textContent = "Show in Zotero";
        show.addEventListener("click", () => {
          if (paper) void selectPaper(paper.itemID);
        });
        cardActions.appendChild(show);
      } else {
        const add = element(document, "button", "cm-primary-button");
        add.type = "button";
        add.textContent = "Add to Zotero";
        const importArea = element(document, "div", "cm-import-area");
        importArea.hidden = true;
        const chooser = createCollectionChooser(document, snapshot);
        const confirm = element(document, "button", "cm-primary-button");
        confirm.type = "button";
        confirm.textContent = "Add paper";
        const cancel = element(document, "button", "cm-secondary-button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        confirm.addEventListener("click", async () => {
          confirm.disabled = true;
          confirm.textContent = "Adding…";
          try {
            const items = await importExternalWork(work, snapshot.libraryID, [
              ...chooser.selected,
            ]);
            const imported = items[0];
            if (!imported) throw new Error("No item was imported.");
            work.inLibraryItemKey = String(imported.key);
            importArea.replaceChildren(
              text(document, "p", "Added to Zotero.", "cm-success"),
            );
            add.remove();
          } catch (error) {
            Zotero.logError(
              error instanceof Error ? error : new Error(String(error)),
            );
            confirm.disabled = false;
            confirm.textContent = "Import failed — try again";
          }
        });
        cancel.addEventListener("click", () => {
          importArea.hidden = true;
          add.hidden = false;
        });
        const buttons = element(document, "div", "cm-detail-actions");
        buttons.append(cancel, confirm);
        importArea.append(
          text(document, "h4", "Choose collections"),
          chooser.root,
          buttons,
        );
        add.addEventListener("click", () => {
          add.hidden = true;
          importArea.hidden = false;
        });
        cardActions.appendChild(add);
        card.appendChild(importArea);
      }
      card.appendChild(cardActions);
      if (work.citingNodeKeys?.length) {
        const preview: GhostPreview = {
          key: work.providerWorkID ?? work.doi ?? work.title ?? "external",
          title: work.title ?? "Untitled",
          year: work.year,
          citationCount: work.citationCount ?? null,
          referenceCount: work.referenceCount ?? null,
          sourceKeys: work.citingNodeKeys,
        };
        card.addEventListener("mouseenter", () =>
          renderer?.setGhostPreview(preview),
        );
        card.addEventListener("mouseleave", () =>
          renderer?.setGhostPreview(null),
        );
      }
      rendered.push({ work, card, title, metadata });
      list.appendChild(card);
    }
    detail.appendChild(list);
    void hydrateExternalWorksMetadata(works)
      .then((hydrated) => {
        if (cleaned) return;
        for (let index = 0; index < rendered.length; index += 1) {
          const target = rendered[index];
          const resolved = hydrated[index];
          if (!resolved) continue;
          Object.assign(target.work, resolved);
          if (!target.card.isConnected) continue;
          target.title.textContent = externalWorkTitle(target.work);
          target.metadata.textContent = externalWorkMetadataText(target.work);
        }
      })
      .catch((error: unknown) =>
        Zotero.debug(
          `Citation Map: external metadata hydration failed: ${String(error)}`,
        ),
      );
  };

  const showRelationList = async (
    node: CitationGraphNode,
    direction: "references" | "cited-by",
  ): Promise<void> => {
    const titleValue = direction === "references" ? "References" : "Cited by";
    showLoading(titleValue);
    try {
      const works =
        direction === "references"
          ? await getExternalReferences(node, model.nodes, 100)
          : await getExternalCitedBy(node, model.nodes, 100);
      if (!cleaned) renderExternalWorks(titleValue, works, node);
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
      if (!cleaned) renderExternalWorks(titleValue, [], node);
    }
  };

  const renderOverview = (node: CitationGraphNode | null): void => {
    renderer?.setGhostPreview(null);
    clear(detail);
    if (!node) {
      selectedNode = null;
      detail.append(
        text(document, "h2", "Paper details"),
        text(
          document,
          "p",
          "Select a paper to inspect its metrics, references and citing works.",
          "cm-placeholder",
        ),
      );
      return;
    }
    selectedNode = node;
    detail.append(text(document, "h2", node.title));
    detail.append(
      text(
        document,
        "p",
        [node.authors.slice(0, 5).join(", "), node.sourceTitle, node.year]
          .filter(Boolean)
          .join(" · "),
        "cm-detail-meta",
      ),
    );
    const badges = element(document, "div", "cm-badges");
    if (node.isOpenAccess) badges.append(text(document, "span", "Open Access"));
    if (node.isRetracted)
      badges.append(text(document, "span", "Retracted", "cm-badge-danger"));
    if (node.isTop1Percent) badges.append(text(document, "span", "Top 1%"));
    else if (node.isTop10Percent)
      badges.append(text(document, "span", "Top 10%"));
    if (!node.matchConfirmed)
      badges.append(
        text(document, "span", "Match needs confirmation", "cm-badge-warning"),
      );
    if (badges.childElementCount) detail.appendChild(badges);
    const tabs = element(document, "div", "cm-detail-tabs");
    for (const [mode, label] of [
      ["overview", "Overview"],
      ["cited-by", "Cited by"],
      ["references", "References"],
    ]) {
      const button = element(document, "button");
      button.type = "button";
      button.dataset.mode = mode;
      button.textContent = label;
      if (mode === "overview") button.dataset.selected = "true";
      tabs.appendChild(button);
    }
    detail.appendChild(tabs);
    const rows = element(document, "dl", "cm-metric-list");
    const appendMetric = (
      label: string,
      value: string,
      titleValue?: string,
    ): void => {
      const term = text(document, "dt", label);
      if (titleValue) term.title = titleValue;
      rows.append(term, text(document, "dd", value));
    };
    appendMetric("Citations", formatCount(node.citationCount));
    appendMetric("References", formatCount(node.referenceCount));
    appendMetric(
      "Citation rate",
      node.citationVelocity === null
        ? "—"
        : `${formatMetricValue("citation-rate", node.citationVelocity)}/year`,
      getMetricDefinition("citation-rate").description,
    );
    appendMetric("FWCI", formatMetricValue("fwci", node.fwci));
    appendMetric(
      "Journal h-index",
      formatMetricValue("journal-h-index", node.sourceMetrics?.hIndex ?? null),
      getMetricDefinition("journal-h-index").description,
    );
    appendMetric(
      "2-year mean citedness",
      formatMetricValue(
        "two-year-mean-citedness",
        node.sourceMetrics?.twoYearMeanCitedness ?? null,
      ),
      getMetricDefinition("two-year-mean-citedness").description,
    );
    appendMetric(
      "Citation percentile",
      formatMetricValue("citation-percentile", node.citationPercentile),
    );
    appendMetric(
      "Library coverage",
      formatMetricValue("library-coverage", node.libraryCoverage),
    );
    appendMetric("Provider", node.provider ?? "—");
    appendMetric(
      "Updated",
      node.metricsUpdatedAt
        ? new Date(node.metricsUpdatedAt).toLocaleString()
        : "—",
    );
    detail.appendChild(rows);
    const actions = element(document, "div", "cm-detail-actions");
    const show = element(document, "button", "cm-primary-button");
    show.type = "button";
    show.textContent = "Show in Zotero";
    show.addEventListener("click", () => void selectPaper(node.itemID));
    actions.appendChild(show);
    if (node.doi) {
      const doi = element(document, "button", "cm-secondary-button");
      doi.type = "button";
      doi.textContent = "Open DOI";
      doi.addEventListener("click", () =>
        Zotero.launchURL(
          `https://doi.org/${encodeURIComponent(node.doi ?? "")}`,
        ),
      );
      actions.appendChild(doi);
    }
    detail.appendChild(actions);
    tabs.addEventListener("click", (event) => {
      const target = (event.target as Element).closest(
        "button",
      ) as HTMLButtonElement | null;
      if (target?.dataset.mode === "cited-by")
        void showRelationList(node, "cited-by");
      if (target?.dataset.mode === "references")
        void showRelationList(node, "references");
    });
  };

  renderer = new CitationGraphRenderer({
    canvas,
    model,
    layout: initialLayout,
    collectionColorsByNodeKey: visuals.colorsByNodeKey,
    collectionLabelsByNodeKey: visuals.labelsByNodeKey,
    onSelectionChange: renderOverview,
    onOpenNode: (node) => void selectPaper(node.itemID),
    onBackgroundInteraction: appearance.close,
  });
  renderOverview(null);
  refreshSourceMetricsForLayout(initialLayout);

  const onGraphAreaPointerDown = (event: PointerEvent): void => {
    const target = event.target as Element | null;
    if (!target || appearance.root.contains(target)) return;
    if (target !== canvas) {
      // Graph controls, including zoom and appearance controls, must not
      // discard the currently selected paper.
      appearance.close();
    }
  };
  graphArea.addEventListener("pointerdown", onGraphAreaPointerDown, true);

  const selectedCollection = (): LibraryCollectionFilter | null => {
    const id = Number(collection.value);
    return Number.isFinite(id)
      ? (snapshot.collections.find((entry) => entry.collectionID === id) ??
          null)
      : null;
  };
  const checked = (wrapper: HTMLElement): boolean =>
    (wrapper.querySelector("input") as HTMLInputElement).checked;
  const applyFilters = (): void => {
    const selected = selectedCollection();
    const allowedCollections = selected
      ? new Set(selected.includedCollectionIDs)
      : null;
    const tokens = normalizeSearch(search.value).split(/\s+/).filter(Boolean);
    visibleKeys = new Set(
      model.nodes
        .filter((node) => {
          const paper = paperByKey.get(node.itemKey);
          if (!paper) return false;
          if (
            allowedCollections &&
            !node.collectionIDs.some((id) => allowedCollections.has(id))
          )
            return false;
          if (tag.value !== "all" && !node.tags.includes(tag.value))
            return false;
          if (!checked(includeMissingYear) && node.year === null) return false;
          if (!checked(includeMissingCitations) && node.citationCount === null)
            return false;
          if (
            !checked(includeMissingReferences) &&
            node.referenceCount === null
          )
            return false;
          if (checked(openAccessOnly) && !node.isOpenAccess) return false;
          if (checked(excludeRetracted) && node.isRetracted) return false;
          const searchable = paperSearchText(paper);
          return tokens.every((token) => searchable.includes(token));
        })
        .map((node) => node.key),
    );
    renderer?.setVisibleKeys(visibleKeys);
    const matches = tokens.length ? new Set(visibleKeys) : null;
    renderer?.setSearchMatches(matches);
    updateSummary();
  };
  search.addEventListener("input", applyFilters);
  collection.addEventListener("change", applyFilters);
  tag.addEventListener("change", applyFilters);
  for (const wrapper of [
    includeMissingYear,
    includeMissingCitations,
    includeMissingReferences,
    openAccessOnly,
    excludeRetracted,
  ]) {
    wrapper.querySelector("input")?.addEventListener("change", applyFilters);
  }
  filterButton.addEventListener("click", () => {
    filterPanel.hidden = !filterPanel.hidden;
    filterButton.setAttribute("aria-expanded", String(!filterPanel.hidden));
  });
  similarButton.addEventListener("click", async () => {
    showLoading("Similar papers");
    similarButton.disabled = true;
    try {
      const visibleNodes = model.nodes.filter((node) =>
        visibleKeys.has(node.key),
      );
      const works = await getMissingPaperRecommendations(
        visibleNodes,
        model.nodes,
        50,
        2,
      );
      if (!cleaned) renderExternalWorks("Similar papers", works, selectedNode);
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
      if (!cleaned) renderExternalWorks("Similar papers", [], selectedNode);
    } finally {
      similarButton.disabled = false;
    }
  });
  exportButton.addEventListener("click", () => {
    exportMenu.hidden = !exportMenu.hidden;
    exportButton.setAttribute("aria-expanded", String(!exportMenu.hidden));
  });
  exportMenu.addEventListener("click", (event) => {
    const target = (event.target as Element).closest(
      "button",
    ) as HTMLButtonElement | null;
    if (!target || !renderer) return;
    exportMenu.hidden = true;
    if (target.dataset.format === "png")
      exportGraphPNG(document, renderer.getCanvas(), snapshot);
    else if (target.dataset.format === "json")
      exportGraphJSON(document, snapshot, model, visibleKeys);
    else if (target.dataset.format === "csv")
      exportGraphCSV(document, snapshot, model, visibleKeys);
  });
  refreshButton.addEventListener("click", () => {
    applyFilters();
    renderer?.fitView();
  });
  zoom.addEventListener("click", (event) => {
    const target = (event.target as Element).closest(
      "button",
    ) as HTMLButtonElement | null;
    if (target?.dataset.action === "in") renderer?.zoomBy(1.22);
    if (target?.dataset.action === "out") renderer?.zoomBy(1 / 1.22);
    if (target?.dataset.action === "fit") renderer?.fitView();
  });

  let resizing = false;
  const resize = (event: PointerEvent): void => {
    if (!resizing) return;
    const bounds = root.getBoundingClientRect();
    const width = clamp(bounds.right - event.clientX, 260, bounds.width * 0.7);
    detailShell.style.width = `${width}px`;
    detailShell.dataset.collapsed = "false";
    renderer?.resizeViewport();
  };
  resizer.addEventListener("pointerdown", (event) => {
    resizing = true;
    resizer.setPointerCapture?.(event.pointerId);
  });
  resizer.addEventListener("pointermove", resize);
  resizer.addEventListener("pointerup", (event) => {
    resizing = false;
    resizer.releasePointerCapture?.(event.pointerId);
    const width = detailShell.getBoundingClientRect().width;
    if (width <= 14) {
      detailShell.style.width = "8px";
      detailShell.dataset.collapsed = "true";
      setDetailPanelCollapsed(true);
    } else {
      setDetailPanelWidth(width);
      setDetailPanelCollapsed(false);
    }
  });
  resizer.addEventListener("dblclick", () => {
    const next = detailShell.dataset.collapsed !== "true";
    detailShell.dataset.collapsed = String(next);
    detailShell.style.width = next ? "8px" : `${getDetailPanelWidth()}px`;
    setDetailPanelCollapsed(next);
    renderer?.resizeViewport();
  });

  if (options.initialItemID) {
    const initial = model.nodes.find(
      (node) => node.itemID === options.initialItemID,
    );
    if (initial) renderer.selectNode(initial.key);
  }
  updateSummary();
  const cleanup = (): void => {
    cleaned = true;
    graphArea.removeEventListener("pointerdown", onGraphAreaPointerDown, true);
    renderer?.destroy();
    renderer = null;
  };
  cleanupByMount.set(mount, cleanup);
  return root;
}
