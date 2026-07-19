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

function formatCount(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat().format(value);
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
      paper.tags.join(" "),
      paper.year ?? "",
    ].join(" "),
  );
}

function collectionChildren(
  collections: LibraryCollectionFilter[],
): Map<number | null, LibraryCollectionFilter[]> {
  const children = new Map<number | null, LibraryCollectionFilter[]>();
  for (const collection of collections) {
    const siblings = children.get(collection.parentCollectionID) ?? [];
    siblings.push(collection);
    children.set(collection.parentCollectionID, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort(
      (left, right) =>
        left.orderIndex - right.orderIndex ||
        left.name.localeCompare(right.name),
    );
  }
  return children;
}

const TOP_LEVEL_HUES = [215, 28, 145, 350, 180, 282, 325, 48, 15, 250, 165, 95];

function hslForCollection(
  collection: LibraryCollectionFilter,
  rootIndex: number,
): string {
  const hue = TOP_LEVEL_HUES[rootIndex % TOP_LEVEL_HUES.length];
  const depthOffset = Math.max(0, collection.depth - 1);
  const lightness = 45 + ((depthOffset * 13 + collection.orderIndex * 5) % 30);
  const saturation = 58 - Math.min(18, depthOffset * 4);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
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
  const topLevel = snapshot.collections.filter(
    (collection) => collection.parentCollectionID === null,
  );
  const rootByID = new Map<number, number>();
  const findRoot = (collection: LibraryCollectionFilter): number => {
    let current = collection;
    const seen = new Set<number>();
    while (current.parentCollectionID && !seen.has(current.collectionID)) {
      seen.add(current.collectionID);
      const parent = byID.get(current.parentCollectionID);
      if (!parent) break;
      current = parent;
    }
    return current.collectionID;
  };
  for (const collection of snapshot.collections) {
    rootByID.set(collection.collectionID, findRoot(collection));
  }
  const rootIndex = new Map(
    topLevel.map((collection, index) => [collection.collectionID, index]),
  );
  const colorByID = new Map<number, string>();
  for (const collection of snapshot.collections) {
    colorByID.set(
      collection.collectionID,
      hslForCollection(
        collection,
        rootIndex.get(rootByID.get(collection.collectionID) ?? -1) ?? 0,
      ),
    );
  }

  const descendantsByID = new Map<number, Set<number>>();
  for (const collection of snapshot.collections) {
    descendantsByID.set(
      collection.collectionID,
      new Set(collection.includedCollectionIDs),
    );
  }

  const colorsByNodeKey = new Map<string, string[]>();
  const labelsByNodeKey = new Map<string, string[]>();
  for (const node of nodes) {
    const memberships = node.collectionIDs
      .map((id) => byID.get(id))
      .filter((entry): entry is LibraryCollectionFilter => Boolean(entry));
    // Retain deepest memberships only. If one selected collection is an
    // ancestor of another, only the descendant contributes a slice.
    const deepest = memberships.filter(
      (candidate) =>
        !memberships.some(
          (other) =>
            other.collectionID !== candidate.collectionID &&
            descendantsByID
              .get(candidate.collectionID)
              ?.has(other.collectionID),
        ),
    );
    deepest.sort(
      (left, right) =>
        right.depth - left.depth ||
        left.orderIndex - right.orderIndex ||
        left.name.localeCompare(right.name),
    );
    const shown = deepest.length > 4 ? deepest.slice(0, 3) : deepest;
    const colors = shown.map(
      (collection) =>
        colorByID.get(collection.collectionID) ?? "hsl(220 7% 58%)",
    );
    const labels = shown.map((collection) => collection.path);
    if (deepest.length > 4) {
      colors.push("hsl(220 7% 58%)");
      labels.push(`+${deepest.length - 3} more collections`);
    }
    colorsByNodeKey.set(node.key, colors);
    labelsByNodeKey.set(
      node.key,
      deepest.length
        ? deepest.map((collection) => collection.path)
        : ["Unfiled"],
    );
  }
  return { colorsByNodeKey, labelsByNodeKey };
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
    option.title = definition.description;
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

function controlRow(
  document: Document,
  label: string,
  control: HTMLElement,
): HTMLLabelElement {
  const row = element(document, "label", "cm-appearance-row");
  row.append(text(document, "span", label), control);
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
} {
  const root = element(document, "div", "cm-appearance-control");
  const button = element(document, "button", "cm-overlay-button");
  button.type = "button";
  button.classList.add("cm-appearance-button");
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
  sizeMetric.prepend(uniform);
  sizeMetric.value = initial.nodeSizeMetric;

  const colorMetric = element(document, "select", "cm-select");
  const categorical = element(document, "optgroup");
  categorical.label = "Categories";
  for (const [value, label] of [
    ["collection", "Collection"],
    ["publication-type", "Publication type"],
    ["provider", "Provider"],
    ["open-access", "Open Access"],
    ["retraction", "Retraction"],
  ]) {
    const option = element(document, "option");
    option.value = value;
    option.textContent = label;
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
    group.appendChild(option);
  }
  colorMetric.value = initial.nodeColorMetric;

  const labels = element(document, "select", "cm-select");
  for (const [value, label] of [
    ["title", "Title"],
    ["author-year", "Author and year"],
    ["none", "No labels"],
  ]) {
    const option = element(document, "option");
    option.value = value;
    option.textContent = label;
    labels.appendChild(option);
  }
  labels.value = initial.nodeLabelMode;

  const section = (titleText: string): HTMLFieldSetElement => {
    const fieldset = element(document, "fieldset", "cm-appearance-section");
    fieldset.append(text(document, "legend", titleText));
    panel.appendChild(fieldset);
    return fieldset;
  };
  const xSection = section("X axis");
  xSection.append(
    controlRow(document, "Metric", xMetric),
    controlRow(document, "Scale", xScale),
  );
  const ySection = section("Y axis");
  ySection.append(
    controlRow(document, "Metric", yMetric),
    controlRow(document, "Scale", yScale),
  );
  const nodeSection = section("Nodes");
  nodeSection.append(
    controlRow(document, "Size", sizeMetric),
    controlRow(document, "Colour", colorMetric),
    controlRow(document, "Labels", labels),
  );
  const appearanceActions = element(document, "div", "cm-appearance-actions");
  const reset = element(document, "button", "cm-secondary-button");
  reset.type = "button";
  reset.textContent = "Reset defaults";
  const apply = element(document, "button", "cm-primary-button");
  apply.type = "button";
  apply.textContent = "Apply";
  appearanceActions.append(reset, apply);
  panel.appendChild(appearanceActions);
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
  const updateScaleAvailability = (): void => {
    const update = (
      metricSelect: HTMLSelectElement,
      scaleSelect: HTMLSelectElement,
    ): void => {
      const metric = metricSelect.value as GraphAxisMetric;
      const log = scaleSelect.querySelector(
        'option[value="log"]',
      ) as HTMLOptionElement | null;
      const enabled =
        metric !== "free" && getMetricDefinition(metric).graph.logarithmic;
      if (log) log.disabled = !enabled;
      if (!enabled && scaleSelect.value === "log") scaleSelect.value = "linear";
      scaleSelect.disabled = metric === "free";
    };
    update(xMetric, xScale);
    update(yMetric, yScale);
  };
  let lastCommitted = JSON.stringify(initial);
  let applyTimer: number | null = null;
  const commit = (layout: GraphLayoutOptions, force = false): boolean => {
    const signature = JSON.stringify(layout);
    if (!force && signature === lastCommitted) return true;

    try {
      onChange(layout);
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return false;
    }

    lastCommitted = signature;
    try {
      setGraphAppearance(layout);
    } catch (error) {
      // Rendering has already succeeded. Preference persistence should not
      // prevent the current view from updating.
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    return true;
  };
  const applyControls = (force = false): void => {
    updateScaleAvailability();
    commit(read(), force);
  };
  const scheduleApply = (): void => {
    updateScaleAvailability();
    const view = document.defaultView;
    if (applyTimer !== null) view?.clearTimeout(applyTimer);
    applyTimer =
      view?.setTimeout(() => {
        applyTimer = null;
        applyControls();
      }, 0) ?? null;
  };
  const appearanceControls = [
    xMetric,
    xScale,
    yMetric,
    yScale,
    sizeMetric,
    colorMetric,
    labels,
  ];
  for (const control of appearanceControls) {
    for (const eventName of ["input", "change", "command"]) {
      control.addEventListener(eventName, scheduleApply);
    }
  }
  // Native select popups in Zotero can retarget command events outside the
  // select element. Capture them at the panel as a second, deferred route.
  for (const eventName of ["input", "change", "command"]) {
    panel.addEventListener(eventName, scheduleApply, true);
  }
  const applyNow = (): void => {
    if (applyTimer !== null) {
      document.defaultView?.clearTimeout(applyTimer);
      applyTimer = null;
    }
    applyControls(true);
  };
  apply.addEventListener("click", applyNow);
  apply.addEventListener("command", applyNow);
  root.addEventListener("pointerdown", (event) => event.stopPropagation());
  panel.addEventListener("click", (event) => event.stopPropagation());
  button.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) xMetric.focus();
  });

  const setControls = (layout: GraphLayoutOptions): void => {
    xMetric.value = layout.xMetric;
    xScale.value = layout.xScale;
    yMetric.value = layout.yMetric;
    yScale.value = layout.yScale;
    sizeMetric.value = layout.nodeSizeMetric;
    colorMetric.value = layout.nodeColorMetric;
    labels.value = layout.nodeLabelMode;
    updateScaleAvailability();
  };
  const setLayout = (layout: GraphLayoutOptions): void => {
    setControls(layout);
    commit(layout, true);
  };
  reset.addEventListener("click", () => {
    const defaults = resetGraphAppearance();
    setControls(defaults);
    lastCommitted = "";
    commit(defaults, true);
  });
  updateScaleAvailability();
  return { root, button, panel, setLayout };
}

function localPaperByKey(snapshot: LibrarySnapshot): Map<string, ZoteroPaper> {
  return new Map(snapshot.papers.map((paper) => [paper.itemKey, paper]));
}

function createCollectionChooser(
  document: Document,
  snapshot: LibrarySnapshot,
  initialSelection: number[] = [],
): {
  root: HTMLDivElement;
  selected: Set<number>;
} {
  const root = element(document, "div", "cm-collection-chooser");
  const search = element(document, "input", "cm-collection-search");
  search.type = "search";
  search.placeholder = "Search collections";
  search.setAttribute("aria-label", "Search collections");
  const tree = element(document, "div", "cm-collection-tree");
  tree.setAttribute("role", "tree");
  const selected = new Set(initialSelection);
  const expanded = new Set(
    snapshot.collections
      .filter((collection) => collection.depth <= 1)
      .map((collection) => collection.collectionID),
  );
  const children = collectionChildren(snapshot.collections);

  const render = (): void => {
    clear(tree);
    const query = normalizeSearch(search.value.trim());
    const matches = new Set<number>();
    if (query) {
      for (const collection of snapshot.collections) {
        if (normalizeSearch(collection.path).includes(query)) {
          let current: LibraryCollectionFilter | undefined = collection;
          while (current) {
            matches.add(current.collectionID);
            current = current.parentCollectionID
              ? snapshot.collections.find(
                  (candidate) =>
                    candidate.collectionID === current?.parentCollectionID,
                )
              : undefined;
          }
        }
      }
    }
    const appendBranch = (
      parentID: number | null,
      depth: number,
      container: HTMLElement,
    ): void => {
      for (const collection of children.get(parentID) ?? []) {
        if (query && !matches.has(collection.collectionID)) continue;
        const row = element(document, "div", "cm-collection-row");
        row.setAttribute("role", "treeitem");
        row.style.paddingInlineStart = `${depth * 17}px`;
        const branchChildren = children.get(collection.collectionID) ?? [];
        const expander = element(document, "button", "cm-collection-expander");
        expander.type = "button";
        expander.textContent = branchChildren.length
          ? expanded.has(collection.collectionID)
            ? "▾"
            : "▸"
          : "";
        expander.disabled = branchChildren.length === 0;
        expander.setAttribute(
          "aria-label",
          expanded.has(collection.collectionID)
            ? `Collapse ${collection.name}`
            : `Expand ${collection.name}`,
        );
        const chooser = element(document, "button", "cm-collection-choice");
        chooser.type = "button";
        chooser.setAttribute(
          "aria-pressed",
          String(selected.has(collection.collectionID)),
        );
        const check = text(
          document,
          "span",
          selected.has(collection.collectionID) ? "✓" : "",
          "cm-collection-check",
        );
        chooser.append(check, text(document, "span", collection.name));
        expander.addEventListener("click", () => {
          if (expanded.has(collection.collectionID)) {
            expanded.delete(collection.collectionID);
          } else {
            expanded.add(collection.collectionID);
          }
          render();
        });
        chooser.addEventListener("click", () => {
          if (selected.has(collection.collectionID)) {
            selected.delete(collection.collectionID);
          } else {
            selected.add(collection.collectionID);
          }
          render();
        });
        row.append(expander, chooser);
        container.appendChild(row);
        if (
          branchChildren.length &&
          (expanded.has(collection.collectionID) || query)
        ) {
          appendBranch(collection.collectionID, depth + 1, container);
        }
      }
    };
    appendBranch(null, 0, tree);
    if (!tree.childElementCount) {
      tree.append(text(document, "p", "No matching collections."));
    }
  };
  search.addEventListener("input", render);
  root.append(search, tree);
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
  const initialGraphLayout = getGraphAppearance();
  const selectPaper = async (itemID: number): Promise<void> => {
    try {
      await options.onSelectPaper(itemID);
    } catch (error) {
      Zotero.logError(
        error instanceof Error
          ? error
          : new Error(
              `Citation Map could not select item ${itemID}: ${String(error)}`,
            ),
      );
    }
  };
  let searchTimer: number | null = null;
  let cleaned = false;

  const root = element(document, "div", "citation-map-root");
  root.dataset.mode = options.mode;
  const header = element(document, "header", "cm-header");
  const identity = element(document, "div", "cm-header-identity");
  identity.append(
    text(document, "h1", "Citation Map"),
    text(document, "p", snapshot.libraryName, "cm-subtitle"),
  );
  const summary = text(
    document,
    "p",
    `${formatCount(snapshot.statistics.totalPapers)} papers · ${formatCount(model.statistics.edges)} citation links · ${formatCount(model.statistics.resolvedNodes)} papers with cached data`,
    "cm-library-summary",
  );
  identity.appendChild(summary);
  header.appendChild(identity);

  const controls = element(document, "div", "cm-header-controls");
  const search = element(document, "input", "cm-search");
  search.type = "search";
  search.placeholder = "Search all fields and tags";
  search.setAttribute("aria-label", "Search all fields and tags");
  const collection = element(document, "select", "cm-select");
  collection.setAttribute("aria-label", "Collection filter");
  const allCollections = element(document, "option");
  allCollections.value = "all";
  allCollections.textContent = "Whole library";
  collection.appendChild(allCollections);
  for (const entry of snapshot.collections) {
    const option = element(document, "option");
    option.value = String(entry.collectionID);
    option.textContent = `${"  ".repeat(Math.max(0, entry.depth))}${entry.name}`;
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
  const filterButton = element(document, "button", "cm-toolbar-button");
  filterButton.type = "button";
  filterButton.textContent = "Filters";
  filterButton.setAttribute("aria-expanded", "false");
  controls.append(search, collection, tag, filterButton);
  header.appendChild(controls);

  const actions = element(document, "div", "cm-header-actions");
  const missingButton = element(document, "button", "cm-primary-button");
  missingButton.type = "button";
  missingButton.textContent = "Missing papers";
  const exportWrapper = element(document, "div", "cm-menu-wrapper");
  const exportButton = element(document, "button", "cm-toolbar-button");
  exportButton.type = "button";
  exportButton.textContent = "Export ▾";
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
  exportWrapper.append(exportButton, exportMenu);
  const refreshButton = element(document, "button", "cm-toolbar-button");
  refreshButton.type = "button";
  refreshButton.textContent = "Refresh view";
  actions.append(missingButton, exportWrapper, refreshButton);
  header.appendChild(actions);
  root.appendChild(header);

  const filterPanel = element(document, "div", "cm-filter-panel");
  filterPanel.hidden = true;
  const makeFilter = (label: string, checked: boolean): HTMLLabelElement => {
    const wrapper = element(document, "label", "cm-check-control");
    const input = element(document, "input");
    input.type = "checkbox";
    input.checked = checked;
    wrapper.append(input, text(document, "span", label));
    return wrapper;
  };
  const includeMissingYear = makeFilter("Include missing year", true);
  const includeMissingCitations = makeFilter("Include missing citations", true);
  const includeMissingReferences = makeFilter(
    "Include missing references",
    true,
  );
  const openAccessOnly = makeFilter("Open Access only", false);
  const excludeRetracted = makeFilter("Exclude retracted", false);
  filterPanel.append(
    includeMissingYear,
    includeMissingCitations,
    includeMissingReferences,
    openAccessOnly,
    excludeRetracted,
  );
  root.appendChild(filterPanel);

  const main = element(document, "main", "cm-main");
  const graphArea = element(document, "section", "cm-graph-area");
  graphArea.setAttribute("aria-label", "Citation graph");
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
    button.setAttribute("aria-label", description);
    if (action === "fit") button.classList.add("cm-fit-button");
    zoom.appendChild(button);
  }
  graphArea.appendChild(zoom);

  const appearance = createAxesAppearance(
    document,
    initialGraphLayout,
    (layout) => {
      if (!renderer) {
        throw new Error("Citation graph renderer is not initialized.");
      }
      const current = renderer.getLayout();
      const axesChanged =
        current.xMetric !== layout.xMetric ||
        current.xScale !== layout.xScale ||
        current.yMetric !== layout.yMetric ||
        current.yScale !== layout.yScale;
      renderer.setLayout(layout);
      if (axesChanged) renderer.fitView();
    },
  );
  graphArea.appendChild(appearance.root);

  const detailShell = element(document, "div", "cm-detail-shell");
  const resizer = element(document, "div", "cm-detail-resizer");
  resizer.tabIndex = 0;
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-orientation", "vertical");
  resizer.title = "Drag to resize. Drag fully right to collapse.";
  const detail = element(document, "aside", "cm-detail-panel");
  detail.setAttribute("aria-label", "Selected paper details");
  detailShell.append(resizer, detail);
  const savedCollapsed = getDetailPanelCollapsed();
  const savedWidth = getDetailPanelWidth();
  const mountWidth =
    mount.getBoundingClientRect().width ||
    document.defaultView?.innerWidth ||
    900;
  const initialDetailWidth = clamp(
    savedWidth,
    260,
    Math.max(260, mountWidth * 0.7),
  );
  detailShell.style.width = savedCollapsed ? "8px" : `${initialDetailWidth}px`;
  detailShell.dataset.collapsed = String(savedCollapsed);

  main.append(graphArea, detailShell);
  root.appendChild(main);
  mount.appendChild(root);

  const updateStatus = (): void => {
    const visibleNodes = model.nodes.filter((node) =>
      visibleKeys.has(node.key),
    );
    const resolvedNodes = visibleNodes.filter(
      (node) => node.metricStatus === "success",
    ).length;
    summary.textContent = `${formatCount(visibleNodes.length)} papers · ${formatCount(renderer?.getVisibleEdgeCount() ?? 0)} citation links · ${formatCount(resolvedNodes)} papers with cached data`;
  };

  const renderOverview = (node: CitationGraphNode | null): void => {
    renderer?.setGhostPreview(null);
    clear(detail);
    if (!node) {
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
      titleText?: string,
    ): void => {
      const dt = text(document, "dt", label);
      if (titleText) dt.title = titleText;
      rows.append(dt, text(document, "dd", value));
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
    appendMetric(
      "Citation acceleration",
      formatMetricValue("citation-acceleration", node.citationAcceleration),
      getMetricDefinition("citation-acceleration").description,
    );
    appendMetric("FWCI", formatMetricValue("fwci", node.fwci));
    appendMetric(
      "Citation percentile",
      formatMetricValue("citation-percentile", node.citationPercentile),
    );
    appendMetric(
      "2-year mean citedness",
      formatMetricValue(
        "two-year-mean-citedness",
        node.sourceMetrics?.twoYearMeanCitedness ?? null,
      ),
    );
    appendMetric(
      "Journal h-index",
      formatMetricValue("journal-h-index", node.sourceMetrics?.hIndex ?? null),
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

    const buttons = element(document, "div", "cm-detail-actions");
    const show = element(document, "button", "cm-primary-button");
    show.type = "button";
    show.textContent = "Show in Zotero";
    show.addEventListener("click", () => void selectPaper(node.itemID));
    buttons.appendChild(show);
    if (node.doi) {
      const doi = element(document, "button", "cm-secondary-button");
      doi.type = "button";
      doi.textContent = "Open DOI";
      doi.addEventListener("click", () =>
        Zotero.launchURL(
          `https://doi.org/${encodeURIComponent(node.doi ?? "")}`,
        ),
      );
      buttons.appendChild(doi);
    }
    detail.appendChild(buttons);

    tabs.addEventListener("click", (event) => {
      const target = (event.target as Element).closest(
        "button",
      ) as HTMLButtonElement | null;
      if (!target) return;
      if (target.dataset.mode === "cited-by")
        void showRelationList(node, "cited-by");
      if (target.dataset.mode === "references")
        void showRelationList(node, "references");
    });
  };

  const showLoading = (titleValue: string): void => {
    clear(detail);
    detail.append(
      text(document, "h2", titleValue),
      text(document, "p", "Loading…", "cm-placeholder"),
    );
  };

  const renderExternalWorks = (
    headingText: string,
    works: ExternalWork[],
    backNode: CitationGraphNode | null,
  ): void => {
    clear(detail);
    const heading = element(document, "div", "cm-detail-heading");
    const back = element(document, "button", "cm-secondary-button");
    back.type = "button";
    back.textContent = "Back";
    back.addEventListener("click", () => renderOverview(backNode));
    heading.append(back, text(document, "h2", headingText));
    detail.appendChild(heading);
    if (!works.length) {
      detail.append(
        text(document, "p", "No external works were found.", "cm-placeholder"),
      );
      return;
    }
    const list = element(document, "div", "cm-external-list");
    for (const work of works) {
      const card = element(document, "article", "cm-external-card");
      if (work.isRetracted) card.classList.add("cm-external-retracted");
      card.append(
        text(
          document,
          "h3",
          work.title?.trim() ||
            work.doi?.trim() ||
            work.providerWorkID?.trim() ||
            "Untitled work",
        ),
      );
      card.append(
        text(
          document,
          "p",
          [
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
            .join(" · "),
          "cm-detail-meta",
        ),
      );
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
        const importButtons = element(document, "div", "cm-detail-actions");
        const cancel = element(document, "button", "cm-secondary-button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        const confirm = element(document, "button", "cm-primary-button");
        confirm.type = "button";
        confirm.textContent = "Add paper";
        cancel.addEventListener("click", () => {
          importArea.hidden = true;
          add.hidden = false;
        });
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
        importButtons.append(cancel, confirm);
        importArea.append(
          text(document, "h4", "Choose collections"),
          text(
            document,
            "p",
            "Select any number of collections. No selection adds the paper to the library root.",
            "cm-help",
          ),
          chooser.root,
          importButtons,
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
      list.appendChild(card);
    }
    detail.appendChild(list);
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
      renderExternalWorks(titleValue, works, node);
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
      renderExternalWorks(titleValue, [], node);
    }
  };

  renderer = new CitationGraphRenderer({
    canvas,
    model,
    layout: initialGraphLayout,
    collectionColorsByNodeKey: visuals.colorsByNodeKey,
    collectionLabelsByNodeKey: visuals.labelsByNodeKey,
    onSelectionChange: renderOverview,
    onOpenNode: (node) => void selectPaper(node.itemID),
  });
  renderOverview(null);

  const selectedCollection = (): LibraryCollectionFilter | null => {
    const id = Number(collection.value);
    return Number.isFinite(id)
      ? (snapshot.collections.find((entry) => entry.collectionID === id) ??
          null)
      : null;
  };

  const applyFilters = (): void => {
    const selected = selectedCollection();
    const selectedTag = tag.value;
    const queryTokens = normalizeSearch(search.value)
      .split(/\s+/)
      .filter(Boolean);
    const allowedCollectionIDs = selected
      ? new Set(selected.includedCollectionIDs)
      : null;
    visibleKeys = new Set(
      model.nodes
        .filter((node) => {
          const paper = paperByKey.get(node.itemKey);
          if (!paper) return false;
          if (
            allowedCollectionIDs &&
            !node.collectionIDs.some((id) => allowedCollectionIDs.has(id))
          ) {
            return false;
          }
          if (selectedTag !== "all" && !node.tags.includes(selectedTag))
            return false;
          if (
            !(includeMissingYear.querySelector("input") as HTMLInputElement)
              .checked &&
            node.year === null
          ) {
            return false;
          }
          if (
            !(
              includeMissingCitations.querySelector("input") as HTMLInputElement
            ).checked &&
            node.citationCount === null
          ) {
            return false;
          }
          if (
            !(
              includeMissingReferences.querySelector(
                "input",
              ) as HTMLInputElement
            ).checked &&
            node.referenceCount === null
          ) {
            return false;
          }
          if (
            (openAccessOnly.querySelector("input") as HTMLInputElement)
              .checked &&
            !node.isOpenAccess
          ) {
            return false;
          }
          if (
            (excludeRetracted.querySelector("input") as HTMLInputElement)
              .checked &&
            node.isRetracted
          ) {
            return false;
          }
          if (
            queryTokens.length &&
            !queryTokens.every((token) =>
              paperSearchText(paper).includes(token),
            )
          ) {
            return false;
          }
          return true;
        })
        .map((node) => node.key),
    );
    renderer?.setVisibleKeys(visibleKeys);
    renderer?.setSearchMatches(queryTokens.length ? visibleKeys : null);
    updateStatus();
  };

  search.addEventListener("input", () => {
    if (searchTimer !== null) document.defaultView?.clearTimeout(searchTimer);
    searchTimer =
      document.defaultView?.setTimeout(() => {
        searchTimer = null;
        applyFilters();
      }, 180) ?? null;
  });
  for (const control of [collection, tag]) {
    control.addEventListener("change", applyFilters);
  }
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

  missingButton.addEventListener("click", async () => {
    showLoading("Missing papers");
    missingButton.disabled = true;
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
      renderExternalWorks("Missing papers", works, selectedNode);
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
      renderExternalWorks("Missing papers", [], selectedNode);
    } finally {
      missingButton.disabled = false;
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
    if (!target) return;
    exportMenu.hidden = true;
    exportButton.setAttribute("aria-expanded", "false");
    try {
      if (target.dataset.format === "png") {
        exportGraphPNG(document, renderer!.getCanvas(), snapshot);
      } else if (target.dataset.format === "json") {
        exportGraphJSON(document, snapshot, model, visibleKeys);
      } else if (target.dataset.format === "csv") {
        exportGraphCSV(document, snapshot, model, visibleKeys);
      }
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
  refreshButton.addEventListener("click", () => applyFilters());
  zoom.addEventListener("click", (event) => {
    const target = (event.target as Element).closest(
      "button",
    ) as HTMLButtonElement | null;
    if (!target) return;
    if (target.dataset.action === "in") renderer?.zoomBy(1.25);
    if (target.dataset.action === "out") renderer?.zoomBy(0.8);
    if (target.dataset.action === "fit") renderer?.fitView();
  });

  let resizing = false;
  const resizeMove = (event: PointerEvent): void => {
    if (!resizing) return;
    const rect = main.getBoundingClientRect();
    const width = clamp(
      rect.right - event.clientX,
      0,
      Math.max(260, rect.width * 0.7),
    );
    if (width < 72) {
      detailShell.style.width = "8px";
      detailShell.dataset.collapsed = "true";
    } else {
      detailShell.style.width = `${width}px`;
      detailShell.dataset.collapsed = "false";
    }
    renderer?.resizeViewport();
  };
  const resizeEnd = (): void => {
    if (!resizing) return;
    resizing = false;
    document.removeEventListener("pointermove", resizeMove);
    document.removeEventListener("pointerup", resizeEnd);
    const collapsed = detailShell.dataset.collapsed === "true";
    setDetailPanelCollapsed(collapsed);
    if (!collapsed) {
      setDetailPanelWidth(detailShell.getBoundingClientRect().width);
    }
  };
  resizer.addEventListener("pointerdown", (event) => {
    resizing = true;
    event.preventDefault();
    document.addEventListener("pointermove", resizeMove);
    document.addEventListener("pointerup", resizeEnd);
  });
  resizer.addEventListener("dblclick", () => {
    const collapsed = detailShell.dataset.collapsed === "true";
    detailShell.dataset.collapsed = String(!collapsed);
    if (collapsed) {
      const mainWidth = main.getBoundingClientRect().width;
      const restoredWidth = clamp(
        getDetailPanelWidth(),
        260,
        Math.max(260, mainWidth * 0.7),
      );
      detailShell.style.width = `${restoredWidth}px`;
    } else {
      detailShell.style.width = "8px";
    }
    setDetailPanelCollapsed(!collapsed);
    renderer?.resizeViewport();
  });

  const closeMenus = (event: Event): void => {
    const target = event.target as Node | null;
    if (target && exportWrapper.contains(target)) return;
    exportMenu.hidden = true;
    exportButton.setAttribute("aria-expanded", "false");
    // Do not auto-close the appearance panel here. Firefox renders native
    // select popups outside appearance.root; closing on capture can cancel the
    // select's change/command event before the new value is committed.
  };
  document.addEventListener("pointerdown", closeMenus, true);
  applyFilters();
  if (options.initialItemID) {
    const initialNode = model.nodes.find(
      (node) => node.itemID === options.initialItemID,
    );
    if (initialNode) renderer.selectNode(initialNode.key, true);
  }

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (searchTimer !== null) document.defaultView?.clearTimeout(searchTimer);
    document.removeEventListener("pointerdown", closeMenus, true);
    document.removeEventListener("pointermove", resizeMove);
    document.removeEventListener("pointerup", resizeEnd);
    renderer?.destroy();
  };
  document.defaultView?.addEventListener("unload", cleanup, { once: true });
  cleanupByMount.set(mount, cleanup);
  return root;
}
