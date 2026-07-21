/// <reference lib="dom" />

import { config } from "../../package.json";
import type {
  CitationProviderID,
  IgnoredProviderRelation,
  ManualRelationDirection,
  RelatedWorkMetadata,
} from "../domain/citationTypes";
import type {
  CitationGraphNode,
  GraphAxisMetric,
  GraphLayoutOptions,
  GraphNodeColorMetric,
  GraphNodeSizeMetric,
  GraphScaleType,
  MetricID,
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
  externalWorkDisplayTitle,
  getMissingPaperRecommendations,
  refreshExternalRelationships,
  importExternalWork,
  type ExternalWork,
} from "./externalDiscoveryService";
import {
  getCitationMetricRecord,
  getIgnoredRelations,
  ignoreProviderRelation,
  removeIgnoredRelation,
} from "./citationMetricsStore";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";
import {
  getRelationshipReportedCounts,
  getRelationshipViewSnapshot,
  RELATIONSHIP_VIEW_LIMIT,
  notifyRelationshipMutation,
  relationshipPreviewSourceKeys,
  relationshipStatusText,
  relationshipWorkKey,
  subscribeRelationshipMutations,
  type RelationshipMutationEvent,
} from "./relationshipViewService";
import {
  createPaperFilterController,
  createPaperListToolbar,
  describeExternalWork,
  describeZoteroPaper,
  type PaperListDescriptor,
} from "./paperListViewService";
import {
  createManualRelationshipPicker,
  type ManualRelationshipChange,
} from "./manualRelationshipPickerService";
import {
  exportGraphCSV,
  exportGraphJSON,
  exportGraphPNG,
} from "./exportService";
import {
  axisMetricDefinitions,
  formatMetricValue,
  getMetricDefinition,
  metricValue,
  nodeColorMetricDefinitions,
  nodeSizeMetricDefinitions,
} from "./metricRegistry";
import { createMetricNodeForItem } from "./itemMetricContext";
import { createPaperOverviewActionBar } from "./paperOverviewActionsService";
import { updateCitationDataForItems } from "./citationUpdateService";
import { createUpdateProgress } from "./updateProgressService";
import {
  createCitationMapIcon,
  type CitationMapIconName,
} from "./uiIconService";
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

function icon(document: Document, name: CitationMapIconName): SVGSVGElement {
  return createCitationMapIcon(document, name);
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

function externalProviderLabel(work: ExternalWork): string {
  switch (work.provider) {
    case "semantic-scholar":
      return "Semantic Scholar";
    case "openalex":
      return "OpenAlex";
    case "opencitations":
      return "OpenCitations";
    case "inspire":
      return "INSPIRE";
    case "crossref":
      return "Crossref";
    case "manual":
      return "manual";
    case "zotero":
      return "Zotero";
    default:
      return "provider";
  }
}

function externalWorkURL(work: ExternalWork): string | null {
  const doi = work.doi?.trim();
  if (doi) return `https://doi.org/${encodeURIComponent(doi)}`;
  const id = work.providerWorkID?.trim();
  if (!id) return null;
  switch (work.provider) {
    case "semantic-scholar":
      return `https://www.semanticscholar.org/paper/${encodeURIComponent(id)}`;
    case "openalex":
      return id.startsWith("http")
        ? id
        : `https://openalex.org/${encodeURIComponent(id)}`;
    case "inspire":
      return `https://inspirehep.net/literature/${encodeURIComponent(id)}`;
    case "crossref":
    case "opencitations":
      return id.includes("/")
        ? `https://doi.org/${encodeURIComponent(id)}`
        : null;
    case "manual":
    case "zotero":
      return null;
    default:
      return null;
  }
}

function externalWorkTitle(work: ExternalWork): string {
  return externalWorkDisplayTitle(work) ?? "Title unavailable";
}

function externalWorkAuthorsText(work: ExternalWork): string {
  return work.authors.length
    ? work.authors.slice(0, 6).join(", ")
    : "Authors unavailable";
}

function externalWorkMetadataText(work: ExternalWork): string {
  return [
    work.sourceTitle,
    work.year,
    work.citationCount === null || work.citationCount === undefined
      ? ""
      : `${formatCount(work.citationCount)} citations`,
    work.referenceCount === null || work.referenceCount === undefined
      ? ""
      : `${formatCount(work.referenceCount)} references`,
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

interface SelectableMetricDefinition {
  id: MetricID;
  label: string;
  description: string;
  interpretation?: string;
}

function metricHasData(nodes: CitationGraphNode[], metric: MetricID): boolean {
  return nodes.some((node) => {
    const value = metricValue(node, metric);
    return typeof value === "number" && Number.isFinite(value);
  });
}

function createMetricSelect(
  document: Document,
  definitions: ReadonlyArray<SelectableMetricDefinition>,
  nodes: CitationGraphNode[],
  selected: string,
  includeFree = false,
): HTMLSelectElement {
  const select = element(document, "select", "cm-select");
  if (includeFree) {
    const option = element(document, "option");
    option.value = "free";
    option.textContent = "Free";
    option.title =
      "Position nodes freely along this axis. Drag a node to move it along every free axis.";
    option.dataset.metricDescription = option.title;
    select.appendChild(option);
  }
  for (const definition of definitions) {
    if (!metricHasData(nodes, definition.id)) continue;
    const option = element(document, "option");
    option.value = definition.id;
    option.textContent = definition.label;
    option.title = metricDescription(definition);
    option.dataset.metricDescription = option.title;
    select.appendChild(option);
  }
  const selectedOption = Array.from(select.options).find(
    (option) => option.value === selected && !option.disabled,
  );
  select.value = selectedOption?.value ?? select.options[0]?.value ?? "";
  return select;
}

function appendMetricOption(
  document: Document,
  select: HTMLSelectElement,
  value: string,
  label: string,
  description: string,
): void {
  const option = element(document, "option");
  option.value = value;
  option.textContent = label;
  option.title = description;
  option.dataset.metricDescription = description;
  select.appendChild(option);
}

function selectAvailableValue(
  select: HTMLSelectElement,
  requested: string,
): void {
  const requestedOption = Array.from(select.options).find(
    (option) => option.value === requested && !option.disabled,
  );
  const fallback = Array.from(select.options).find(
    (option) => !option.disabled,
  );
  select.value = requestedOption?.value ?? fallback?.value ?? "";
}

function createScaleSelect(
  document: Document,
  selected: GraphScaleType,
): HTMLSelectElement {
  const select = element(document, "select", "cm-select");
  for (const [value, label] of [
    ["linear", "Lin"],
    ["log", "Log"],
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

function createAxesAppearance(
  document: Document,
  initial: GraphLayoutOptions,
  nodes: CitationGraphNode[],
  onChange: (layout: GraphLayoutOptions) => void,
  onLegendChange: (visible: boolean) => void,
): {
  root: HTMLDivElement;
  button: HTMLButtonElement;
  panel: HTMLDivElement;
  setLayout: (layout: GraphLayoutOptions) => void;
  getLayout: () => GraphLayoutOptions;
  getLegendVisible: () => boolean;
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
  button.title = "Graph display settings";
  button.setAttribute("aria-label", "Graph display settings");
  button.setAttribute("aria-expanded", "false");

  const panel = element(document, "div", "cm-appearance-panel");
  panel.hidden = true;
  panel.style.display = "none";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Graph display settings");
  panel.style.width = "min(390px, calc(100vw - 38px))";

  const xMetric = createMetricSelect(
    document,
    axisMetricDefinitions(),
    nodes,
    initial.xMetric,
    true,
  );
  const xScale = createScaleSelect(document, initial.xScale);
  const yMetric = createMetricSelect(
    document,
    axisMetricDefinitions(),
    nodes,
    initial.yMetric,
    true,
  );
  const yScale = createScaleSelect(document, initial.yScale);
  const sizeMetric = createMetricSelect(
    document,
    nodeSizeMetricDefinitions(),
    nodes,
    initial.nodeSizeMetric,
  );
  const uniform = element(document, "option");
  uniform.value = "uniform";
  uniform.textContent = "Uniform";
  uniform.title = "Display every visible node with the same size.";
  uniform.dataset.metricDescription = uniform.title;
  sizeMetric.prepend(uniform);
  selectAvailableValue(sizeMetric, initial.nodeSizeMetric);

  const colorMetric = element(document, "select", "cm-select");
  const categoricalDefinitions: Array<{
    value: GraphNodeColorMetric;
    label: string;
    description: string;
    available: boolean;
  }> = [
    {
      value: "collection",
      label: "Collection",
      description: "Colour nodes by their Zotero collection membership.",
      available: nodes.some((node) => node.collectionIDs.length > 0),
    },
    {
      value: "publication-type",
      label: "Publication type",
      description:
        "Colour nodes by the publication type reported by the provider.",
      available: nodes.some((node) => Boolean(node.publicationType)),
    },
    {
      value: "provider",
      label: "Provider",
      description:
        "Colour nodes by the scholarly-data provider used for the item.",
      available: nodes.some((node) => Boolean(node.provider)),
    },
    {
      value: "open-access",
      label: "Open Access",
      description: "Distinguish works with known open-access status.",
      available: nodes.some(
        (node) => node.isOpenAccess !== null || Boolean(node.openAccessStatus),
      ),
    },
    {
      value: "retraction",
      label: "Retraction",
      description: "Distinguish works with known retraction status.",
      available: nodes.some((node) => node.isRetracted !== null),
    },
  ];
  for (const definition of categoricalDefinitions) {
    if (!definition.available) continue;
    appendMetricOption(
      document,
      colorMetric,
      definition.value,
      definition.label,
      definition.description,
    );
  }
  for (const definition of nodeColorMetricDefinitions()) {
    if (!metricHasData(nodes, definition.id)) continue;
    appendMetricOption(
      document,
      colorMetric,
      definition.id,
      definition.label,
      metricDescription(definition),
    );
  }
  if (!colorMetric.options.length) {
    appendMetricOption(
      document,
      colorMetric,
      "provider",
      "Uniform",
      "No node colour metric has data for the currently loaded papers.",
    );
  }
  selectAvailableValue(colorMetric, initial.nodeColorMetric);

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

  const legendPreferenceKey = `${config.prefsPrefix}.graphShowLegend`;
  const storedLegend = Zotero.Prefs.get(legendPreferenceKey, true);
  const showLegend = element(document, "input");
  showLegend.type = "checkbox";
  showLegend.checked =
    storedLegend === undefined || storedLegend === null
      ? true
      : Boolean(storedLegend);

  const tabs = element(document, "div", "cm-detail-tabs");
  tabs.style.marginTop = "0";
  const panes = new Map<string, HTMLDivElement>();
  const tabButtons = new Map<string, HTMLButtonElement>();
  const activate = (id: string): void => {
    for (const [key, pane] of panes) {
      const selected = key === id;
      pane.hidden = !selected;
      pane.style.display = selected ? "block" : "none";
      pane.setAttribute("aria-hidden", String(!selected));
    }
    for (const [key, tab] of tabButtons) {
      const selected = key === id;
      tab.dataset.selected = String(selected);
      tab.setAttribute("aria-selected", String(selected));
    }
  };
  const makePane = (id: string, label: string): HTMLDivElement => {
    const tab = element(document, "button");
    tab.type = "button";
    tab.textContent = label;
    tab.dataset.selected = "false";
    tab.setAttribute("role", "tab");
    tabs.appendChild(tab);
    tabButtons.set(id, tab);
    const pane = element(document, "div", "cm-appearance-section");
    pane.hidden = true;
    pane.style.display = "none";
    pane.style.margin = "8px 0 0";
    pane.style.border = "0";
    pane.style.padding = "0";
    pane.setAttribute("role", "tabpanel");
    panes.set(id, pane);
    tab.addEventListener("click", () => activate(id));
    return pane;
  };

  const compactLine = (...controls: HTMLElement[]): HTMLDivElement => {
    const line = element(document, "div", "cm-appearance-row");
    line.style.display = "flex";
    line.style.gridTemplateColumns = "none";
    line.style.alignItems = "center";
    line.style.gap = "6px";
    for (const control of controls) line.appendChild(control);
    return line;
  };
  const labelledLine = (
    label: string,
    control: HTMLElement,
    trailing?: HTMLElement,
  ): HTMLDivElement => {
    const line = compactLine(text(document, "span", label), control);
    const labelNode = line.firstElementChild as HTMLElement | null;
    if (labelNode) labelNode.style.flex = "0 0 44px";
    control.style.flex = "1 1 auto";
    if (trailing) line.appendChild(trailing);
    return line;
  };

  xScale.style.flex = "0 0 64px";
  xMetric.style.flex = "1 1 auto";
  yScale.style.flex = "0 0 64px";
  yMetric.style.flex = "1 1 auto";

  const xPane = makePane("x", "X axis");
  xPane.append(
    compactLine(xScale, xMetric),
    createMetricHelp(document, xMetric, "Choose horizontal position."),
  );
  const yPane = makePane("y", "Y axis");
  yPane.append(
    compactLine(yScale, yMetric),
    createMetricHelp(document, yMetric, "Choose vertical position."),
  );
  const nodesPane = makePane("nodes", "Nodes");
  const legendLabel = element(document, "label", "cm-check-control");
  legendLabel.style.whiteSpace = "nowrap";
  legendLabel.append(showLegend, document.createTextNode("Show legend"));
  nodesPane.append(
    labelledLine("Label", labels),
    labelledLine("Size", sizeMetric),
    createMetricHelp(
      document,
      sizeMetric,
      "Visible minimum and maximum values map to the plugin minimum and maximum node sizes.",
    ),
    labelledLine("Color", colorMetric, legendLabel),
    createMetricHelp(document, colorMetric, "Choose node colour."),
  );

  panel.append(tabs, xPane, yPane, nodesPane);
  const actions = element(document, "div", "cm-appearance-actions");
  const reset = element(document, "button", "cm-secondary-button");
  reset.type = "button";
  reset.textContent = "Reset";
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
    const categoricalValues = new Set([
      "collection",
      "publication-type",
      "provider",
      "open-access",
      "retraction",
    ]);
    showLegend.disabled = categoricalValues.has(colorMetric.value);
    legendLabel.title = showLegend.disabled
      ? "A numeric legend is available when Color uses a numeric metric."
      : "Show or hide the numeric color legend on the graph.";
  };
  let last = JSON.stringify(read());
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
  showLegend.addEventListener("change", () => {
    Zotero.Prefs.set(legendPreferenceKey, showLegend.checked, true);
    onLegendChange(showLegend.checked);
  });

  const close = (): void => {
    panel.hidden = true;
    panel.style.display = "none";
    button.setAttribute("aria-expanded", "false");
  };
  button.addEventListener("click", () => {
    if (panel.hidden) {
      panel.hidden = false;
      panel.style.display = "block";
      button.setAttribute("aria-expanded", "true");
      activate("x");
    } else {
      close();
    }
  });
  const setControls = (layout: GraphLayoutOptions): void => {
    selectAvailableValue(xMetric, layout.xMetric);
    xScale.value = layout.xScale;
    selectAvailableValue(yMetric, layout.yMetric);
    yScale.value = layout.yScale;
    selectAvailableValue(sizeMetric, layout.nodeSizeMetric);
    selectAvailableValue(colorMetric, layout.nodeColorMetric);
    labels.value = layout.nodeLabelMode;
    updateAvailability();
  };
  const setLayout = (layout: GraphLayoutOptions): void => {
    setControls(layout);
    commit(read(), true);
  };
  reset.addEventListener("click", () => {
    showLegend.checked = true;
    Zotero.Prefs.set(legendPreferenceKey, true, true);
    onLegendChange(true);
    setLayout(resetGraphAppearance());
  });
  updateAvailability();
  activate("x");
  const normalizedInitial = read();
  if (JSON.stringify(normalizedInitial) !== JSON.stringify(initial)) {
    setGraphAppearance(normalizedInitial);
    last = JSON.stringify(normalizedInitial);
  }
  return {
    root,
    button,
    panel,
    setLayout,
    getLayout: read,
    getLegendVisible: () => showLegend.checked,
    close,
  };
}

function localPaperByKey(snapshot: LibrarySnapshot): Map<string, ZoteroPaper> {
  return new Map(snapshot.papers.map((paper) => [paper.itemKey, paper]));
}

function relationshipDirection(
  direction: "references" | "cited-by",
): ManualRelationDirection {
  return direction === "references" ? "reference" : "cited-by";
}

function graphNodeLibraryID(node: CitationGraphNode): number {
  const item = Zotero.Items.get(node.itemID) as Zotero.Item | null;
  return Number(item?.libraryID ?? Zotero.Libraries.userLibraryID);
}

function referenceMatchesExternalWork(
  reference: RelatedWorkMetadata,
  work: ExternalWork,
): boolean {
  const referenceDOI = normalizeDOI(reference.doi);
  const workDOI = normalizeDOI(work.doi);
  if (referenceDOI && workDOI && referenceDOI === workDOI) return true;
  if (
    reference.provider === work.provider &&
    reference.providerWorkID &&
    work.providerWorkID &&
    String(reference.providerWorkID).toLocaleLowerCase() ===
      String(work.providerWorkID).toLocaleLowerCase()
  ) {
    return true;
  }
  const referenceTitle = normalizeExactTitle(reference.title);
  const workTitle = normalizeExactTitle(work.title);
  if (!referenceTitle || !workTitle || referenceTitle !== workTitle)
    return false;
  return (
    reference.year === null ||
    work.year === null ||
    Math.abs(reference.year - work.year) <= 1
  );
}

function referenceMatchesGraphNode(
  reference: RelatedWorkMetadata,
  node: CitationGraphNode,
): boolean {
  const referenceDOI = normalizeDOI(reference.doi);
  const nodeDOI = normalizeDOI(node.doi);
  if (referenceDOI && nodeDOI && referenceDOI === nodeDOI) return true;
  if (
    reference.provider === node.provider &&
    reference.providerWorkID &&
    node.providerWorkID &&
    String(reference.providerWorkID).toLocaleLowerCase() ===
      String(node.providerWorkID).toLocaleLowerCase()
  ) {
    return true;
  }
  const referenceTitle = normalizeExactTitle(reference.title);
  const nodeTitle = normalizeExactTitle(node.title);
  if (!referenceTitle || !nodeTitle || referenceTitle !== nodeTitle)
    return false;
  return (
    reference.year === null ||
    node.year === null ||
    Math.abs(reference.year - node.year) <= 1
  );
}

function graphDescriptorFromReference(
  libraryID: number,
  subjectItemKey: string,
  reference: RelatedWorkMetadata,
): GraphIgnoredRelationDescriptor {
  return {
    libraryID,
    subjectItemKey,
    direction: "reference",
    provider:
      reference.provider === "manual" || reference.provider === "zotero"
        ? "crossref"
        : reference.provider,
    providerWorkID:
      reference.provider === "manual" || reference.provider === "zotero"
        ? null
        : reference.providerWorkID,
    doi: reference.doi,
    normalizedTitle: normalizeExactTitle(reference.title) || null,
  };
}

interface GraphIgnoredRelationDescriptor {
  libraryID: number;
  subjectItemKey: string;
  direction: ManualRelationDirection;
  provider: CitationProviderID;
  providerWorkID: string | null;
  doi: string | null;
  normalizedTitle: string | null;
}

function ignoredRelationDescriptorForExternalWork(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  work: ExternalWork,
): GraphIgnoredRelationDescriptor {
  const libraryID = graphNodeLibraryID(node);
  const relatedKey = work.inLibraryItemKey ?? work.zoteroItemKey;
  if (direction === "cited-by" && relatedKey) {
    const sourceRecord = getCitationMetricRecord(libraryID, relatedKey);
    const reference = sourceRecord?.references.find((candidate) =>
      referenceMatchesGraphNode(candidate, node),
    );
    if (reference) {
      return graphDescriptorFromReference(libraryID, relatedKey, reference);
    }
    return {
      libraryID,
      subjectItemKey: relatedKey,
      direction: "reference",
      provider: node.provider ?? "crossref",
      providerWorkID: node.providerWorkID,
      doi: node.doi,
      normalizedTitle: normalizeExactTitle(node.title) || null,
    };
  }
  if (direction === "references") {
    const sourceRecord = getCitationMetricRecord(libraryID, node.itemKey);
    const reference = sourceRecord?.references.find((candidate) =>
      referenceMatchesExternalWork(candidate, work),
    );
    if (reference) {
      return graphDescriptorFromReference(libraryID, node.itemKey, reference);
    }
  }
  return {
    libraryID,
    subjectItemKey: node.itemKey,
    direction: relationshipDirection(direction),
    provider: ignoreProviderForWork(work),
    providerWorkID:
      work.provider === "manual" || work.provider === "zotero"
        ? null
        : work.providerWorkID,
    doi: work.doi,
    normalizedTitle: normalizeExactTitle(work.title) || null,
  };
}

function ignoredRelationForExternalWork(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  work: ExternalWork,
): IgnoredProviderRelation | null {
  const descriptor = ignoredRelationDescriptorForExternalWork(
    node,
    direction,
    work,
  );
  return (
    getIgnoredRelations(descriptor.libraryID).find(
      (entry) =>
        entry.subjectItemKey === descriptor.subjectItemKey &&
        entry.direction === descriptor.direction &&
        ((entry.provider === descriptor.provider &&
          Boolean(entry.providerWorkID) &&
          String(entry.providerWorkID).toLocaleLowerCase() ===
            String(descriptor.providerWorkID ?? "").toLocaleLowerCase()) ||
          (Boolean(entry.doi) &&
            normalizeDOI(entry.doi) === normalizeDOI(descriptor.doi)) ||
          (Boolean(entry.normalizedTitle) &&
            entry.normalizedTitle === descriptor.normalizedTitle)),
    ) ?? null
  );
}

function ignoreProviderForWork(work: ExternalWork): CitationProviderID {
  return work.provider === "manual" || work.provider === "zotero"
    ? "crossref"
    : work.provider;
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
  let activeRelationshipView: {
    itemKey: string;
    direction: "references" | "cited-by";
  } | null = null;
  let renderer: CitationGraphRenderer | null = null;
  let cleaned = false;
  let applyFilters = (): void => undefined;
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
  const graphFilterDescriptors = new Map<string, PaperListDescriptor>();
  for (const node of model.nodes) {
    const paper = paperByKey.get(node.itemKey);
    if (!paper) continue;
    graphFilterDescriptors.set(node.key, {
      ...describeZoteroPaper(paper),
      year: node.year,
      citationCount: node.citationCount,
      referenceCount: node.referenceCount,
      tags: node.tags,
      collectionIDs: node.collectionIDs,
      isOpenAccess: node.isOpenAccess,
      isRetracted: node.isRetracted,
    });
  }
  const graphFilter = createPaperFilterController({
    document,
    collections: snapshot.collections,
    buttonClassName: "cm-toolbar-button",
    getDescriptors: () => [...graphFilterDescriptors.values()],
    onChange: () => applyFilters(),
  });
  const similarButton = element(document, "button", "cm-toolbar-button");
  similarButton.type = "button";
  similarButton.append(iconButtonContent(document, "similar", "Similar"));
  similarButton.title =
    "Find papers related to the currently visible graph and show them in a separate detail slide without adding them automatically.";
  const exportWrap = element(document, "div", "cm-menu-wrapper");
  const exportButton = element(document, "button", "cm-toolbar-button");
  exportButton.type = "button";
  exportButton.append(iconButtonContent(document, "export", "Export"));
  exportButton.title = "Export the currently visible citation graph.";
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
  refreshButton.title =
    "Check scholarly-data providers online and update Citation Map data for the currently visible papers.";
  toolbar.append(
    searchWrap,
    graphFilter.root,
    similarButton,
    exportWrap,
    refreshButton,
  );
  header.appendChild(toolbar);
  root.appendChild(header);

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
  const appearance = createAxesAppearance(
    document,
    initialLayout,
    model.nodes,
    (layout) => {
      currentLayout = layout;
      renderer?.setLayout(layout);
      renderer?.fitView();
      refreshSourceMetricsForLayout(layout);
    },
    (visible) => renderer?.setLegendVisible(visible),
  );
  currentLayout = appearance.getLayout();
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

  function appendPaperHeader(
    node: CitationGraphNode,
    activeMode: "overview" | "cited-by" | "references",
  ): void {
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

    const reportedCounts = getRelationshipReportedCounts(
      snapshot.libraryID,
      node,
    );
    const tabs = element(document, "div", "cm-detail-tabs");
    for (const [mode, label] of [
      ["overview", "Overview"],
      ["cited-by", `Cited by (${formatCount(reportedCounts.citationCount)})`],
      [
        "references",
        `References (${formatCount(reportedCounts.referenceCount)})`,
      ],
    ] as const) {
      const button = element(document, "button");
      button.type = "button";
      button.dataset.mode = mode;
      button.dataset.selected = String(mode === activeMode);
      button.textContent = label;
      button.addEventListener("click", () => {
        if (mode === "overview") renderOverview(node);
        else showRelationList(node, mode);
      });
      tabs.appendChild(button);
    }
    detail.appendChild(tabs);
  }

  function applyRelationshipMutationToGraph(
    event: RelationshipMutationEvent,
  ): void {
    const relatedKey =
      event.work.inLibraryItemKey ?? event.work.zoteroItemKey ?? null;
    if (!relatedKey) return;
    const source =
      event.direction === "references" ? event.subjectItemKey : relatedKey;
    const target =
      event.direction === "references" ? relatedKey : event.subjectItemKey;
    if (event.ignored) {
      for (let index = model.edges.length - 1; index >= 0; index -= 1) {
        const edge = model.edges[index];
        if (edge.source === source && edge.target === target) {
          model.edges.splice(index, 1);
        }
      }
    } else if (
      !model.edges.some(
        (edge) => edge.source === source && edge.target === target,
      )
    ) {
      model.edges.push({
        key: `${source}>${target}`,
        source,
        target,
        provenance: event.work.provider,
        manual: false,
      });
    }
    renderer?.setRelationshipHidden(source, target, event.ignored);
    model.statistics.edges = model.edges.length;
    updateSummary();
  }

  function appendExternalWorkCards(
    works: ExternalWork[],
    relationshipContext?: {
      node: CitationGraphNode;
      direction: "references" | "cited-by";
      rerender: () => void;
    },
    target: HTMLElement = detail,
    existingList?: HTMLElement,
  ): void {
    if (!works.length) {
      target.append(
        text(document, "p", "No external works were found.", "cm-placeholder"),
      );
      return;
    }
    const list = existingList ?? element(document, "div", "cm-external-list");
    for (const work of works) {
      const card = element(document, "article", "cm-external-card");
      if (work.isRetracted) card.classList.add("cm-external-retracted");
      const localTitle = work.inLibraryItemKey
        ? paperByKey.get(work.inLibraryItemKey)?.title?.trim()
        : null;
      card.appendChild(
        text(document, "h3", localTitle || externalWorkTitle(work)),
      );
      card.appendChild(
        text(document, "p", externalWorkAuthorsText(work), "cm-detail-meta"),
      );
      const metadataText = externalWorkMetadataText(work);
      if (metadataText) {
        card.appendChild(text(document, "p", metadataText, "cm-detail-meta"));
      }

      const identityRow = element(document, "div", "cm-detail-actions");
      identityRow.style.justifyContent = "space-between";
      identityRow.style.width = "100%";
      const url = externalWorkURL(work);
      if (url) {
        const link = element(document, "a");
        link.href = url;
        link.textContent = work.doi?.trim()
          ? `DOI: ${work.doi.trim()}`
          : `Open ${externalProviderLabel(work)} record`;
        link.style.minWidth = "0";
        link.style.overflowWrap = "anywhere";
        link.addEventListener("click", (event) => {
          event.preventDefault();
          Zotero.launchURL(url);
        });
        identityRow.appendChild(link);
      } else {
        identityRow.appendChild(text(document, "span", "No DOI or URL"));
      }

      const actionButtons = element(document, "div", "cm-detail-actions");
      if (work.inLibraryItemKey) {
        const paper = paperByKey.get(work.inLibraryItemKey);
        const show = element(document, "button", "cm-primary-button");
        show.type = "button";
        show.textContent = "Show in Zotero";
        show.addEventListener("click", () => {
          if (paper) void selectPaper(paper.itemID);
        });
        actionButtons.appendChild(show);
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
        actionButtons.appendChild(add);
        card.appendChild(importArea);
      }

      let activeIgnoredRelation = relationshipContext
        ? ignoredRelationForExternalWork(
            relationshipContext.node,
            relationshipContext.direction,
            work,
          )
        : null;
      let ignoredBadge: HTMLElement | null = null;
      let syncIgnoredState = (): void => undefined;
      if (relationshipContext && work.provider !== "manual") {
        const toggleIgnored = element(
          document,
          "button",
          "cm-secondary-button",
        );
        toggleIgnored.type = "button";
        toggleIgnored.addEventListener("click", () => {
          toggleIgnored.disabled = true;
          void (async () => {
            try {
              if (activeIgnoredRelation) {
                await removeIgnoredRelation(activeIgnoredRelation.id);
                activeIgnoredRelation = null;
              } else {
                const descriptor = ignoredRelationDescriptorForExternalWork(
                  relationshipContext.node,
                  relationshipContext.direction,
                  work,
                );
                await ignoreProviderRelation({
                  ...descriptor,
                  providerWorkID: descriptor.providerWorkID ?? "",
                  doi: descriptor.doi ?? "",
                  normalizedTitle: descriptor.normalizedTitle ?? "",
                });
                activeIgnoredRelation = ignoredRelationForExternalWork(
                  relationshipContext.node,
                  relationshipContext.direction,
                  work,
                );
              }
              renderer?.setGhostPreview(null);
              const mutation: RelationshipMutationEvent = {
                origin: "graph",
                libraryID: snapshot.libraryID,
                subjectItemKey: relationshipContext.node.itemKey,
                direction: relationshipContext.direction,
                work,
                ignored: Boolean(activeIgnoredRelation),
              };
              applyRelationshipMutationToGraph(mutation);
              syncIgnoredState();
              notifyRelationshipMutation(mutation);
            } catch (error) {
              Zotero.logError(
                error instanceof Error ? error : new Error(String(error)),
              );
            } finally {
              toggleIgnored.disabled = false;
            }
          })();
        });
        actionButtons.appendChild(toggleIgnored);
        syncIgnoredState = (): void => {
          toggleIgnored.textContent = activeIgnoredRelation
            ? "Restore relationship"
            : "Mark incorrect";
          toggleIgnored.title = activeIgnoredRelation
            ? "Restore this relationship to the citation graph"
            : "Hide only this relationship edge from the citation graph";
          if (activeIgnoredRelation && !ignoredBadge) {
            ignoredBadge = text(document, "span", "Ignored Relationship");
            badges.appendChild(ignoredBadge);
            if (!badges.parentElement) card.appendChild(badges);
          } else if (!activeIgnoredRelation && ignoredBadge) {
            ignoredBadge.remove();
            ignoredBadge = null;
            if (!badges.childElementCount) badges.remove();
          }
        };
      }
      identityRow.appendChild(actionButtons);
      card.appendChild(identityRow);

      const badges = element(document, "div", "cm-badges");
      if (work.inLibraryItemKey)
        badges.append(text(document, "span", "In Zotero"));
      if (work.isOpenAccess)
        badges.append(text(document, "span", "Open Access"));
      if (activeIgnoredRelation) {
        ignoredBadge = text(document, "span", "Ignored Relationship");
        badges.append(ignoredBadge);
      }
      if (work.isRetracted)
        badges.append(text(document, "span", "Retracted", "cm-badge-danger"));
      if (badges.childElementCount) card.appendChild(badges);
      syncIgnoredState();

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

      if (relationshipContext) {
        card.style.cursor = "pointer";
        card.addEventListener("click", (event) => {
          const targetElement = event.target as Element | null;
          if (targetElement?.closest("a, button, input, select, summary"))
            return;
          if (activeIgnoredRelation) {
            renderer?.setGhostPreview(null);
            return;
          }
          const previewSourceKeys = relationshipPreviewSourceKeys(
            model,
            relationshipContext.node,
            work,
            visibleKeys,
          );
          if (!previewSourceKeys.length) {
            renderer?.setGhostPreview(null);
            return;
          }
          renderer?.setGhostPreview({
            key: work.providerWorkID ?? work.doi ?? work.title ?? "external",
            title: externalWorkTitle(work),
            year: work.year,
            citationCount: work.citationCount ?? null,
            referenceCount: work.referenceCount ?? null,
            sourceKeys: previewSourceKeys,
          });
        });
      } else {
        const previewSourceKeys = (work.citingNodeKeys ?? []).filter((key) =>
          visibleKeys.has(key),
        );
        if (previewSourceKeys.length) {
          const preview: GhostPreview = {
            key: work.providerWorkID ?? work.doi ?? work.title ?? "external",
            title: externalWorkTitle(work),
            year: work.year,
            citationCount: work.citationCount ?? null,
            referenceCount: work.referenceCount ?? null,
            sourceKeys: previewSourceKeys,
          };
          const showPreview = (): void => renderer?.setGhostPreview(preview);
          card.style.cursor = "pointer";
          card.tabIndex = 0;
          card.setAttribute("role", "button");
          card.title = "Click to preview this paper on the graph";
          card.addEventListener("click", (event) => {
            const targetElement = event.target as Element | null;
            if (targetElement?.closest("a, button, input, select, summary"))
              return;
            showPreview();
          });
          card.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            showPreview();
          });
        }
      }
      list.appendChild(card);
    }
    if (!existingList) target.appendChild(list);
  }

  let inlineSimilarResults: HTMLElement | null = null;
  let similarRequestGeneration = 0;

  const ensureInlineSimilarResults = (): HTMLElement => {
    if (inlineSimilarResults?.isConnected) return inlineSimilarResults;
    const section = element(document, "section", "cm-inline-similar-results");
    section.style.marginTop = "10px";
    detail.appendChild(section);
    inlineSimilarResults = section;
    return section;
  };

  const loadInlineSimilarResults = async (
    seedNodes: CitationGraphNode[],
  ): Promise<void> => {
    const generation = ++similarRequestGeneration;
    const section = ensureInlineSimilarResults();
    clear(section);
    section.append(
      text(document, "h3", "Similar papers"),
      text(document, "p", "Finding similar papers…", "cm-placeholder"),
    );
    try {
      const works = await getMissingPaperRecommendations(
        seedNodes,
        model.nodes,
        50,
        seedNodes.length <= 1 ? 1 : 2,
      );
      if (
        cleaned ||
        generation !== similarRequestGeneration ||
        !section.isConnected
      ) {
        return;
      }
      clear(section);
      section.appendChild(text(document, "h3", "Similar papers"));
      appendExternalWorkCards(works, undefined, section);
    } catch (error) {
      if (
        !cleaned &&
        generation === similarRequestGeneration &&
        section.isConnected
      ) {
        clear(section);
        section.append(
          text(document, "h3", "Similar papers"),
          text(document, "p", "Similar-paper search failed.", "cm-placeholder"),
        );
      }
      throw error;
    }
  };

  const showGraphSimilarResults = async (
    seedNodes: CitationGraphNode[],
  ): Promise<void> => {
    const generation = ++similarRequestGeneration;
    inlineSimilarResults = null;
    activeRelationshipView = null;
    renderer?.setGhostPreview(null);
    const returnNode = selectedNode;
    clear(detail);

    const headingRow = element(document, "div", "cm-detail-heading-row");
    Object.assign(headingRow.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
    });
    headingRow.appendChild(
      text(document, "h2", "Similar papers for current graph"),
    );
    const back = element(document, "button", "cm-secondary-button");
    back.type = "button";
    back.textContent = returnNode ? "Back to paper" : "Close";
    back.title = returnNode
      ? "Return to the previously selected paper"
      : "Close graph-wide similar-paper results";
    back.addEventListener("click", () => renderOverview(returnNode));
    headingRow.appendChild(back);

    detail.append(
      headingRow,
      text(
        document,
        "p",
        `Based on ${formatCount(seedNodes.length)} currently visible graph papers.`,
        "cm-detail-meta",
      ),
    );
    const results = element(document, "section", "cm-graph-similar-results");
    results.appendChild(
      text(document, "p", "Finding similar papers…", "cm-placeholder"),
    );
    detail.appendChild(results);

    try {
      const works = await getMissingPaperRecommendations(
        seedNodes,
        model.nodes,
        50,
        seedNodes.length <= 1 ? 1 : 2,
      );
      if (
        cleaned ||
        generation !== similarRequestGeneration ||
        !results.isConnected
      ) {
        return;
      }
      clear(results);
      appendExternalWorkCards(works, undefined, results);
    } catch (error) {
      if (
        !cleaned &&
        generation === similarRequestGeneration &&
        results.isConnected
      ) {
        clear(results);
        results.appendChild(
          text(
            document,
            "p",
            "Graph-wide similar-paper search failed.",
            "cm-placeholder",
          ),
        );
      }
      throw error;
    }
  };

  function showRelationList(
    node: CitationGraphNode,
    direction: "references" | "cited-by",
  ): void {
    activeRelationshipView = { itemKey: node.itemKey, direction };
    renderer?.setGhostPreview(null);
    similarRequestGeneration += 1;
    inlineSimilarResults = null;
    clear(detail);
    appendPaperHeader(node, direction);

    let relationshipSnapshot = getRelationshipViewSnapshot(
      model,
      node,
      direction,
      snapshot.libraryID,
      RELATIONSHIP_VIEW_LIMIT,
    );
    let works = relationshipSnapshot.works;
    let updating = false;
    let updateOutcome: string | null = null;
    let shownCount = works.length;
    let filtered = false;
    let renderGeneration = 0;
    let renderList = (): void => undefined;

    const controls = element(document, "div", "cm-relationship-controls");
    Object.assign(controls.style, {
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr) 30px 30px",
      gap: "6px",
      alignItems: "center",
      margin: "7px 0 2px",
    });
    const toolbar = createPaperListToolbar({
      document,
      searchPlaceholder:
        direction === "references"
          ? "Search references"
          : "Search citing papers",
      collections: snapshot.collections,
      buttonClassName: "cm-secondary-button",
      inputClassName: "cm-search",
      onChange: () => renderList(),
    });
    toolbar.searchInput.style.maxWidth = "none";

    const update = element(document, "button", "cm-secondary-button");
    update.type = "button";
    update.style.width = "30px";
    update.style.minWidth = "30px";
    update.style.padding = "4px";
    update.style.justifyContent = "center";
    const updateLabel =
      direction === "references"
        ? "Update reference papers"
        : "Update citing papers";
    update.title = updateLabel;
    update.setAttribute("aria-label", updateLabel);
    update.appendChild(icon(document, "refresh"));

    const currentRelatedItemKeys = (): Set<string> =>
      new Set(
        works
          .map((work) => work.inLibraryItemKey ?? work.zoteroItemKey ?? null)
          .filter((key): key is string => Boolean(key)),
      );

    const synchronizeGraph = (changes: ManualRelationshipChange[]): void => {
      if (!changes.length) return;
      const refreshed = buildCitationGraph(snapshot);
      model.edges.splice(0, model.edges.length, ...refreshed.edges);
      Object.assign(model.statistics, refreshed.statistics);
      renderer?.setLayout(renderer.getLayout());
      updateSummary();
    };

    const picker = createManualRelationshipPicker({
      document,
      snapshot,
      subjectItemKey: node.itemKey,
      direction: direction === "references" ? "reference" : "cited-by",
      getAlreadyRelatedItemKeys: currentRelatedItemKeys,
      buttonClassName: "cm-secondary-button",
      inputClassName: "cm-search",
      onApplied: (changes) => {
        synchronizeGraph(changes);
        relationshipSnapshot = getRelationshipViewSnapshot(
          model,
          node,
          direction,
          snapshot.libraryID,
          RELATIONSHIP_VIEW_LIMIT,
        );
        works = relationshipSnapshot.works;
        renderList();
      },
    });

    controls.append(toolbar.root, update, picker.button);
    detail.append(controls, picker.overlay);

    const status = text(document, "p", "", "cm-detail-meta");
    const updateStatus = (): void => {
      const base = relationshipStatusText(
        relationshipSnapshot,
        shownCount,
        filtered,
        updating,
      );
      status.textContent = updateOutcome ? `${base} · ${updateOutcome}` : base;
    };
    const listHost = element(document, "div");
    detail.append(status, listHost);

    renderList = (): void => {
      const generation = ++renderGeneration;
      clear(listHost);
      const entries = works.map((work, providerOrder) => ({
        work,
        providerOrder,
      }));
      const ordered = toolbar.apply(entries, ({ work }) =>
        describeExternalWork(work, snapshot.libraryID, true, false, paperByKey),
      );
      shownCount = ordered.length;
      filtered = toolbar.hasActiveQueryOrFilters();
      updateStatus();
      if (!ordered.length) {
        appendExternalWorkCards([], undefined, listHost);
        return;
      }

      const list = element(document, "div", "cm-external-list");
      listHost.appendChild(list);
      let index = 0;
      const appendNextBatch = (): void => {
        if (generation !== renderGeneration || !list.isConnected) return;
        const batch = ordered.slice(index, index + 75);
        appendExternalWorkCards(
          batch.map((entry) => entry.work),
          {
            node,
            direction,
            rerender: () => {
              relationshipSnapshot = getRelationshipViewSnapshot(
                model,
                node,
                direction,
                snapshot.libraryID,
                RELATIONSHIP_VIEW_LIMIT,
              );
              works = relationshipSnapshot.works;
              renderList();
            },
          },
          listHost,
          list,
        );
        index += batch.length;
        if (index < ordered.length) {
          const view = document.defaultView;
          if (view) view.requestAnimationFrame(appendNextBatch);
          else setTimeout(appendNextBatch, 0);
        }
      };
      appendNextBatch();
    };

    update.addEventListener("click", () => {
      if (update.disabled) return;
      update.disabled = true;
      updating = true;
      updateOutcome = null;
      updateStatus();
      const progress = createUpdateProgress({
        document,
        title: updateLabel,
        message: "Checking provider pages for new relationships…",
      });
      void (async () => {
        const before = new Set(works.map(relationshipWorkKey));
        try {
          await refreshExternalRelationships(
            node,
            model.nodes,
            direction,
            RELATIONSHIP_VIEW_LIMIT,
          );
          relationshipSnapshot = getRelationshipViewSnapshot(
            model,
            node,
            direction,
            snapshot.libraryID,
            RELATIONSHIP_VIEW_LIMIT,
          );
          works = relationshipSnapshot.works;
          const added = works.reduce(
            (count, work) =>
              count + (before.has(relationshipWorkKey(work)) ? 0 : 1),
            0,
          );
          updateOutcome = added
            ? `${added} new paper${added === 1 ? "" : "s"} added`
            : "No new papers returned";
          progress.finish(updateOutcome);
        } catch (error) {
          updateOutcome = "Update failed";
          progress.fail(updateOutcome);
          Zotero.logError(
            error instanceof Error ? error : new Error(String(error)),
          );
        } finally {
          updating = false;
          update.disabled = false;
          if (!cleaned) renderList();
        }
      })();
    });
    renderList();
  }

  function renderOverview(node: CitationGraphNode | null): void {
    activeRelationshipView = null;
    renderer?.setGhostPreview(null);
    similarRequestGeneration += 1;
    inlineSimilarResults = null;
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
    appendPaperHeader(node, "overview");
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
    const overviewActions = createPaperOverviewActionBar({
      document,
      actionsClass: "cm-detail-actions",
      primaryButtonClass: "cm-primary-button",
      secondaryButtonClass: "cm-secondary-button",
      doi: node.doi,
      onShowInZotero: () => selectPaper(node.itemID),
      onSimilar: () => loadInlineSimilarResults([node]),
      onRefresh: async () => {
        const item = Zotero.Items.get(node.itemID) as Zotero.Item | null;
        if (!item) throw new Error("The selected Zotero item is unavailable.");
        await updateCitationDataForItems([item], {
          force: true,
          includeRelationships: true,
          progressDocument: document,
        });
        Object.assign(node, createMetricNodeForItem(item));
        const refreshedGraph = buildCitationGraph(snapshot);
        model.edges.splice(0, model.edges.length, ...refreshedGraph.edges);
        Object.assign(model.statistics, refreshedGraph.statistics);
        renderer?.setLayout(currentLayout);
        updateSummary();
        if (!cleaned) renderOverview(node);
      },
    });
    detail.appendChild(overviewActions.root);
    inlineSimilarResults = element(
      document,
      "section",
      "cm-inline-similar-results",
    );
    inlineSimilarResults.style.marginTop = "10px";
    detail.appendChild(inlineSimilarResults);
  }

  renderer = new CitationGraphRenderer({
    canvas,
    model,
    layout: currentLayout,
    collectionColorsByNodeKey: visuals.colorsByNodeKey,
    collectionLabelsByNodeKey: visuals.labelsByNodeKey,
    onSelectionChange: renderOverview,
    onOpenNode: (node) => void selectPaper(node.itemID),
    onBackgroundInteraction: appearance.close,
  });
  renderer.setLegendVisible(appearance.getLegendVisible());
  renderOverview(null);
  refreshSourceMetricsForLayout(currentLayout);

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

  applyFilters = (): void => {
    const tokens = normalizeSearch(search.value).split(/\s+/).filter(Boolean);
    visibleKeys = new Set(
      model.nodes
        .filter((node) => {
          const paper = paperByKey.get(node.itemKey);
          const descriptor = graphFilterDescriptors.get(node.key);
          if (!paper || !descriptor || !graphFilter.matches(descriptor)) {
            return false;
          }
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
  similarButton.addEventListener("click", () => {
    if (similarButton.disabled) return;
    const visibleNodes = model.nodes.filter((node) =>
      visibleKeys.has(node.key),
    );
    if (!visibleNodes.length) return;
    similarButton.disabled = true;
    void showGraphSimilarResults(visibleNodes)
      .catch((error: unknown) => {
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
      })
      .finally(() => {
        if (similarButton.isConnected) similarButton.disabled = false;
      });
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
    exportButton.setAttribute("aria-expanded", "false");
    let task: Promise<void> | null = null;
    if (target.dataset.format === "png") {
      task = exportGraphPNG(document, renderer.getCanvas(), snapshot);
    } else if (target.dataset.format === "json") {
      task = exportGraphJSON(document, snapshot, model, visibleKeys);
    } else if (target.dataset.format === "csv") {
      task = exportGraphCSV(document, snapshot, model, visibleKeys);
    }
    void task?.catch((error: unknown) => {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });
  refreshButton.addEventListener("click", () => {
    if (refreshButton.disabled) return;
    const items = model.nodes
      .filter((node) => visibleKeys.has(node.key))
      .map((node) => Zotero.Items.get(node.itemID) as Zotero.Item | null)
      .filter((item): item is Zotero.Item => Boolean(item));
    if (!items.length) return;
    refreshButton.disabled = true;
    void updateCitationDataForItems(items, {
      force: true,
      includeRelationships: false,
      progressDocument: document,
    })
      .then(() => {
        if (cleaned) return;
        for (const node of model.nodes) {
          const item = Zotero.Items.get(node.itemID) as Zotero.Item | null;
          if (item) Object.assign(node, createMetricNodeForItem(item));
        }
        applyFilters();
        renderer?.setLayout(currentLayout);
        renderer?.fitView();
        if (selectedNode) renderOverview(selectedNode);
      })
      .catch((error: unknown) => {
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
      })
      .finally(() => {
        if (refreshButton.isConnected) refreshButton.disabled = false;
      });
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

  const unsubscribeRelationshipMutations = subscribeRelationshipMutations(
    (event) => {
      if (
        cleaned ||
        event.origin === "graph" ||
        event.libraryID !== snapshot.libraryID
      ) {
        return;
      }
      applyRelationshipMutationToGraph(event);
      if (
        activeRelationshipView?.itemKey === event.subjectItemKey &&
        activeRelationshipView.direction === event.direction
      ) {
        const subject = model.nodes.find(
          (candidate) => candidate.itemKey === event.subjectItemKey,
        );
        if (subject) {
          document.defaultView?.setTimeout(() => {
            if (!cleaned) showRelationList(subject, event.direction);
          }, 0);
        }
      }
    },
  );

  if (options.initialItemID) {
    const initial = model.nodes.find(
      (node) => node.itemID === options.initialItemID,
    );
    if (initial) renderer.selectNode(initial.key);
  }
  updateSummary();
  const cleanup = (): void => {
    cleaned = true;
    unsubscribeRelationshipMutations();
    graphFilter.destroy();
    graphArea.removeEventListener("pointerdown", onGraphAreaPointerDown, true);
    renderer?.destroy();
    renderer = null;
  };
  cleanupByMount.set(mount, cleanup);
  return root;
}
