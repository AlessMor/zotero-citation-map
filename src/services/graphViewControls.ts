/// <reference lib="dom" />

import { config } from "../../package.json";
import type { ExternalWork } from "../domain/externalWork";
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
import { externalWorkDisplayTitle } from "./externalWorkMetadataService";
import {
  axisMetricDefinitions,
  getMetricDefinition,
  metricValue,
  nodeColorMetricDefinitions,
  nodeSizeMetricDefinitions,
} from "./metricRegistry";
import {
  createCitationMapIcon,
  type CitationMapIconName,
} from "./uiIconService";

const HTML_NS = "http://www.w3.org/1999/xhtml";

export interface CollectionVisuals {
  colorsByNodeKey: Map<string, string[]>;
  labelsByNodeKey: Map<string, string[]>;
}

export function element<K extends keyof HTMLElementTagNameMap>(
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

export function text<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  content: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = element(document, tag, className);
  node.textContent = content;
  return node;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

export function ensureStyles(document: Document): void {
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

export function icon(
  document: Document,
  name: CitationMapIconName,
): SVGSVGElement {
  return createCitationMapIcon(document, name);
}

export function networkLogo(document: Document): HTMLSpanElement {
  const logo = element(document, "span", "cm-network-logo");
  logo.setAttribute("aria-hidden", "true");
  return logo;
}

export function iconButtonContent(
  document: Document,
  name: Parameters<typeof icon>[1],
  label: string,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(icon(document, name), text(document, "span", label));
  return fragment;
}

export function formatCount(value: number | null): string {
  return value === null
    ? "—"
    : new Intl.NumberFormat(undefined, { useGrouping: false }).format(value);
}

export function normalizeSearch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
}

export function graphNodeSearchText(node: CitationGraphNode): string {
  return normalizeSearch(
    [
      node.title,
      node.authors.join(" "),
      node.doi ?? "",
      node.sourceTitle ?? "",
      node.abstract ?? "",
      node.year ?? "",
      node.provider ?? "",
    ].join(" "),
  );
}

export interface LibraryPaperSearchEntry {
  paper: ZoteroPaper;
  titleText: string;
  authorText: string;
  mainPropertyText: string;
}

export function scoreLibraryPaperSearch(
  entry: LibraryPaperSearchEntry,
  rawQuery: string,
): number {
  const query = normalizeSearch(rawQuery).trim();
  const tokens = query.split(/\s+/).filter(Boolean);
  let score = 0;
  if (entry.titleText === query) score += 2400;
  else if (entry.titleText.startsWith(query)) score += 1600;
  else if (entry.titleText.includes(query)) score += 900;
  if (entry.authorText.startsWith(query)) score += 650;
  else if (entry.authorText.includes(query)) score += 350;
  if (entry.mainPropertyText.startsWith(query)) score += 240;
  else if (entry.mainPropertyText.includes(query)) score += 120;
  for (const token of tokens) {
    const titleIndex = entry.titleText.indexOf(token);
    const authorIndex = entry.authorText.indexOf(token);
    const propertyIndex = entry.mainPropertyText.indexOf(token);
    if (titleIndex >= 0) score += Math.max(60, 260 - titleIndex);
    else if (authorIndex >= 0) score += Math.max(30, 140 - authorIndex);
    else if (propertyIndex >= 0) score += Math.max(10, 70 - propertyIndex);
  }
  return score;
}

export function externalWorkTitle(work: ExternalWork): string {
  return externalWorkDisplayTitle(work) ?? "Title unavailable";
}

function colorForCollection(id: number, depth: number): string {
  const hue = (id * 47 + depth * 19) % 360;
  return `hsl(${hue} ${Math.max(42, 65 - depth * 5)}% ${Math.min(67, 45 + depth * 7)}%)`;
}

export function buildCollectionVisuals(
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
  // Focus projections derive this metric after the appearance controls are
  // created, so it must remain selectable even when the initial library graph
  // has no precise publication dates.
  if (metric === "citation-sequence") return true;
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

  const options = Array.from(select.options) as HTMLOptionElement[];
  const selectedOption = options.find(
    (option) => option.value === selected && !option.disabled,
  );

  select.value = selectedOption?.value ?? options[0]?.value ?? "";

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
  const options = Array.from(select.options) as HTMLOptionElement[];
  const requestedOption = options.find(
    (option) => option.value === requested && !option.disabled,
  );
  const fallback = options.find((option) => !option.disabled);
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

export function createAxesAppearance(
  document: Document,
  initial: GraphLayoutOptions,
  nodes: CitationGraphNode[],
  onChange: (layout: GraphLayoutOptions) => void,
  onLegendChange: (visible: boolean) => void,
  persistLayout: (layout: GraphLayoutOptions) => void,
  resetLayout: () => GraphLayoutOptions,
): {
  root: HTMLDivElement;
  button: HTMLButtonElement;
  panel: HTMLDivElement;
  setLayout: (layout: GraphLayoutOptions, persist?: boolean) => void;
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
  const commit = (
    layout: GraphLayoutOptions,
    force = false,
    persist = true,
  ): void => {
    const signature = JSON.stringify(layout);
    if (!force && signature === last) return;
    onChange(layout);
    if (persist) persistLayout(layout);
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
  const setLayout = (layout: GraphLayoutOptions, persist = true): void => {
    setControls(layout);
    commit(read(), true, persist);
  };
  reset.addEventListener("click", () => {
    showLegend.checked = true;
    Zotero.Prefs.set(legendPreferenceKey, true, true);
    onLegendChange(true);
    setLayout(resetLayout(), false);
  });
  updateAvailability();
  activate("x");
  const normalizedInitial = read();
  if (JSON.stringify(normalizedInitial) !== JSON.stringify(initial)) {
    persistLayout(normalizedInitial);
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
