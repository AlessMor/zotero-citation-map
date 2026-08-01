/// <reference lib="dom" />

import type {
  IgnoredProviderRelation,
  RelatedWorkMetadata,
} from "../domain/citationTypes";
import type { ExternalWork } from "../domain/externalWork";
import {
  createIgnoredRelationIndex,
  findIgnoredRelation,
  ignoredRelationDescriptorForRelatedWork,
  ignoredRelationDescriptorFromReference,
  referenceMatchesRelatedWork,
  relationshipDirection,
  type IgnoredRelationIndex,
  type IgnoredRelationDescriptor,
} from "../domain/relationshipDescriptors";
import type {
  CitationGraphNode,
  GhostPreview,
  GraphLayoutOptions,
} from "../domain/graphTypes";
import type { LibrarySnapshot, ZoteroPaper } from "../domain/types";
import { buildCitationGraph } from "./citationGraphService";
import {
  CitationGraphRenderer,
  type GraphViewTransform,
} from "./citationGraphRenderer";
import {
  hydrateExternalWorksMetadata,
  refreshExternalRelationships,
  selectedRelationshipCacheIsFresh,
  importExternalWork,
} from "./externalDiscoveryService";
import { getMissingPaperRecommendations } from "./missingPaperRecommendationService";
import {
  getCitationMetricRecord,
  getIgnoredRelations,
  ignoreProviderRelation,
  removeIgnoredRelation,
} from "./citationMetricsStore";
import {
  createRelatedWorkLookupIndex,
  findMatchingRelatedWork,
  matchRelatedWorkToGraphNode,
  normalizeExactTitle,
  type RelatedWorkLookupIndex,
} from "../domain/workIdentity";
import { mergeRelatedWorkLists } from "./relationshipStoreService";
import {
  citationDataSourceLabel,
  externalWorkURL,
} from "./providerPresentation";
import {
  externalWorkAuthorsText,
  externalWorkMetadataText,
} from "./externalWorkPresentationService";
import {
  getRelationshipReportedCounts,
  getRelationshipViewSnapshot,
  RELATIONSHIP_VIEW_LIMIT,
  newlyRetrievedRelationshipWorkCount,
  notifyRelationshipMutation,
  relationshipPreviewSourceKeys,
  relationshipStatusText,
  relationshipWorkKey,
  subscribeRelationshipMutations,
  type RelationshipMutationEvent,
} from "./relationshipViewService";
import {
  getRelationshipPublicationState,
  subscribeRelationshipPublications,
  type RelationshipPublicationEvent,
} from "./relationshipEvents";
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
import { formatMetricValue, getMetricDefinition } from "./metricRegistry";
import { createMetricNodeForItem } from "./itemMetricContext";
import { createPaperOverviewActionBar } from "./paperOverviewActionsService";
import { updateCitationDataForItems } from "./citationUpdateService";
import { createUpdateProgress } from "./updateProgressService";
import { createCancellationScope } from "./cancellationScope";
import { SerializedTaskQueue } from "./serializedTaskQueue";
import { mapCooperatively } from "./backgroundTaskService";
import { automaticFocusSeedRefreshPlan } from "./relationshipRefreshPolicy";
import {
  ensureSourceMetricsForNodes,
  graphLayoutUsesSourceMetrics,
} from "./sourceMetricsService";
import { clamp } from "./graphMetricScale";
import {
  buildCollectionVisuals,
  clear,
  createAxesAppearance,
  element,
  ensureStyles,
  externalWorkTitle,
  formatCount,
  graphNodeSearchText,
  icon,
  iconButtonContent,
  networkLogo,
  normalizeSearch,
  scoreLibraryPaperSearch,
  text,
  type LibraryPaperSearchEntry,
} from "./graphViewControls";
import {
  buildGraphFocusProjection,
  externalWorkToFocusNode,
  synchronizeExternalFocusNode,
  type GraphFocusDirection,
  type GraphFocusLocality,
  type GraphFocusProjection,
  type GraphFocusRanking,
  type GraphFocusState,
} from "./graphFocusService";
import {
  getDetailPanelCollapsed,
  getDetailPanelWidth,
  getFocusGraphAppearance,
  getGraphAppearance,
  resetFocusGraphAppearance,
  resetGraphAppearance,
  setDetailPanelCollapsed,
  setDetailPanelWidth,
  setFocusGraphAppearance,
  setGraphAppearance,
} from "./citationPreferences";
import {
  appendUniqueCitationMapKeys,
  extendCitationMapItemScope,
  normalizedCitationMapItemIDs,
  replaceCitationMapItemScope,
} from "./citationMapScopePolicy";

export type CitationMapFocusResult = "selected" | "revealed" | "not-found";

export interface CitationMapViewController {
  revealItem(itemID: number): CitationMapFocusResult;
  revealItems(itemIDs: readonly number[]): CitationMapFocusResult;
  replaceMapItems(itemIDs: readonly number[]): CitationMapFocusResult;
  addMapItems(itemIDs: readonly number[]): CitationMapFocusResult;
  openFocusItem(itemID: number): CitationMapFocusResult;
  openFocusItems(itemIDs: readonly number[]): CitationMapFocusResult;
  addFocusItems(itemIDs: readonly number[]): CitationMapFocusResult;
  openCollection(collectionID: number): CitationMapFocusResult;
  setActive(active: boolean): void;
}

const FOCUS_RELATIONSHIP_CACHE_LIMIT = 200;
const AUTOMATIC_FOCUS_REFRESH = automaticFocusSeedRefreshPlan();
const cleanupByMount = new WeakMap<Element, () => void>();
const controllerByMount = new WeakMap<Element, CitationMapViewController>();

export function getCitationMapViewController(
  mount: Element,
): CitationMapViewController | null {
  return controllerByMount.get(mount) ?? null;
}

export interface GraphViewOptions {
  mode: "tab" | "window";
  onSelectPaper: (itemID: number) => void | Promise<void>;
  onViewKindChange?: (kind: "map" | "focus") => void;
  initialViewKind?: "map" | "focus";
  initialItemID?: number | null;
  initialItemIDs?: readonly number[] | null;
  initialItemMode?: "replace" | "add";
  initialMapScopeItemIDs?: readonly number[] | null;
  initialMapPinnedItemIDs?: readonly number[] | null;
  onMapScopeChange?: (
    scopeItemIDs: readonly number[] | null,
    pinnedItemIDs: readonly number[],
  ) => void;
  initialFocusItemID?: number | null;
  initialFocusItemIDs?: readonly number[] | null;
  initialCollectionID?: number | null;
}

function localPaperByKey(snapshot: LibrarySnapshot): Map<string, ZoteroPaper> {
  return new Map(snapshot.papers.map((paper) => [paper.itemKey, paper]));
}

function graphNodeLibraryID(node: CitationGraphNode): number {
  const item = Zotero.Items.get(node.itemID) as Zotero.Item | null;
  return Number(item?.libraryID ?? Zotero.Libraries.userLibraryID);
}

function referenceMatchesGraphNode(
  reference: RelatedWorkMetadata,
  node: CitationGraphNode,
): boolean {
  return matchRelatedWorkToGraphNode(reference, node).decision === "same-work";
}

function ignoredRelationDescriptorForExternalWork(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  work: ExternalWork,
  referenceIndex?: RelatedWorkLookupIndex,
): IgnoredRelationDescriptor {
  const libraryID = graphNodeLibraryID(node);
  const relatedKey = work.inLibraryItemKey ?? work.zoteroItemKey;
  if (direction === "cited-by" && relatedKey) {
    const sourceRecord = getCitationMetricRecord(libraryID, relatedKey);
    const reference = sourceRecord?.references.find((candidate) =>
      referenceMatchesGraphNode(candidate, node),
    );
    if (reference) {
      return ignoredRelationDescriptorFromReference(
        libraryID,
        relatedKey,
        reference,
      );
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
    const reference = referenceIndex
      ? findMatchingRelatedWork(referenceIndex, work)
      : getCitationMetricRecord(libraryID, node.itemKey)?.references.find(
          (candidate) => referenceMatchesRelatedWork(candidate, work),
        );
    if (reference) {
      return ignoredRelationDescriptorFromReference(
        libraryID,
        node.itemKey,
        reference,
      );
    }
  }
  return ignoredRelationDescriptorForRelatedWork(
    libraryID,
    node.itemKey,
    relationshipDirection(direction),
    work,
  );
}

function ignoredRelationForExternalWork(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  work: ExternalWork,
  ignoredIndex?: IgnoredRelationIndex,
  referenceIndex?: RelatedWorkLookupIndex,
): IgnoredProviderRelation | null {
  const descriptor = ignoredRelationDescriptorForExternalWork(
    node,
    direction,
    work,
    referenceIndex,
  );
  const index =
    ignoredIndex ??
    createIgnoredRelationIndex(getIgnoredRelations(descriptor.libraryID));
  return findIgnoredRelation(index, descriptor);
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
  controllerByMount.delete(mount);
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
  const libraryModel = {
    nodes: [...model.nodes],
    edges: [...model.edges],
    statistics: { ...model.statistics },
  };
  const paperByKey = localPaperByKey(snapshot);
  const visuals = buildCollectionVisuals(snapshot, model.nodes);
  const initialViewKind =
    options.initialViewKind ??
    (options.initialFocusItemID || options.initialFocusItemIDs?.length
      ? "focus"
      : "map");
  let currentViewKind: "map" | "focus" = initialViewKind;
  let visibleKeys = new Set(model.nodes.map((node) => node.key));
  let mapScopeItemIDs = options.initialMapScopeItemIDs
    ? replaceCitationMapItemScope(options.initialMapScopeItemIDs)
    : null;
  let mapPinnedItemIDs = replaceCitationMapItemScope(
    options.initialMapPinnedItemIDs ?? [],
  );
  let selectedNode: CitationGraphNode | null = null;
  let focusProjection: GraphFocusProjection | null = null;
  const focusSeedRegistry = new Map<string, CitationGraphNode>();
  const focusRelationships = new Map<
    string,
    { references: ExternalWork[]; citedBy: ExternalWork[] }
  >();
  const focusRefreshInFlight = new Map<string, Promise<void>>();
  const focusRefreshTimers = new Map<string, number>();
  const focusRefreshQueue = new SerializedTaskQueue();
  let focusRefreshEpoch = 0;
  let focusRefreshCount = 0;
  let focusLoadActive = false;
  let focusRebuildFrame = 0;
  const focusBack: GraphFocusState[] = [];
  const focusForward: GraphFocusState[] = [];
  let activeRelationshipView: {
    itemKey: string;
    direction: "references" | "cited-by";
  } | null = null;
  let refreshActiveRelationshipView: (() => void) | null = null;
  let relationshipDetailRefreshFrame = 0;
  let relationshipGraphRefreshTimer = 0;
  let renderer: CitationGraphRenderer | null = null;
  const mapPinnedKeys = (): Set<string> =>
    new Set(
      libraryModel.nodes
        .filter((node) => mapPinnedItemIDs.has(node.itemID))
        .map((node) => node.key),
    );
  const syncMapPinnedKeys = (draw = false): void => {
    renderer?.setPinnedKeys(mapPinnedKeys(), draw);
  };
  const publishMapScope = (): void => {
    options.onMapScopeChange?.(mapScopeItemIDs ? [...mapScopeItemIDs] : null, [
      ...mapPinnedItemIDs,
    ]);
  };
  let cleaned = false;
  let viewActive = true;
  let inactiveRelationshipDirty = false;
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
  root.dataset.viewKind = currentViewKind;

  const header = element(document, "header", "cm-header");
  const identity = element(document, "div", "cm-header-identity");
  const titleRow = element(document, "div", "cm-title-row");
  const viewTitle = text(
    document,
    "h1",
    currentViewKind === "focus" ? "Focus View" : "Citation Map",
  );
  titleRow.append(networkLogo(document), viewTitle);
  const summary = text(
    document,
    "p",
    `${formatCount(snapshot.statistics.totalPapers)} nodes - ${formatCount(model.statistics.edges)} links`,
    "cm-library-summary",
  );
  identity.append(titleRow, summary);
  header.appendChild(identity);

  const toolbar = element(document, "div", "cm-header-toolbar");
  const addNodeWrap = element(document, "div", "cm-add-node-wrap");
  const addNodeButton = element(document, "button", "cm-toolbar-button");
  addNodeButton.type = "button";
  addNodeButton.append(iconButtonContent(document, "add", "Add Node"));
  addNodeButton.title =
    "Search the complete Zotero library and add papers to this view.";
  addNodeButton.setAttribute("aria-expanded", "false");
  const addNodePopup = element(document, "section", "cm-add-node-popup");
  addNodePopup.hidden = true;
  addNodePopup.setAttribute("role", "dialog");
  addNodePopup.setAttribute("aria-label", "Add papers to Citation Map view");
  const addNodeSearch = element(document, "input", "cm-add-node-search");
  addNodeSearch.type = "search";
  addNodeSearch.placeholder = "Search title, creator, or year";
  addNodeSearch.setAttribute(
    "aria-label",
    "Search titles, creators, and years in the complete Zotero library",
  );
  const addNodeResultsLabel = text(
    document,
    "h2",
    "Results",
    "cm-add-node-section-title",
  );
  const addNodeResults = element(document, "div", "cm-add-node-results");
  const addNodeSelectedLabel = text(
    document,
    "h2",
    "Selected",
    "cm-add-node-section-title",
  );
  const addNodeSelected = element(document, "div", "cm-add-node-selected");
  const addNodeStatus = text(
    document,
    "p",
    "No papers selected.",
    "cm-add-node-status",
  );
  const addSelectedButton = element(document, "button", "cm-primary-button");
  addSelectedButton.type = "button";
  addSelectedButton.textContent = "Add selected to view";
  addSelectedButton.disabled = true;
  const addNodeFooter = element(document, "div", "cm-add-node-footer");
  addNodeFooter.append(addNodeStatus, addSelectedButton);
  addNodePopup.append(
    addNodeSearch,
    addNodeResultsLabel,
    addNodeResults,
    addNodeSelectedLabel,
    addNodeSelected,
    addNodeFooter,
  );
  addNodeWrap.append(addNodeButton, addNodePopup);

  const graphFilterDescriptors = new Map<string, PaperListDescriptor>();
  const descriptorForGraphNode = (
    node: CitationGraphNode,
  ): PaperListDescriptor | null => {
    if (node.kind === "external" && node.externalWork) {
      return {
        ...describeExternalWork(
          node.externalWork as ExternalWork,
          snapshot.libraryID,
          true,
          false,
          paperByKey,
        ),
        key: node.key,
      };
    }
    const paper = paperByKey.get(node.itemKey);
    if (!paper) return null;
    return {
      ...describeZoteroPaper(paper),
      key: node.key,
      year: node.year,
      citationCount: node.citationCount,
      referenceCount: node.referenceCount,
      tags: node.tags,
      collectionIDs: node.collectionIDs,
      isOpenAccess: node.isOpenAccess,
      isRetracted: node.isRetracted,
    };
  };
  const rebuildGraphFilterDescriptors = (): void => {
    graphFilterDescriptors.clear();
    for (const node of model.nodes) {
      const descriptor = descriptorForGraphNode(node);
      if (descriptor) graphFilterDescriptors.set(node.key, descriptor);
    }
  };
  rebuildGraphFilterDescriptors();
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
    "Find papers related to the currently visible papers without adding them automatically.";
  const exportWrap = element(document, "div", "cm-menu-wrapper");
  const exportButton = element(document, "button", "cm-toolbar-button");
  exportButton.type = "button";
  exportButton.append(iconButtonContent(document, "export", "Export"));
  exportButton.title = "Export only the currently visible citation graph.";
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
    "Refresh metadata and citation counts for the currently visible papers.";
  toolbar.append(addNodeWrap, similarButton, exportWrap, refreshButton);
  header.appendChild(toolbar);
  root.appendChild(header);

  const queryBand = element(document, "section", "cm-query-band");
  const searchWrap = element(document, "label", "cm-search-wrap");
  searchWrap.appendChild(icon(document, "search"));
  const search = element(document, "input", "cm-search");
  search.type = "search";
  search.placeholder = "Search all fields";
  search.setAttribute("aria-label", "Search all fields in the current view");
  searchWrap.appendChild(search);
  queryBand.append(searchWrap, graphFilter.root);
  root.appendChild(queryBand);

  const setViewKind = (kind: "map" | "focus", notify = true): void => {
    const changed = currentViewKind !== kind;
    currentViewKind = kind;
    root.dataset.viewKind = kind;
    viewTitle.textContent = kind === "focus" ? "Focus View" : "Citation Map";
    if (changed && notify) options.onViewKindChange?.(kind);
  };

  const focusBar = element(document, "section", "cm-focus-bar");
  focusBar.hidden = true;
  const focusBackButton = element(document, "button", "cm-secondary-button");
  focusBackButton.type = "button";
  focusBackButton.textContent = "←";
  focusBackButton.title = "Previous focus";
  const focusForwardButton = element(document, "button", "cm-secondary-button");
  focusForwardButton.type = "button";
  focusForwardButton.textContent = "→";
  focusForwardButton.title = "Next focus";
  const focusLabel = text(document, "strong", "Focus");
  focusLabel.className = "cm-focus-label";
  const focusSeedsHost = element(document, "div", "cm-focus-seeds");
  const focusDirection = element(document, "select", "cm-select");
  for (const [value, label] of [
    ["both", "References + cited by"],
    ["references", "References"],
    ["cited-by", "Cited by"],
  ] as const) {
    const option = element(document, "option");
    option.value = value;
    option.textContent = label;
    focusDirection.appendChild(option);
  }
  const focusLocality = element(document, "select", "cm-select");
  for (const [value, label] of [
    ["all", "All known papers"],
    ["local", "In Zotero only"],
  ] as const) {
    const option = element(document, "option");
    option.value = value;
    option.textContent = label;
    focusLocality.appendChild(option);
  }
  const focusRanking = element(document, "select", "cm-select");
  for (const [value, label] of [
    ["relevance", "Relevance"],
    ["most-cited", "Most cited"],
    ["most-recent", "Most recent"],
    ["local-first", "In Zotero first"],
  ] as const) {
    const option = element(document, "option");
    option.value = value;
    option.textContent = label;
    focusRanking.appendChild(option);
  }
  const focusLimit = element(document, "select", "cm-select");
  for (const value of [10, 25, 50, 100, 200]) {
    const option = element(document, "option");
    option.value = String(value);
    option.textContent = `${value} per seed per side`;
    if (value === 25) option.selected = true;
    focusLimit.appendChild(option);
  }
  const focusRefreshButton = element(document, "button", "cm-secondary-button");
  focusRefreshButton.type = "button";
  focusRefreshButton.textContent = "Update connections";
  focusRefreshButton.title =
    "Fetch fresh references and citing papers again. New Focus seeds are updated automatically in the background.";
  const focusExitButton = element(document, "button", "cm-secondary-button");
  focusExitButton.type = "button";
  focusExitButton.textContent = "Back to library map";
  focusBar.append(
    focusBackButton,
    focusForwardButton,
    focusLabel,
    focusSeedsHost,
    focusDirection,
    focusLocality,
    focusRanking,
    focusLimit,
    focusRefreshButton,
    focusExitButton,
  );
  root.appendChild(focusBar);

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
  let libraryLayoutBeforeFocus: GraphLayoutOptions | null = null;
  let libraryViewBeforeFocus: GraphViewTransform | null = null;
  let libraryCollectionFilterBeforeFocus: number | null | undefined;
  let cameraFrame = 0;
  let focusFitGeneration = 0;
  const focusPostRefreshFitSeeds = new Set<string>();
  const cancelCameraFrame = (): void => {
    if (!cameraFrame) return;
    const view = document.defaultView;
    if (view) view.cancelAnimationFrame(cameraFrame);
    else clearTimeout(cameraFrame);
    cameraFrame = 0;
  };
  const scheduleCameraAction = (action: () => void): void => {
    cancelCameraFrame();
    const view = document.defaultView;
    const run = (): void => {
      cameraFrame = 0;
      if (!cleaned) action();
    };
    cameraFrame = view
      ? view.requestAnimationFrame(run)
      : (setTimeout(run, 0) as unknown as number);
  };
  const scheduleFocusFit = (): void => {
    cancelCameraFrame();
    const generation = ++focusFitGeneration;
    const view = document.defaultView;
    let previousWidth = -1;
    let previousHeight = -1;
    let previousNodeCount = -1;
    let stableFrames = 0;
    let attempts = 0;

    const check = (): void => {
      cameraFrame = 0;
      if (cleaned || !focusProjection || generation !== focusFitGeneration) {
        return;
      }
      renderer?.resizeViewport();
      const rect = renderer?.getCanvas().getBoundingClientRect();
      const nodeCount = focusProjection.nodes.length;
      const ready = Boolean(rect && rect.width >= 240 && rect.height >= 180);
      const stable =
        ready &&
        Math.abs(rect!.width - previousWidth) < 0.5 &&
        Math.abs(rect!.height - previousHeight) < 0.5 &&
        nodeCount === previousNodeCount;
      stableFrames = stable ? stableFrames + 1 : 0;
      previousWidth = rect?.width ?? previousWidth;
      previousHeight = rect?.height ?? previousHeight;
      previousNodeCount = nodeCount;
      attempts += 1;

      if (stableFrames >= 2 || attempts >= 24) {
        renderer?.fitVisibleNodes();
        return;
      }
      cameraFrame = view
        ? view.requestAnimationFrame(check)
        : (setTimeout(check, 16) as unknown as number);
    };

    cameraFrame = view
      ? view.requestAnimationFrame(check)
      : (setTimeout(check, 0) as unknown as number);
  };
  const fitCurrentGraph = (): void => {
    if (focusProjection || mapScopeItemIDs) renderer?.fitVisibleNodes();
    else renderer?.fitView();
  };
  let sourceMetricsRefreshActive = false;
  const refreshSourceMetricsForLayout = (layout: GraphLayoutOptions): void => {
    if (!graphLayoutUsesSourceMetrics(layout) || sourceMetricsRefreshActive)
      return;
    sourceMetricsRefreshActive = true;
    const candidates = model.nodes.filter(
      (node) => node.kind !== "external" && visibleKeys.has(node.key),
    );
    void ensureSourceMetricsForNodes(candidates, () => {
      if (cleaned || !graphLayoutUsesSourceMetrics(currentLayout)) return;
      renderer?.setLayout(currentLayout);
      fitCurrentGraph();
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
        fitCurrentGraph();
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
      fitCurrentGraph();
      refreshSourceMetricsForLayout(layout);
    },
    (visible) => renderer?.setLegendVisible(visible),
    (layout) => {
      if (focusProjection) setFocusGraphAppearance(layout);
      else setGraphAppearance(layout);
    },
    () =>
      focusProjection
        ? resetFocusGraphAppearance(
            libraryLayoutBeforeFocus ?? getGraphAppearance(),
          )
        : resetGraphAppearance(),
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

  let addLibraryItemsToView = (
    _itemIDs: readonly number[],
  ): CitationMapFocusResult => "not-found";
  const selectedLibraryItemIDs = new Set<number>();
  const libraryPaperByID = new Map(
    snapshot.papers.map((paper) => [paper.itemID, paper]),
  );
  let librarySearchGeneration = 0;

  const closeAddNodePopup = (): void => {
    addNodePopup.hidden = true;
    addNodeButton.setAttribute("aria-expanded", "false");
  };

  const renderSelectedLibraryPapers = (): void => {
    clear(addNodeSelected);
    const selectedPapers = [...selectedLibraryItemIDs]
      .map((itemID) => libraryPaperByID.get(itemID))
      .filter((paper): paper is ZoteroPaper => Boolean(paper));
    if (!selectedPapers.length) {
      addNodeSelected.appendChild(
        text(document, "p", "No papers selected.", "cm-placeholder"),
      );
    } else {
      for (const paper of selectedPapers) {
        const chip = element(document, "span", "cm-add-node-chip");
        const label = text(document, "span", paper.title || "Untitled item");
        label.title = paper.title || "Untitled item";
        const remove = element(document, "button");
        remove.type = "button";
        remove.textContent = "×";
        remove.title = `Deselect ${paper.title || "paper"}`;
        remove.addEventListener("click", () => {
          selectedLibraryItemIDs.delete(paper.itemID);
          renderSelectedLibraryPapers();
          void renderLibrarySearchResults();
        });
        chip.append(label, remove);
        addNodeSelected.appendChild(chip);
      }
    }
    addNodeStatus.textContent = selectedPapers.length
      ? `${selectedPapers.length} paper${selectedPapers.length === 1 ? "" : "s"} selected.`
      : "No papers selected.";
    addSelectedButton.disabled = selectedPapers.length === 0;
  };

  const searchLibraryPapers = async (
    query: string,
  ): Promise<LibraryPaperSearchEntry[]> => {
    const search = new Zotero.Search();
    search.libraryID = snapshot.libraryID;
    search.addCondition("quicksearch-titleCreatorYear", "contains", query);
    const resultIDs = (await search.search()) as number[];
    return mapCooperatively(
      resultIDs,
      (itemID) => {
        const paper = libraryPaperByID.get(Number(itemID));
        if (!paper) return null;
        let shortTitle = "";
        let court = "";
        let citationKey = "";
        try {
          const item = Zotero.Items.get(paper.itemID) as Zotero.Item | null;
          shortTitle = String(item?.getField?.("shortTitle") ?? "");
          court = String(item?.getField?.("court") ?? "");
          citationKey = String(item?.getField?.("citationKey") ?? "");
        } catch (error) {
          Zotero.debug(
            `Citation Map: could not rank item ${paper.itemID}: ${String(error)}`,
          );
        }
        return {
          paper,
          titleText: normalizeSearch(paper.title),
          authorText: normalizeSearch(paper.authors.join(" ")),
          mainPropertyText: normalizeSearch(
            [
              paper.sourceTitle ?? "",
              paper.year ?? "",
              paper.publicationDate ?? "",
              shortTitle,
              court,
              citationKey,
            ].join(" "),
          ),
        };
      },
      { forceEvery: 20 },
    ).then((entries) =>
      entries.filter((entry): entry is LibraryPaperSearchEntry =>
        Boolean(entry),
      ),
    );
  };

  async function renderLibrarySearchResults(): Promise<void> {
    const generation = ++librarySearchGeneration;
    const query = addNodeSearch.value.trim();
    clear(addNodeResults);
    if (!query) {
      addNodeResults.appendChild(
        text(
          document,
          "p",
          "Search by title, creator, publication title, year, or citation key.",
          "cm-placeholder",
        ),
      );
      return;
    }
    addNodeResults.appendChild(
      text(document, "p", "Searching library…", "cm-placeholder"),
    );
    const index = await searchLibraryPapers(query).catch((error) => {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return null;
    });
    if (generation !== librarySearchGeneration || addNodePopup.hidden) return;
    if (!index) {
      clear(addNodeResults);
      addNodeResults.appendChild(
        text(document, "p", "Library search failed.", "cm-placeholder"),
      );
      return;
    }
    const matches: Array<{
      entry: LibraryPaperSearchEntry;
      score: number;
    }> = [];
    const compareMatches = (
      left: { entry: LibraryPaperSearchEntry; score: number },
      right: { entry: LibraryPaperSearchEntry; score: number },
    ): number =>
      right.score - left.score ||
      left.entry.paper.title.localeCompare(right.entry.paper.title, undefined, {
        sensitivity: "base",
      });
    await mapCooperatively(
      index,
      (entry) => {
        if (generation !== librarySearchGeneration) return;
        const score = scoreLibraryPaperSearch(entry, query);
        const candidate = { entry, score };
        const insertion = matches.findIndex(
          (current) => compareMatches(candidate, current) < 0,
        );
        if (insertion < 0) matches.push(candidate);
        else matches.splice(insertion, 0, candidate);
        if (matches.length > 50) matches.pop();
      },
      { forceEvery: 100 },
    );
    if (generation !== librarySearchGeneration || addNodePopup.hidden) return;
    clear(addNodeResults);
    if (!matches.length) {
      addNodeResults.appendChild(
        text(document, "p", "No matching papers found.", "cm-placeholder"),
      );
      return;
    }
    for (const { entry } of matches) {
      const paper = entry.paper;
      const row = element(document, "label", "cm-add-node-result");
      const checkbox = element(document, "input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedLibraryItemIDs.has(paper.itemID);
      const content = element(document, "span", "cm-add-node-result-copy");
      content.append(
        text(document, "strong", paper.title || "Untitled item"),
        text(
          document,
          "span",
          [
            paper.authors.slice(0, 3).join(", "),
            paper.year === null ? "" : String(paper.year),
            paper.sourceTitle ?? "",
          ]
            .filter(Boolean)
            .join(" · "),
          "cm-add-node-result-meta",
        ),
      );
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedLibraryItemIDs.add(paper.itemID);
        else selectedLibraryItemIDs.delete(paper.itemID);
        renderSelectedLibraryPapers();
      });
      row.append(checkbox, content);
      addNodeResults.appendChild(row);
    }
  }

  addNodeButton.addEventListener("click", () => {
    const opening = addNodePopup.hidden;
    addNodePopup.hidden = !opening;
    addNodeButton.setAttribute("aria-expanded", String(opening));
    if (!opening) return;
    renderSelectedLibraryPapers();
    void renderLibrarySearchResults();
    document.defaultView?.setTimeout(() => addNodeSearch.focus(), 0);
  });
  addNodeSearch.addEventListener("input", () => {
    void renderLibrarySearchResults();
  });
  addSelectedButton.addEventListener("click", () => {
    const itemIDs = [...selectedLibraryItemIDs];
    if (!itemIDs.length) return;
    addLibraryItemsToView(itemIDs);
    selectedLibraryItemIDs.clear();
    renderSelectedLibraryPapers();
    closeAddNodePopup();
  });
  const closeAddNodePopupOnOutsidePointer = (event: Event): void => {
    if (addNodePopup.hidden) return;
    const target = event.target as Node | null;
    if (target && addNodeWrap.contains(target)) return;
    closeAddNodePopup();
  };
  const closeAddNodePopupOnEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && !addNodePopup.hidden) {
      closeAddNodePopup();
      addNodeButton.focus();
    }
  };
  document.addEventListener(
    "pointerdown",
    closeAddNodePopupOnOutsidePointer,
    true,
  );
  document.addEventListener("keydown", closeAddNodePopupOnEscape, true);
  renderSelectedLibraryPapers();

  const updateSummary = (): void => {
    const renderedKeys = new Set(visibleKeys);
    const base = `${formatCount(renderedKeys.size)} nodes - ${formatCount(
      renderer?.getVisibleEdgeCount() ?? 0,
    )} links`;
    if (!focusProjection) {
      summary.textContent = base;
      return;
    }
    const hidden =
      focusProjection.hidden.references + focusProjection.hidden.citedBy;
    summary.textContent = hidden ? `${base} - ${hidden} more available` : base;
  };

  const cloneFocusState = (state: GraphFocusState): GraphFocusState => ({
    ...state,
    seedKeys: [...state.seedKeys],
  });

  const focusStateFromControls = (seedKeys: string[]): GraphFocusState => ({
    seedKeys: [...new Set(seedKeys)],
    direction: focusDirection.value as GraphFocusDirection,
    locality: focusLocality.value as GraphFocusLocality,
    ranking: focusRanking.value as GraphFocusRanking,
    maxPerDirection: Math.max(1, Number(focusLimit.value) || 25),
  });

  const resolveFocusSeed = (
    candidate: CitationGraphNode,
  ): CitationGraphNode => {
    const local =
      candidate.itemID > 0
        ? libraryModel.nodes.find(
            (node) =>
              node.key === candidate.key || node.itemID === candidate.itemID,
          )
        : null;
    const seed = local ?? candidate;
    focusSeedRegistry.set(seed.key, seed);
    return seed;
  };

  const seedRelationshipGraph = (
    seed: CitationGraphNode,
  ): typeof libraryModel => {
    if (libraryModel.nodes.some((node) => node.key === seed.key)) {
      return libraryModel;
    }
    return {
      nodes: [...libraryModel.nodes, seed],
      edges: [...libraryModel.edges],
      statistics: { ...libraryModel.statistics },
    };
  };

  const ensureFocusRelationships = (
    seed: CitationGraphNode,
  ): { references: ExternalWork[]; citedBy: ExternalWork[] } => {
    const existing = focusRelationships.get(seed.key);
    if (existing) return existing;
    const graph = seedRelationshipGraph(seed);
    const cachedReferences = getRelationshipViewSnapshot(
      graph,
      seed,
      "references",
      snapshot.libraryID,
      FOCUS_RELATIONSHIP_CACHE_LIMIT,
      { queueBackgroundHydration: false },
    ).works;
    const embeddedReferences = (
      seed.externalWork?.references?.length
        ? seed.externalWork.references
        : seed.references
    ) as ExternalWork[];
    const relationships = {
      // Some providers include references in the paper summary itself. Use
      // those immediately instead of waiting for a second endpoint request.
      references: mergeRelatedWorkLists(
        cachedReferences,
        embeddedReferences,
      ) as ExternalWork[],
      citedBy: getRelationshipViewSnapshot(
        graph,
        seed,
        "cited-by",
        snapshot.libraryID,
        FOCUS_RELATIONSHIP_CACHE_LIMIT,
        { queueBackgroundHydration: false },
      ).works,
    };
    focusRelationships.set(seed.key, relationships);
    return relationships;
  };

  const externalWorkForFocusSeed = (seed: CitationGraphNode): ExternalWork => {
    const external = seed.externalWork;
    return {
      ...(external ?? {
        provider: seed.provider ?? "manual",
        providerWorkID: seed.providerWorkID,
        doi: seed.doi,
        title: seed.title || null,
        year: seed.year,
        authors: [...seed.authors],
      }),
      provider: external?.provider ?? seed.provider ?? "manual",
      providerWorkID: seed.providerWorkID ?? external?.providerWorkID ?? null,
      doi: seed.doi ?? external?.doi ?? null,
      title: seed.title || external?.title || null,
      year: seed.year ?? external?.year ?? null,
      publicationDate:
        seed.publicationDate ?? external?.publicationDate ?? null,
      authors: seed.authors.length
        ? [...seed.authors]
        : [...(external?.authors ?? [])],
      sourceTitle: seed.sourceTitle ?? external?.sourceTitle ?? null,
      citationCount: seed.citationCount ?? external?.citationCount ?? null,
      referenceCount: seed.referenceCount ?? external?.referenceCount ?? null,
      references: external?.references?.length
        ? [...external.references]
        : [...seed.references],
    };
  };

  const prepareExternalFocusSeedForRefresh = async (
    seed: CitationGraphNode,
  ): Promise<boolean> => {
    if (seed.itemID > 0) return true;

    let work = externalWorkForFocusSeed(seed);
    let refreshable = synchronizeExternalFocusNode(seed, work);
    if (!refreshable) {
      // External relationship cards can initially contain only a title/year.
      // Resolve one paper summary cooperatively before attempting both
      // relationship directions, then promote the provisional cache subject
      // when a DOI or provider work ID becomes available.
      const hydrated = await hydrateExternalWorksMetadata(
        [work],
        false,
        1,
        true,
        true,
      );
      work = hydrated[0] ?? work;
      refreshable = synchronizeExternalFocusNode(seed, work);
    }

    focusSeedRegistry.set(seed.key, seed);
    if (refreshable) {
      const relationships = focusRelationships.get(seed.key);
      const embedded = seed.externalWork?.references ?? [];
      if (relationships && embedded.length) {
        relationships.references = mergeRelatedWorkLists(
          relationships.references,
          embedded,
        ) as ExternalWork[];
      }
      scheduleFocusRebuild();
    }
    return refreshable;
  };

  let removeFocusSeed = (_key: string): void => undefined;

  const updateFocusBar = (): void => {
    focusBar.hidden = !focusProjection;
    clear(focusSeedsHost);
    if (!focusProjection) return;
    const primarySeed = focusProjection.seeds[0];
    focusLabel.textContent =
      focusProjection.seeds.length === 1
        ? `Focus: ${primarySeed.title}`
        : `Focus: ${focusProjection.seeds.length} seeds`;
    for (const seed of focusProjection.seeds) {
      const chip = element(document, "span", "cm-focus-seed-chip");
      chip.title = seed.title;
      chip.appendChild(
        text(
          document,
          "span",
          seed.title.length > 42 ? `${seed.title.slice(0, 39)}…` : seed.title,
        ),
      );
      if (focusProjection.seeds.length > 1) {
        const remove = element(document, "button");
        remove.type = "button";
        remove.textContent = "×";
        remove.title = `Remove ${seed.title} from Focus View`;
        remove.addEventListener("click", () => removeFocusSeed(seed.key));
        chip.appendChild(remove);
      }
      focusSeedsHost.appendChild(chip);
    }
    focusDirection.value = focusProjection.state.direction;
    focusLocality.value = focusProjection.state.locality;
    focusRanking.value = focusProjection.state.ranking;
    focusLimit.value = String(focusProjection.state.maxPerDirection);
    focusBackButton.disabled = focusBack.length === 0;
    focusForwardButton.disabled = focusForward.length === 0;
  };

  const applyFocusProjection = (
    projection: GraphFocusProjection,
    projectionOptions: { fit?: boolean } = {},
  ): void => {
    setViewKind("focus");
    focusProjection = projection;
    model.nodes.splice(0, model.nodes.length, ...projection.nodes);
    model.edges.splice(0, model.edges.length, ...projection.edges);
    model.statistics.nodes = projection.nodes.length;
    model.statistics.edges = projection.edges.length;
    model.statistics.resolvedNodes = projection.nodes.filter(
      (node) => node.citationCount !== null || node.referenceCount !== null,
    ).length;
    model.statistics.isolatedNodes = projection.nodes.filter(
      (node) =>
        !projection.edges.some(
          (edge) => edge.source === node.key || edge.target === node.key,
        ),
    ).length;
    rebuildGraphFilterDescriptors();
    renderer?.syncModel({ draw: false });
    renderer?.setSeedKeys(projection.seedKeys, false);
    renderer?.setPinnedKeys(new Set(), false);
    applyFilters();
    if (projectionOptions.fit) scheduleFocusFit();
    updateFocusBar();
  };

  const seedsForState = (state: GraphFocusState): CitationGraphNode[] =>
    state.seedKeys
      .map(
        (key) =>
          focusSeedRegistry.get(key) ??
          libraryModel.nodes.find((node) => node.key === key) ??
          model.nodes.find((node) => node.key === key) ??
          null,
      )
      .filter((node): node is CitationGraphNode => Boolean(node))
      .map(resolveFocusSeed);

  const projectionForState = (
    state: GraphFocusState,
  ): GraphFocusProjection | null => {
    const seeds = seedsForState(state);
    for (const seed of seeds) ensureFocusRelationships(seed);
    return buildGraphFocusProjection({
      graph: libraryModel,
      state: { ...state, seedKeys: seeds.map((seed) => seed.key) },
      seeds,
      relationships: focusRelationships,
    });
  };

  const rebuildCurrentFocus = (options: { fit?: boolean } = {}): boolean => {
    if (!focusProjection) return false;
    if (!viewActive) {
      inactiveRelationshipDirty = true;
      return true;
    }
    const projection = projectionForState(
      focusStateFromControls(focusProjection.state.seedKeys),
    );
    if (!projection) return false;
    applyFocusProjection(projection, options);
    return true;
  };

  const scheduleFocusRebuild = (): void => {
    if (!focusProjection || focusRebuildFrame) return;
    if (!viewActive) {
      inactiveRelationshipDirty = true;
      return;
    }
    const view = document.defaultView;
    const run = (): void => {
      focusRebuildFrame = 0;
      if (!cleaned) rebuildCurrentFocus();
    };
    focusRebuildFrame = view
      ? view.requestAnimationFrame(run)
      : (setTimeout(run, 0) as unknown as number);
  };

  const activateFocusState = (
    state: GraphFocusState,
    options: { fit?: boolean; selectKey?: string } = {},
  ): boolean => {
    const projection = projectionForState(state);
    if (!projection) return false;
    focusDirection.value = projection.state.direction;
    focusLocality.value = projection.state.locality;
    focusRanking.value = projection.state.ranking;
    focusLimit.value = String(projection.state.maxPerDirection);
    applyFocusProjection(projection, { fit: options.fit });
    const selectedKey = options.selectKey ?? projection.seeds[0].key;
    if (visibleKeys.has(selectedKey)) {
      renderer?.selectNode(selectedKey, false);
    }
    return true;
  };

  const updateFocusRefreshState = (): void => {
    focusLoadActive = focusRefreshCount > 0;
    focusRefreshButton.disabled = focusLoadActive;
    focusRefreshButton.textContent = focusLoadActive
      ? `Updating ${focusRefreshCount} seed${focusRefreshCount === 1 ? "" : "s"}…`
      : "Update connections";
  };

  const scheduleFocusTask = (callback: () => void, delay = 0): number =>
    document.defaultView
      ? document.defaultView.setTimeout(callback, delay)
      : (setTimeout(callback, delay) as unknown as number);

  const clearFocusTask = (timer: number): void => {
    if (document.defaultView) document.defaultView.clearTimeout(timer);
    else clearTimeout(timer);
  };

  const resetFocusRefreshTracking = (shutdown = false): void => {
    focusRefreshEpoch += 1;
    for (const timer of focusRefreshTimers.values()) {
      clearFocusTask(timer);
    }
    focusRefreshTimers.clear();
    focusRefreshInFlight.clear();
    focusPostRefreshFitSeeds.clear();
    // Keep one serial queue across focus changes. Replacing the queue while a
    // request is active would allow the old and new seed updates to overlap.
    if (shutdown) focusRefreshQueue.close();
    focusRefreshCount = 0;
    updateFocusRefreshState();
  };

  const refreshFocusSeedConnections = (
    seed: CitationGraphNode,
    forceRefresh: boolean,
    epoch: number,
    mode: "automatic" | "manual",
  ): Promise<void> => {
    const existing = focusRefreshInFlight.get(seed.key);
    if (existing) return existing;

    const directions = (["references", "cited-by"] as const).filter(
      (direction) =>
        forceRefresh || !selectedRelationshipCacheIsFresh(seed, direction),
    );
    if (!directions.length) return Promise.resolve();

    focusRefreshCount += 1;
    updateFocusRefreshState();
    const task = focusRefreshQueue
      .enqueue(async () => {
        if (cleaned || epoch !== focusRefreshEpoch) return;
        if (seed.itemID <= 0) {
          await prepareExternalFocusSeedForRefresh(seed);
          if (cleaned || epoch !== focusRefreshEpoch) return;
        }
        for (const direction of directions) {
          if (cleaned || epoch !== focusRefreshEpoch) return;
          try {
            const metadataLimit = Math.max(
              1,
              focusProjection?.state.maxPerDirection ?? 25,
            );
            await refreshExternalRelationships(
              seed,
              libraryModel.nodes,
              direction,
              {
                maximum:
                  mode === "automatic"
                    ? AUTOMATIC_FOCUS_REFRESH.membershipLimit
                    : FOCUS_RELATIONSHIP_CACHE_LIMIT,
                refreshMembership: true,
                // Provider I/O is asynchronous, but the singleton progress popup
                // remains visible while cooperative background processing runs.
                silent: false,
                queueBackgroundHydration: true,
                showBackgroundProgress:
                  mode === "automatic"
                    ? AUTOMATIC_FOCUS_REFRESH.showBackgroundProgress
                    : true,
                mode,
                ...(seed.itemID <= 0
                  ? {
                      providerLimit: 3,
                      providerWorkIDs:
                        seed.provider && seed.providerWorkID
                          ? { [seed.provider]: seed.providerWorkID }
                          : {},
                    }
                  : {}),
                // Automatic seed refresh publishes membership immediately and
                // defers all optional summary hydration. Manual refreshes may
                // still hydrate the currently visible papers before completing.
                metadataHydrationLimit:
                  mode === "automatic"
                    ? AUTOMATIC_FOCUS_REFRESH.foregroundMetadataLimit
                    : metadataLimit,
                ...(mode === "automatic" ? { summaryLookupLimit: 0 } : {}),
                onMembershipResolved: (resolution) => {
                  if (cleaned || epoch !== focusRefreshEpoch) return;
                  if (resolution.reportedCount !== null) {
                    if (direction === "references") {
                      seed.referenceCount = resolution.reportedCount;
                    } else {
                      seed.citationCount = resolution.reportedCount;
                    }
                  }
                  const relationships = ensureFocusRelationships(seed);
                  const published = getRelationshipViewSnapshot(
                    seedRelationshipGraph(seed),
                    seed,
                    direction,
                    snapshot.libraryID,
                    FOCUS_RELATIONSHIP_CACHE_LIMIT,
                    { queueBackgroundHydration: false },
                  ).works;
                  if (direction === "references") {
                    relationships.references = published;
                  } else {
                    relationships.citedBy = published;
                  }
                  scheduleFocusRebuild();
                },
                onMetadataHydrated: () => {
                  if (
                    cleaned ||
                    epoch !== focusRefreshEpoch ||
                    !focusProjection?.seedKeys.has(seed.key)
                  ) {
                    return;
                  }
                  scheduleFocusRebuild();
                },
              },
            );
            if (cleaned || epoch !== focusRefreshEpoch) return;
            const relationships = ensureFocusRelationships(seed);
            const refreshed = getRelationshipViewSnapshot(
              seedRelationshipGraph(seed),
              seed,
              direction,
              snapshot.libraryID,
              FOCUS_RELATIONSHIP_CACHE_LIMIT,
              { queueBackgroundHydration: false },
            ).works;
            if (direction === "references") {
              relationships.references = refreshed;
            } else {
              relationships.citedBy = refreshed;
            }
          } catch (error) {
            Zotero.logError(
              error instanceof Error ? error : new Error(String(error)),
            );
          }

          // Yield between directions so provider result normalization cannot
          // monopolize Zotero's UI thread.
          await new Promise<void>((resolve) => {
            scheduleFocusTask(resolve, 0);
          });
        }
      })
      .finally(() => {
        if (epoch !== focusRefreshEpoch) return;
        focusRefreshInFlight.delete(seed.key);
        focusRefreshCount = Math.max(0, focusRefreshCount - 1);
        updateFocusRefreshState();
      });
    focusRefreshInFlight.set(seed.key, task);
    return task;
  };

  const loadFocusConnections = (
    seeds: CitationGraphNode[],
    options: {
      forceRefresh?: boolean;
      mode?: "automatic" | "manual";
    } = {},
  ): Promise<void> => {
    const forceRefresh = options.forceRefresh === true;
    const mode = options.mode ?? "automatic";
    const uniqueSeeds = [
      ...new Map(seeds.map((seed) => [seed.key, seed])).values(),
    ];
    if (!uniqueSeeds.length) return Promise.resolve();
    const epoch = focusRefreshEpoch;
    return Promise.all(
      uniqueSeeds.map((seed) =>
        refreshFocusSeedConnections(seed, forceRefresh, epoch, mode),
      ),
    ).then(() => {
      if (cleaned || epoch !== focusRefreshEpoch || !focusProjection) return;
      if (uniqueSeeds.some((seed) => focusProjection?.seedKeys.has(seed.key))) {
        rebuildCurrentFocus();
      }
    });
  };

  const queueAutomaticFocusConnectionUpdate = (
    seed: CitationGraphNode,
    forceRefresh = AUTOMATIC_FOCUS_REFRESH.forceRefresh,
    fitAfterRefresh = false,
  ): void => {
    if (fitAfterRefresh) focusPostRefreshFitSeeds.add(seed.key);
    const previous = focusRefreshTimers.get(seed.key);
    if (previous !== undefined) {
      clearFocusTask(previous);
    }
    const epoch = focusRefreshEpoch;
    const timer = scheduleFocusTask(() => {
      focusRefreshTimers.delete(seed.key);
      if (
        cleaned ||
        epoch !== focusRefreshEpoch ||
        !focusProjection?.seedKeys.has(seed.key)
      ) {
        focusPostRefreshFitSeeds.delete(seed.key);
        return;
      }
      void loadFocusConnections([seed], {
        mode: "automatic",
        forceRefresh,
      }).finally(() => {
        if (cleaned || epoch !== focusRefreshEpoch) return;
        focusPostRefreshFitSeeds.delete(seed.key);
        if (!focusPostRefreshFitSeeds.size && focusProjection) {
          // The initial seed-only fit is useful for immediate feedback, but
          // once all newly introduced seeds have published their relationship
          // membership the complete node cloud must be fitted exactly once.
          rebuildCurrentFocus({ fit: true });
        }
      });
    }, AUTOMATIC_FOCUS_REFRESH.startDelayMs);
    focusRefreshTimers.set(seed.key, timer);
  };

  const enterFocusSeeds = (
    seedCandidates: readonly CitationGraphNode[],
    options: {
      pushHistory?: boolean;
      state?: GraphFocusState;
    } = {},
  ): boolean => {
    const seeds = [
      ...new Map(
        seedCandidates.map((candidate) => {
          const seed = resolveFocusSeed(candidate);
          return [seed.key, seed] as const;
        }),
      ).values(),
    ];
    if (!seeds.length) return false;
    const enteringFromLibrary = !focusProjection;
    if (!enteringFromLibrary) resetFocusRefreshTracking();
    if (enteringFromLibrary) {
      libraryLayoutBeforeFocus = { ...currentLayout };
      libraryViewBeforeFocus = renderer?.getViewTransform() ?? null;
      libraryCollectionFilterBeforeFocus = graphFilter.state().collectionID;
      // A collection is a library-map scope, not a property of an external
      // neighbour. Keeping it active in Focus View hides every cited/citing
      // paper that is not already filed in that Zotero collection.
      if (libraryCollectionFilterBeforeFocus !== null) {
        graphFilter.setCollectionID(null);
      }
    }
    if (focusProjection && options.pushHistory !== false) {
      focusBack.push(cloneFocusState(focusProjection.state));
      focusForward.splice(0);
    }
    const state = options.state ?? {
      seedKeys: seeds.map((seed) => seed.key),
      direction: "both",
      locality: "all",
      ranking: "relevance",
      maxPerDirection: 25,
    };
    const normalizedState = {
      ...state,
      seedKeys: state.seedKeys.length
        ? [...state.seedKeys]
        : seeds.map((seed) => seed.key),
    };
    if (
      !activateFocusState(normalizedState, {
        fit: false,
        selectKey: seeds[0].key,
      })
    ) {
      if (enteringFromLibrary) {
        libraryLayoutBeforeFocus = null;
        libraryViewBeforeFocus = null;
        if (libraryCollectionFilterBeforeFocus !== undefined) {
          graphFilter.setCollectionID(libraryCollectionFilterBeforeFocus);
          libraryCollectionFilterBeforeFocus = undefined;
        }
      }
      return false;
    }
    if (enteringFromLibrary) {
      appearance.setLayout(
        getFocusGraphAppearance(libraryLayoutBeforeFocus ?? currentLayout),
        false,
      );
    }
    scheduleFocusFit();
    for (const seed of seeds) {
      queueAutomaticFocusConnectionUpdate(seed, true, true);
    }
    return true;
  };

  const enterFocus = (
    seedCandidate: CitationGraphNode,
    options: {
      pushHistory?: boolean;
      state?: GraphFocusState;
    } = {},
  ): boolean => enterFocusSeeds([seedCandidate], options);

  const addFocusSeeds = (candidates: readonly CitationGraphNode[]): boolean => {
    const seeds = [
      ...new Map(
        candidates.map((candidate) => {
          const seed = resolveFocusSeed(candidate);
          return [seed.key, seed] as const;
        }),
      ).values(),
    ];
    if (!seeds.length) return false;
    if (!focusProjection) return enterFocusSeeds(seeds);

    const missingSeeds = seeds.filter(
      (seed) => !focusProjection?.seedKeys.has(seed.key),
    );
    if (!missingSeeds.length) return true;

    focusBack.push(cloneFocusState(focusProjection.state));
    focusForward.splice(0);
    for (const seed of missingSeeds) ensureFocusRelationships(seed);
    const state = focusStateFromControls(
      appendUniqueCitationMapKeys(
        focusProjection.state.seedKeys,
        missingSeeds.map((seed) => seed.key),
      ),
    );
    if (
      !activateFocusState(state, {
        fit: true,
        selectKey: missingSeeds[0].key,
      })
    ) {
      return false;
    }
    for (const seed of missingSeeds) {
      queueAutomaticFocusConnectionUpdate(seed, true, true);
    }
    return true;
  };

  const addFocusSeed = (candidate: CitationGraphNode): boolean =>
    addFocusSeeds([candidate]);

  removeFocusSeed = (key: string): void => {
    if (!focusProjection || !focusProjection.seedKeys.has(key)) return;
    const remaining = focusProjection.state.seedKeys.filter(
      (seedKey) => seedKey !== key,
    );
    if (!remaining.length) {
      exitFocus();
      return;
    }
    focusBack.push(cloneFocusState(focusProjection.state));
    focusForward.splice(0);
    activateFocusState(focusStateFromControls(remaining), { fit: true });
  };

  const focusOnPaper = (node: CitationGraphNode): boolean => {
    const seed = resolveFocusSeed(node);
    const state = focusProjection
      ? focusStateFromControls([seed.key])
      : undefined;
    return enterFocus(seed, { state });
  };

  const restoreFocusState = (state: GraphFocusState): boolean =>
    activateFocusState(cloneFocusState(state), { fit: true });

  const replaceLibraryGraph = (
    next: ReturnType<typeof buildCitationGraph>,
  ): void => {
    libraryModel.nodes.splice(0, libraryModel.nodes.length, ...next.nodes);
    libraryModel.edges.splice(0, libraryModel.edges.length, ...next.edges);
    Object.assign(libraryModel.statistics, next.statistics);
    if (focusProjection) {
      rebuildCurrentFocus();
      return;
    }
    model.nodes.splice(0, model.nodes.length, ...libraryModel.nodes);
    model.edges.splice(0, model.edges.length, ...libraryModel.edges);
    Object.assign(model.statistics, libraryModel.statistics);
    rebuildGraphFilterDescriptors();
    renderer?.syncModel();
    applyFilters();
  };

  const exitFocus = (): void => {
    resetFocusRefreshTracking();
    focusProjection = null;
    setViewKind("map");
    focusRelationships.clear();
    focusSeedRegistry.clear();
    focusBack.splice(0);
    focusForward.splice(0);
    model.nodes.splice(0, model.nodes.length, ...libraryModel.nodes);
    model.edges.splice(0, model.edges.length, ...libraryModel.edges);
    Object.assign(model.statistics, libraryModel.statistics);
    rebuildGraphFilterDescriptors();
    renderer?.syncModel({ draw: false });
    renderer?.setSeedKeys(new Set(), false);
    syncMapPinnedKeys(false);
    const restoreLayout = libraryLayoutBeforeFocus;
    const restoreView = libraryViewBeforeFocus;
    const restoreCollectionFilter = libraryCollectionFilterBeforeFocus;
    libraryLayoutBeforeFocus = null;
    libraryViewBeforeFocus = null;
    libraryCollectionFilterBeforeFocus = undefined;
    if (restoreLayout) appearance.setLayout(restoreLayout, false);
    if (restoreCollectionFilter !== undefined) {
      graphFilter.setCollectionID(restoreCollectionFilter);
    }
    updateFocusBar();
    applyFilters();
    if (restoreView) {
      scheduleCameraAction(() => {
        if (!focusProjection) renderer?.setViewTransform(restoreView);
      });
    } else if (!restoreLayout) {
      scheduleCameraAction(() => {
        if (!focusProjection) renderer?.fitView();
      });
    }
    renderOverview(null);
  };

  const relationshipPublicationStateForNode = (
    node: CitationGraphNode,
    direction: "references" | "cited-by",
  ) =>
    getRelationshipPublicationState(
      snapshot.libraryID,
      node.itemKey,
      direction,
    ) ??
    getRelationshipPublicationState(
      Zotero.Libraries.userLibraryID,
      node.itemKey,
      direction,
    );

  const relationshipTabLabel = (
    node: CitationGraphNode,
    direction: "references" | "cited-by",
  ): string => {
    const label = direction === "references" ? "References" : "Cited by";
    const state = relationshipPublicationStateForNode(node, direction);
    if (state?.active && !state.membershipPublished) {
      return `${label} (updating…)`;
    }
    const reportedCounts = getRelationshipReportedCounts(
      snapshot.libraryID,
      node,
    );
    const count = state?.membershipPublished
      ? state.reportedCount
      : direction === "references"
        ? reportedCounts.referenceCount
        : reportedCounts.citationCount;
    return `${label} (${formatCount(count)} reported)`;
  };

  const updateRelationshipTabLabels = (node: CitationGraphNode): void => {
    for (const direction of ["cited-by", "references"] as const) {
      const button = detail.querySelector<HTMLButtonElement>(
        `button[data-mode="${direction}"]`,
      );
      if (button) button.textContent = relationshipTabLabel(node, direction);
    }
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

    const tabs = element(document, "div", "cm-detail-tabs");
    for (const [mode, label] of [
      ["overview", "Overview"],
      ["cited-by", relationshipTabLabel(node, "cited-by")],
      ["references", relationshipTabLabel(node, "references")],
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
    const localRelatedKey =
      event.work.inLibraryItemKey ?? event.work.zoteroItemKey ?? null;
    const externalRelatedNode = model.nodes.find(
      (node) =>
        node.kind === "external" &&
        node.externalWork &&
        relationshipWorkKey(node.externalWork as ExternalWork) ===
          relationshipWorkKey(event.work),
    );
    const relatedKey = localRelatedKey ?? externalRelatedNode?.key ?? null;
    let shouldRebuildFocus = false;

    if (focusProjection && !focusLoadActive) {
      for (const seed of focusProjection.seeds) {
        if (seed.itemKey !== event.subjectItemKey) continue;
        const relationships = ensureFocusRelationships(seed);
        const list =
          event.direction === "references"
            ? relationships.references
            : relationships.citedBy;
        const identity = relationshipWorkKey(event.work);
        if (event.ignored) {
          const filtered = list.filter(
            (candidate) => relationshipWorkKey(candidate) !== identity,
          );
          if (event.direction === "references") {
            relationships.references = filtered;
          } else {
            relationships.citedBy = filtered;
          }
        } else if (
          !list.some((candidate) => relationshipWorkKey(candidate) === identity)
        ) {
          list.push(event.work);
        }
        shouldRebuildFocus = true;
      }
    }

    if (!relatedKey) {
      if (shouldRebuildFocus) scheduleFocusRebuild();
      return;
    }
    const source =
      event.direction === "references" ? event.subjectItemKey : relatedKey;
    const target =
      event.direction === "references" ? relatedKey : event.subjectItemKey;
    const mutate = (edges: typeof model.edges): void => {
      if (event.ignored) {
        for (let index = edges.length - 1; index >= 0; index -= 1) {
          const edge = edges[index];
          if (edge.source === source && edge.target === target) {
            edges.splice(index, 1);
          }
        }
      } else if (
        !edges.some((edge) => edge.source === source && edge.target === target)
      ) {
        edges.push({
          key: `${source}>${target}`,
          source,
          target,
          provenance: event.work.provider,
          manual: false,
        });
      }
    };
    mutate(model.edges);
    if (localRelatedKey) mutate(libraryModel.edges);
    renderer?.setRelationshipHidden(source, target, event.ignored);
    model.statistics.edges = model.edges.length;
    libraryModel.statistics.edges = libraryModel.edges.length;
    if (shouldRebuildFocus) scheduleFocusRebuild();
    updateSummary();
  }

  const nodesForRelationshipPublication = (
    event: RelationshipPublicationEvent,
  ): CitationGraphNode[] => {
    const byKey = new Map<string, CitationGraphNode>();
    for (const candidate of [
      ...libraryModel.nodes,
      ...model.nodes,
      ...focusSeedRegistry.values(),
    ]) {
      if (candidate.itemKey !== event.subjectItemKey) continue;
      if (candidate.itemID > 0 && event.libraryID !== snapshot.libraryID) {
        continue;
      }
      byKey.set(candidate.key, candidate);
    }
    return [...byKey.values()];
  };

  const applyRelationshipPublicationToNode = (
    node: CitationGraphNode,
    event: RelationshipPublicationEvent,
  ): void => {
    if (event.direction === "references") {
      if (event.reportedCount !== null) {
        node.referenceCount = event.reportedCount;
        node.referenceCountProvider = event.reportedCountProvider;
      }
      node.resolvedReferenceCount = event.identifiedCount;
      if (node.externalWork) {
        if (event.reportedCount !== null) {
          node.externalWork.referenceCount = event.reportedCount;
        }
        node.externalWork.resolvedReferenceCount = event.identifiedCount;
      }
      return;
    }
    if (event.reportedCount !== null) {
      node.citationCount = event.reportedCount;
      node.citationCountProvider = event.reportedCountProvider;
      if (node.externalWork) {
        node.externalWork.citationCount = event.reportedCount;
      }
    }
  };

  const scheduleSelectedPaperRefresh = (
    itemKey: string,
    direction?: "references" | "cited-by",
  ): void => {
    if (relationshipDetailRefreshFrame || cleaned) return;
    const run = (): void => {
      relationshipDetailRefreshFrame = 0;
      if (cleaned || selectedNode?.itemKey !== itemKey) return;
      if (activeRelationshipView) {
        if (
          !direction ||
          (activeRelationshipView.itemKey === itemKey &&
            activeRelationshipView.direction === direction)
        ) {
          refreshActiveRelationshipView?.();
        }
        return;
      }
      const current =
        model.nodes.find((candidate) => candidate.itemKey === itemKey) ??
        libraryModel.nodes.find((candidate) => candidate.itemKey === itemKey) ??
        selectedNode;
      renderOverview(current);
    };
    relationshipDetailRefreshFrame = document.defaultView
      ? document.defaultView.setTimeout(run, 30)
      : (setTimeout(run, 30) as unknown as number);
  };

  const scheduleRelationshipGraphRefresh = (): void => {
    if (relationshipGraphRefreshTimer || cleaned) return;
    const run = (): void => {
      relationshipGraphRefreshTimer = 0;
      if (cleaned || focusProjection) return;
      renderer?.setLayout(renderer.getLayout());
      updateSummary();
    };
    relationshipGraphRefreshTimer = document.defaultView
      ? document.defaultView.setTimeout(run, 30)
      : (setTimeout(run, 30) as unknown as number);
  };

  const applyRelationshipPublication = (
    event: RelationshipPublicationEvent,
  ): void => {
    const affected = nodesForRelationshipPublication(event);
    if (!affected.length) return;
    for (const node of affected) {
      applyRelationshipPublicationToNode(node, event);
    }
    const subject =
      affected.find((node) => model.nodes.includes(node)) ?? affected[0];
    if (!subject) return;

    if (event.phase === "membership-published") {
      if (focusProjection?.seedKeys.has(subject.key)) {
        const relationships = ensureFocusRelationships(subject);
        const published = getRelationshipViewSnapshot(
          seedRelationshipGraph(subject),
          subject,
          event.direction,
          snapshot.libraryID,
          FOCUS_RELATIONSHIP_CACHE_LIMIT,
          { queueBackgroundHydration: false },
        ).works;
        if (event.direction === "references") {
          relationships.references = published;
        } else {
          relationships.citedBy = published;
        }
        scheduleFocusRebuild();
      } else {
        scheduleRelationshipGraphRefresh();
      }
    }

    // Summary hydration does not change graph membership or topology. A full
    // focus reconstruction for 1,000+ neighbours was one of the largest UI
    // stalls after background retrieval. Refresh only the selected details;
    // graph metadata is picked up by the next ordinary graph rebuild.

    if (selectedNode?.itemKey !== event.subjectItemKey) return;
    updateRelationshipTabLabels(subject);
    if (
      activeRelationshipView?.itemKey === event.subjectItemKey &&
      activeRelationshipView.direction === event.direction
    ) {
      scheduleSelectedPaperRefresh(event.subjectItemKey, event.direction);
      return;
    }
    if (
      activeRelationshipView === null &&
      (event.phase === "membership-published" ||
        event.phase === "metadata-published")
    ) {
      scheduleSelectedPaperRefresh(event.subjectItemKey);
    }
  };

  const focusNodeForWork = (work: ExternalWork): CitationGraphNode => {
    const localKey = work.inLibraryItemKey ?? work.zoteroItemKey ?? null;
    const local = localKey
      ? libraryModel.nodes.find(
          (node) =>
            node.itemKey.toLocaleUpperCase() === localKey.toLocaleUpperCase(),
        )
      : null;
    return local ?? externalWorkToFocusNode(work, "seed");
  };

  function appendExternalWorkCards(
    works: ExternalWork[],
    relationshipContext?: {
      node: CitationGraphNode;
      direction: "references" | "cited-by";
      rerender: () => void;
      ignoredIndex?: IgnoredRelationIndex;
      referenceIndex?: RelatedWorkLookupIndex;
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
      const metadataText = externalWorkMetadataText(
        work,
        work.recommendationScore,
      );
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
          : `Open ${citationDataSourceLabel(work.provider)} record`;
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

      const focusNode = focusNodeForWork(work);
      const focusButton = element(document, "button", "cm-secondary-button");
      focusButton.type = "button";
      focusButton.textContent = "Focus on this paper";
      focusButton.addEventListener("click", () => {
        focusOnPaper(focusNode);
      });
      actionButtons.appendChild(focusButton);
      if (focusProjection && !focusProjection.seedKeys.has(focusNode.key)) {
        const addSeed = element(document, "button", "cm-secondary-button");
        addSeed.type = "button";
        addSeed.textContent = "Add as seed";
        addSeed.title =
          "Add this paper to the current Focus View without adding it to Zotero.";
        addSeed.addEventListener("click", () => {
          if (addFocusSeed(focusNode)) addSeed.remove();
        });
        actionButtons.appendChild(addSeed);
      }

      let activeIgnoredRelation =
        relationshipContext &&
        relationshipContext.node.kind !== "external" &&
        relationshipContext.node.itemID > 0
          ? ignoredRelationForExternalWork(
              relationshipContext.node,
              relationshipContext.direction,
              work,
              relationshipContext.ignoredIndex,
              relationshipContext.referenceIndex,
            )
          : null;
      let ignoredBadge: HTMLElement | null = null;
      let syncIgnoredState = (): void => undefined;
      if (
        relationshipContext &&
        relationshipContext.node.kind !== "external" &&
        relationshipContext.node.itemID > 0 &&
        work.provider !== "manual"
      ) {
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
            authors: work.authors ?? [],
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
            authors: work.authors ?? [],
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
    refreshActiveRelationshipView = null;
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
    let descriptorCache = new Map<ExternalWork, PaperListDescriptor>();
    let ignoredIndex = createIgnoredRelationIndex(
      getIgnoredRelations(snapshot.libraryID),
    );
    const referenceIndex =
      direction === "references"
        ? createRelatedWorkLookupIndex(
            getCitationMetricRecord(snapshot.libraryID, node.itemKey)
              ?.references ?? [],
          )
        : undefined;
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
    update.disabled =
      relationshipPublicationStateForNode(node, direction)?.active ?? false;

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

    const picker =
      node.kind === "external" || node.itemID <= 0
        ? null
        : createManualRelationshipPicker({
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

    controls.append(toolbar.root, update);
    if (picker) controls.appendChild(picker.button);
    detail.appendChild(controls);
    if (picker) detail.appendChild(picker.overlay);

    const status = text(document, "p", "", "cm-detail-meta");
    const updateStatus = (): void => {
      const publicationActive =
        relationshipPublicationStateForNode(node, direction)?.active ?? false;
      const base = relationshipStatusText(
        relationshipSnapshot,
        shownCount,
        filtered,
        updating || publicationActive,
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
      const ordered = toolbar.apply(entries, ({ work }) => {
        const cached = descriptorCache.get(work);
        if (cached) return cached;
        const descriptor = describeExternalWork(
          work,
          snapshot.libraryID,
          true,
          false,
          paperByKey,
        );
        descriptorCache.set(work, descriptor);
        return descriptor;
      });
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
        const batch = ordered.slice(index, index + 24);
        appendExternalWorkCards(
          batch.map((entry) => entry.work),
          {
            node,
            direction,
            ignoredIndex,
            referenceIndex,
            rerender: () => {
              ignoredIndex = createIgnoredRelationIndex(
                getIgnoredRelations(snapshot.libraryID),
              );
              relationshipSnapshot = getRelationshipViewSnapshot(
                model,
                node,
                direction,
                snapshot.libraryID,
                RELATIONSHIP_VIEW_LIMIT,
              );
              works = relationshipSnapshot.works;
              descriptorCache = new Map();
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

    refreshActiveRelationshipView = (): void => {
      if (
        cleaned ||
        activeRelationshipView?.itemKey !== node.itemKey ||
        activeRelationshipView.direction !== direction
      ) {
        return;
      }
      relationshipSnapshot = getRelationshipViewSnapshot(
        model,
        node,
        direction,
        snapshot.libraryID,
        RELATIONSHIP_VIEW_LIMIT,
        { queueBackgroundHydration: false },
      );
      works = relationshipSnapshot.works;
      update.disabled =
        updating ||
        (relationshipPublicationStateForNode(node, direction)?.active ?? false);
      updateRelationshipTabLabels(node);
      renderList();
    };

    update.addEventListener("click", () => {
      if (update.disabled) return;
      const requestScope = createCancellationScope(
        `${direction} relationship update for ${node.itemKey}`,
      );
      update.disabled = true;
      updating = true;
      updateOutcome = null;
      updateStatus();
      const cancelUpdate = (): void => {
        requestScope.cancel();
        updating = false;
        updateOutcome = "Update cancelled";
        if (update.isConnected) update.disabled = false;
        updateStatus();
      };
      const progress = createUpdateProgress({
        document,
        title: updateLabel,
        message: "Checking provider pages for new relationships…",
        onCancel: cancelUpdate,
      });
      void (async () => {
        const previousWorks = works;
        try {
          await refreshExternalRelationships(node, model.nodes, direction, {
            maximum: RELATIONSHIP_VIEW_LIMIT,
            refreshMembership: true,
            silent: true,
            mode: "manual",
            queueBackgroundHydration: true,
            signal: requestScope.signal,
            onMembershipResolved: (resolution) => {
              if (resolution.reportedCount === null) return;
              if (direction === "references") {
                node.referenceCount = resolution.reportedCount;
              } else {
                node.citationCount = resolution.reportedCount;
              }
            },
          });
          if (requestScope.signal.cancelled) {
            updateOutcome = "Update cancelled";
            progress.dismiss();
            return;
          }
          relationshipSnapshot = getRelationshipViewSnapshot(
            model,
            node,
            direction,
            snapshot.libraryID,
            RELATIONSHIP_VIEW_LIMIT,
          );
          works = relationshipSnapshot.works;
          descriptorCache = new Map();
          if (focusProjection?.seedKeys.has(node.key)) {
            const relationships = ensureFocusRelationships(node);
            if (direction === "references") {
              relationships.references = works;
            } else {
              relationships.citedBy = works;
            }
            rebuildCurrentFocus();
          }
          const added = newlyRetrievedRelationshipWorkCount(
            previousWorks,
            works,
          );
          updateOutcome = added
            ? `${added} new paper${added === 1 ? "" : "s"} added`
            : "No new papers returned";
          progress.finish(updateOutcome);
        } catch (error) {
          if (requestScope.signal.cancelled) {
            updateOutcome = "Update cancelled";
            progress.dismiss();
            return;
          }
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
    refreshActiveRelationshipView = null;
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
    appendMetric("Provider", node.provider ?? "Zotero/local data");
    appendMetric(
      "Updated",
      node.metricsUpdatedAt
        ? new Date(node.metricsUpdatedAt).toLocaleString()
        : "—",
    );
    detail.appendChild(rows);

    if (node.kind === "external" && node.externalWork) {
      const work = node.externalWork as ExternalWork;
      const actions = element(document, "div", "cm-detail-actions");
      actions.style.flexWrap = "wrap";

      const localKey = work.inLibraryItemKey ?? work.zoteroItemKey ?? null;
      const localItem = localKey
        ? ((Zotero.Items as any).getByLibraryAndKey?.(
            snapshot.libraryID,
            localKey,
          ) as Zotero.Item | null)
        : null;
      if (localItem) {
        const show = element(document, "button", "cm-secondary-button");
        show.type = "button";
        show.textContent = "Show in Zotero";
        show.addEventListener("click", () => void selectPaper(localItem.id));
        actions.appendChild(show);
      } else {
        const add = element(document, "button", "cm-primary-button");
        add.type = "button";
        add.textContent = "Add to Zotero";
        const importArea = element(document, "section", "cm-import-area");
        importArea.hidden = true;
        const chooser = createCollectionChooser(document, snapshot);
        const confirm = element(document, "button", "cm-primary-button");
        confirm.type = "button";
        confirm.textContent = "Add paper";
        const cancel = element(document, "button", "cm-secondary-button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        confirm.addEventListener("click", () => {
          if (confirm.disabled) return;
          confirm.disabled = true;
          confirm.textContent = "Adding…";
          void importExternalWork(work, snapshot.libraryID, [
            ...chooser.selected,
          ])
            .then((items) => {
              const imported = items[0];
              if (!imported) throw new Error("No item was imported.");
              work.inLibraryItemKey = String(imported.key);
              if (node.externalWork) {
                node.externalWork.inLibraryItemKey = String(imported.key);
              }
              importArea.replaceChildren(
                text(document, "p", "Added to Zotero.", "cm-success"),
              );
              add.remove();
              const show = element(document, "button", "cm-secondary-button");
              show.type = "button";
              show.textContent = "Show in Zotero";
              show.addEventListener(
                "click",
                () => void selectPaper(imported.id),
              );
              actions.prepend(show);
            })
            .catch((error: unknown) => {
              Zotero.logError(
                error instanceof Error ? error : new Error(String(error)),
              );
              confirm.disabled = false;
              confirm.textContent = "Import failed — try again";
            });
        });
        cancel.addEventListener("click", () => {
          importArea.hidden = true;
          add.hidden = false;
        });
        add.addEventListener("click", () => {
          add.hidden = true;
          importArea.hidden = false;
        });
        const importButtons = element(document, "div", "cm-detail-actions");
        importButtons.append(cancel, confirm);
        importArea.append(
          text(document, "h4", "Choose collections"),
          chooser.root,
          importButtons,
        );
        actions.appendChild(add);
        detail.appendChild(importArea);
      }

      const sourceURL = externalWorkURL(work);
      if (sourceURL) {
        const open = element(document, "button", "cm-secondary-button");
        open.type = "button";
        open.textContent = work.doi ? "Open DOI" : "Open provider record";
        open.addEventListener("click", () => Zotero.launchURL(sourceURL));
        actions.appendChild(open);
      }

      const focus = element(document, "button", "cm-secondary-button");
      focus.type = "button";
      focus.textContent = "Focus on this paper";
      focus.title = "Replace the current seed set with this paper.";
      focus.addEventListener("click", () => focusOnPaper(node));
      actions.appendChild(focus);

      if (focusProjection && !focusProjection.seedKeys.has(node.key)) {
        const addSeed = element(document, "button", "cm-secondary-button");
        addSeed.type = "button";
        addSeed.textContent = "Add as seed";
        addSeed.title =
          "Add this paper to Focus View without adding it to Zotero.";
        addSeed.addEventListener("click", () => {
          if (addFocusSeed(node)) renderOverview(node);
        });
        actions.appendChild(addSeed);
      }

      const similar = element(document, "button", "cm-primary-button");
      similar.type = "button";
      similar.textContent = "Similar";
      similar.addEventListener("click", () => {
        void loadInlineSimilarResults([node]);
      });
      actions.appendChild(similar);

      const update = element(document, "button", "cm-secondary-button");
      update.type = "button";
      update.textContent = "Update connections";
      update.addEventListener("click", () => {
        if (update.disabled) return;
        update.disabled = true;
        void (async () => {
          for (const direction of ["references", "cited-by"] as const) {
            await refreshExternalRelationships(
              node,
              libraryModel.nodes,
              direction,
              {
                maximum: RELATIONSHIP_VIEW_LIMIT,
                refreshMembership: true,
                silent: true,
                mode: "manual",
                queueBackgroundHydration: true,
                onMembershipResolved: (resolution) => {
                  if (resolution.reportedCount === null) return;
                  if (direction === "references") {
                    node.referenceCount = resolution.reportedCount;
                  } else {
                    node.citationCount = resolution.reportedCount;
                  }
                },
              },
            );
            await new Promise<void>((resolve) => {
              scheduleFocusTask(resolve, 0);
            });
          }
        })()
          .then(() => {
            const relationships = ensureFocusRelationships(node);
            relationships.references = getRelationshipViewSnapshot(
              seedRelationshipGraph(node),
              node,
              "references",
              snapshot.libraryID,
              RELATIONSHIP_VIEW_LIMIT,
            ).works;
            relationships.citedBy = getRelationshipViewSnapshot(
              seedRelationshipGraph(node),
              node,
              "cited-by",
              snapshot.libraryID,
              RELATIONSHIP_VIEW_LIMIT,
            ).works;
            if (focusProjection?.seedKeys.has(node.key)) rebuildCurrentFocus();
            if (!cleaned) renderOverview(node);
          })
          .catch((error: unknown) => {
            Zotero.logError(
              error instanceof Error ? error : new Error(String(error)),
            );
          })
          .finally(() => {
            if (update.isConnected) update.disabled = false;
          });
      });
      actions.appendChild(update);
      detail.appendChild(actions);
    } else {
      const overviewActions = createPaperOverviewActionBar({
        document,
        actionsClass: "cm-detail-actions",
        primaryButtonClass: "cm-primary-button",
        secondaryButtonClass: "cm-secondary-button",
        doi: node.doi,
        onShowInZotero: () => selectPaper(node.itemID),
        onOpenFocusView:
          focusProjection?.seedKeys.size === 1 &&
          focusProjection.seedKeys.has(node.key)
            ? undefined
            : () => {
                focusOnPaper(node);
              },
        onSimilar: () => loadInlineSimilarResults([node]),
        onRefresh: async () => {
          const item = Zotero.Items.get(node.itemID) as Zotero.Item | null;
          if (!item)
            throw new Error("The selected Zotero item is unavailable.");
          await updateCitationDataForItems([item], {
            force: false,
            progressDocument: document,
          });
          const refreshedNode = createMetricNodeForItem(item);
          Object.assign(node, refreshedNode);
          const libraryNode = libraryModel.nodes.find(
            (candidate) => candidate.key === refreshedNode.key,
          );
          if (libraryNode) Object.assign(libraryNode, refreshedNode);
          replaceLibraryGraph(buildCitationGraph(snapshot));
          renderer?.setLayout(currentLayout);
          updateSummary();
          const current = model.nodes.find(
            (candidate) => candidate.key === refreshedNode.key,
          );
          if (!cleaned && current) renderOverview(current);
        },
      });
      detail.appendChild(overviewActions.root);
      if (focusProjection && !focusProjection.seedKeys.has(node.key)) {
        const addSeed = element(document, "button", "cm-secondary-button");
        addSeed.type = "button";
        addSeed.textContent = "Add as seed";
        addSeed.title =
          "Add this paper to the current Focus View without changing Zotero.";
        addSeed.addEventListener("click", () => {
          if (addFocusSeed(node)) renderOverview(node);
        });
        overviewActions.root.appendChild(addSeed);
      }
    }

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
    onOpenNode: (node) => {
      if (node.kind === "external" && node.externalWork) {
        const url = externalWorkURL(node.externalWork as ExternalWork);
        if (url) Zotero.launchURL(url);
        return;
      }
      void selectPaper(node.itemID);
    },
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
    const focusScopeKeys = focusProjection
      ? new Set(focusProjection.nodes.map((node) => node.key))
      : null;
    const activeCollectionID = graphFilter.state().collectionID;
    visibleKeys = new Set(
      model.nodes
        .filter((node) => {
          if (currentViewKind === "focus" && !focusProjection) return false;
          if (focusScopeKeys && !focusScopeKeys.has(node.key)) return false;
          if (
            !focusProjection &&
            mapScopeItemIDs &&
            !mapScopeItemIDs.has(node.itemID)
          ) {
            return false;
          }
          const descriptor = graphFilterDescriptors.get(node.key);
          if (!descriptor) return false;
          // Collection membership scopes the library map. It must never hide
          // external Focus neighbours, even if a collection is selected while
          // Focus View is already open. Other metadata filters still apply.
          const filterDescriptor =
            focusProjection && activeCollectionID !== null
              ? {
                  ...descriptor,
                  collectionIDs: descriptor.collectionIDs.includes(
                    activeCollectionID,
                  )
                    ? descriptor.collectionIDs
                    : [...descriptor.collectionIDs, activeCollectionID],
                }
              : descriptor;
          if (!graphFilter.matches(filterDescriptor)) return false;
          const searchable = graphNodeSearchText(node);
          return tokens.every((token) => searchable.includes(token));
        })
        .map((node) => node.key),
    );
    renderer?.setVisibleKeys(visibleKeys, false);
    const matches = tokens.length ? new Set(visibleKeys) : null;
    renderer?.setSearchMatches(matches);
    updateSummary();
  };
  search.addEventListener("input", applyFilters);
  for (const control of [
    focusDirection,
    focusLocality,
    focusRanking,
    focusLimit,
  ]) {
    control.addEventListener("change", () => {
      if (!focusProjection) return;
      scheduleFocusRebuild();
    });
  }
  focusExitButton.addEventListener("click", exitFocus);
  focusRefreshButton.addEventListener("click", () => {
    if (!focusProjection) return;
    loadFocusConnections(focusProjection.seeds, {
      forceRefresh: true,
      mode: "manual",
    });
  });
  focusBackButton.addEventListener("click", () => {
    if (!focusProjection) return;
    const previous = focusBack.pop();
    if (!previous) return;
    focusForward.push(cloneFocusState(focusProjection.state));
    restoreFocusState(previous);
    updateFocusBar();
  });
  focusForwardButton.addEventListener("click", () => {
    if (!focusProjection) return;
    const next = focusForward.pop();
    if (!next) return;
    focusBack.push(cloneFocusState(focusProjection.state));
    restoreFocusState(next);
    updateFocusBar();
  });
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
    const visibleNodes = model.nodes.filter((node) =>
      visibleKeys.has(node.key),
    );
    const items = visibleNodes
      .filter((node) => node.kind !== "external" && node.itemID > 0)
      .map((node) => Zotero.Items.get(node.itemID) as Zotero.Item | null)
      .filter((item): item is Zotero.Item => Boolean(item));
    const externalNodes = visibleNodes.filter(
      (node) => node.kind === "external" && Boolean(node.externalWork),
    );
    if (!items.length && !externalNodes.length) return;

    refreshButton.disabled = true;
    const externalProgress = externalNodes.length
      ? createUpdateProgress({
          document,
          title: "Refreshing visible external papers",
          message: `Resolving metadata and citation counts for ${externalNodes.length} paper${externalNodes.length === 1 ? "" : "s"}…`,
          total: externalNodes.length,
        })
      : null;
    const localTask = items.length
      ? updateCitationDataForItems(items, {
          force: false,
          progressDocument: document,
        })
      : Promise.resolve(null);
    const externalTask = externalNodes.length
      ? hydrateExternalWorksMetadata(
          externalNodes.map((node) => node.externalWork as ExternalWork),
          true,
          Number.POSITIVE_INFINITY,
          false,
          true,
        )
      : Promise.resolve([] as ExternalWork[]);

    void Promise.all([localTask, externalTask])
      .then(([, hydratedExternalWorks]) => {
        if (cleaned) return;
        hydratedExternalWorks.forEach((work, index) => {
          const node = externalNodes[index];
          if (!node) return;
          synchronizeExternalFocusNode(node, work);
          if (node.externalWork) Object.assign(node.externalWork, work);
        });
        externalProgress?.finish(
          `Refreshed ${hydratedExternalWorks.length} external paper${hydratedExternalWorks.length === 1 ? "" : "s"}.`,
        );
        replaceLibraryGraph(buildCitationGraph(snapshot));
        renderer?.setLayout(currentLayout);
        rebuildGraphFilterDescriptors();
        applyFilters();
        updateSummary();
        if (selectedNode) {
          const current =
            model.nodes.find(
              (candidate) => candidate.key === selectedNode?.key,
            ) ?? selectedNode;
          renderOverview(current);
        }
      })
      .catch((error: unknown) => {
        externalProgress?.fail("External-paper refresh failed.");
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
    if (target?.dataset.action === "fit") fitCurrentGraph();
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
      if (!viewActive) {
        inactiveRelationshipDirty = true;
        return;
      }
      applyRelationshipMutationToGraph(event);
      if (
        activeRelationshipView?.itemKey === event.subjectItemKey &&
        activeRelationshipView.direction === event.direction
      ) {
        document.defaultView?.setTimeout(() => {
          if (!cleaned) refreshActiveRelationshipView?.();
        }, 0);
      }
    },
  );
  const unsubscribeRelationshipPublications = subscribeRelationshipPublications(
    (event) => {
      if (cleaned) return;
      if (!viewActive) {
        inactiveRelationshipDirty = true;
        return;
      }
      applyRelationshipPublication(event);
    },
  );

  const libraryNodeForItem = (itemID: number): CitationGraphNode | null => {
    let node = libraryModel.nodes.find(
      (candidate) => candidate.itemID === itemID,
    );
    if (node) return node;
    const item = Zotero.Items.get(itemID) as Zotero.Item | null;
    if (
      !item ||
      Number(item.libraryID) !== snapshot.libraryID ||
      !item.isRegularItem?.()
    ) {
      return null;
    }
    node = createMetricNodeForItem(item);
    libraryModel.nodes.push(node);
    return node;
  };

  const mapNodesForItems = (itemIDs: readonly number[]): CitationGraphNode[] =>
    normalizedCitationMapItemIDs(itemIDs)
      .map((itemID) => {
        const libraryNode = libraryNodeForItem(itemID);
        if (!libraryNode) return null;
        const renderedNode = model.nodes.find(
          (candidate) => candidate.key === libraryNode.key,
        );
        return (
          renderedNode ??
          renderer?.addNode({ ...libraryNode, focusRole: null }) ??
          libraryNode
        );
      })
      .filter((node): node is CitationGraphNode => Boolean(node));

  const applyMapItems = (
    itemIDs: readonly number[],
    mode: "replace" | "add",
    pinAdded: boolean,
  ): CitationMapFocusResult => {
    if (!renderer) return "not-found";
    if (focusProjection) exitFocus();
    const renderedNodes = mapNodesForItems(itemIDs);
    if (!renderedNodes.length) return "not-found";
    const normalizedIDs = renderedNodes.map((node) => node.itemID);

    if (mode === "replace") {
      mapScopeItemIDs = replaceCitationMapItemScope(normalizedIDs);
      mapPinnedItemIDs = pinAdded ? new Set(normalizedIDs) : new Set();
      graphFilter.setCollectionID(null);
    } else {
      mapScopeItemIDs = extendCitationMapItemScope(
        mapScopeItemIDs,
        normalizedIDs,
      );
      if (pinAdded) {
        mapPinnedItemIDs = new Set([...mapPinnedItemIDs, ...normalizedIDs]);
      }
    }

    publishMapScope();
    rebuildGraphFilterDescriptors();
    syncMapPinnedKeys(false);
    applyFilters();
    const visibleAddedNodes = renderedNodes.filter((node) =>
      visibleKeys.has(node.key),
    );
    if (visibleAddedNodes.length) {
      renderer.selectNode(visibleAddedNodes[0].key, false);
      const fittedKeys =
        mode === "replace"
          ? new Set(visibleAddedNodes.map((node) => node.key))
          : new Set([...mapPinnedKeys()].filter((key) => visibleKeys.has(key)));
      if (fittedKeys.size) {
        scheduleCameraAction(() => renderer?.fitKeys(fittedKeys));
      }
    }
    return visibleAddedNodes.length === renderedNodes.length
      ? "selected"
      : "revealed";
  };

  const replaceMapItems = (
    itemIDs: readonly number[],
  ): CitationMapFocusResult => applyMapItems(itemIDs, "replace", false);

  const addMapItems = (itemIDs: readonly number[]): CitationMapFocusResult =>
    applyMapItems(itemIDs, "add", true);

  const addMapItemsRespectingFilters = (
    itemIDs: readonly number[],
  ): CitationMapFocusResult => applyMapItems(itemIDs, "add", false);

  const revealItems = (itemIDs: readonly number[]): CitationMapFocusResult =>
    addMapItems(itemIDs);

  const revealItem = (itemID: number): CitationMapFocusResult =>
    addMapItems([itemID]);

  const reconcileInactiveView = (): void => {
    if (!inactiveRelationshipDirty || cleaned) return;
    inactiveRelationshipDirty = false;
    if (focusProjection) {
      for (const seed of focusProjection.seeds) {
        const relationships = ensureFocusRelationships(seed);
        relationships.references = getRelationshipViewSnapshot(
          seedRelationshipGraph(seed),
          seed,
          "references",
          snapshot.libraryID,
          FOCUS_RELATIONSHIP_CACHE_LIMIT,
          { queueBackgroundHydration: false },
        ).works;
        relationships.citedBy = getRelationshipViewSnapshot(
          seedRelationshipGraph(seed),
          seed,
          "cited-by",
          snapshot.libraryID,
          FOCUS_RELATIONSHIP_CACHE_LIMIT,
          { queueBackgroundHydration: false },
        ).works;
      }
      rebuildCurrentFocus();
    } else {
      replaceLibraryGraph(buildCitationGraph(snapshot));
      renderer?.setLayout(currentLayout);
      applyFilters();
      updateSummary();
    }
    if (selectedNode) {
      const current =
        model.nodes.find((node) => node.key === selectedNode?.key) ??
        selectedNode;
      renderOverview(current);
    }
  };

  const addFocusItems = (
    itemIDs: readonly number[],
  ): CitationMapFocusResult => {
    const nodes = normalizedCitationMapItemIDs(itemIDs)
      .map((itemID) => libraryNodeForItem(itemID))
      .filter((node): node is CitationGraphNode => Boolean(node));
    return nodes.length && addFocusSeeds(nodes) ? "selected" : "not-found";
  };

  addLibraryItemsToView = (itemIDs) =>
    currentViewKind === "focus"
      ? addFocusItems(itemIDs)
      : addMapItemsRespectingFilters(itemIDs);

  syncMapPinnedKeys(false);
  applyFilters();

  const controller: CitationMapViewController = {
    revealItem,
    revealItems,
    replaceMapItems,
    addMapItems,
    openFocusItem(itemID) {
      return addFocusItems([itemID]);
    },
    openFocusItems: addFocusItems,
    addFocusItems,
    openCollection(collectionID) {
      if (
        !snapshot.collections.some(
          (entry) => entry.collectionID === collectionID,
        )
      ) {
        return "not-found";
      }
      if (focusProjection) exitFocus();
      mapScopeItemIDs = null;
      mapPinnedItemIDs = new Set();
      publishMapScope();
      syncMapPinnedKeys(false);
      graphFilter.setCollectionID(collectionID);
      scheduleCameraAction(() => renderer?.fitVisibleNodes());
      return "selected";
    },
    setActive(active) {
      viewActive = active;
      if (!active) {
        appearance.close();
        return;
      }
      renderer?.resizeViewport();
      reconcileInactiveView();
    },
  };
  controllerByMount.set(mount, controller);

  if (options.initialFocusItemIDs?.length) {
    controller.openFocusItems(options.initialFocusItemIDs);
  } else if (options.initialFocusItemID) {
    controller.openFocusItem(options.initialFocusItemID);
  } else if (options.initialCollectionID) {
    controller.openCollection(options.initialCollectionID);
  } else if (options.initialItemIDs?.length) {
    if (options.initialItemMode === "add") {
      controller.addMapItems(options.initialItemIDs);
    } else {
      controller.replaceMapItems(options.initialItemIDs);
    }
  } else if (options.initialItemID) {
    controller.replaceMapItems([options.initialItemID]);
  }
  updateSummary();
  const cleanup = (): void => {
    cleaned = true;
    resetFocusRefreshTracking(true);
    cancelCameraFrame();
    if (focusRebuildFrame) {
      document.defaultView?.cancelAnimationFrame(focusRebuildFrame);
      clearTimeout(focusRebuildFrame);
      focusRebuildFrame = 0;
    }
    if (relationshipDetailRefreshFrame) {
      document.defaultView?.clearTimeout(relationshipDetailRefreshFrame);
      clearTimeout(relationshipDetailRefreshFrame);
      relationshipDetailRefreshFrame = 0;
    }
    if (relationshipGraphRefreshTimer) {
      document.defaultView?.clearTimeout(relationshipGraphRefreshTimer);
      clearTimeout(relationshipGraphRefreshTimer);
      relationshipGraphRefreshTimer = 0;
    }
    controllerByMount.delete(mount);
    unsubscribeRelationshipMutations();
    unsubscribeRelationshipPublications();
    graphFilter.destroy();
    document.removeEventListener(
      "pointerdown",
      closeAddNodePopupOnOutsidePointer,
      true,
    );
    document.removeEventListener("keydown", closeAddNodePopupOnEscape, true);
    graphArea.removeEventListener("pointerdown", onGraphAreaPointerDown, true);
    renderer?.destroy();
    renderer = null;
  };
  cleanupByMount.set(mount, cleanup);
  return root;
}
