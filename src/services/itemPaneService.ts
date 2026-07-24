import { config } from "../../package.json";
import type {
  IgnoredProviderRelation,
  ManualCitationRelation,
  ManualRelationDirection,
  RelatedWorkMetadata,
} from "../domain/citationTypes";
import type {
  CitationGraphModel,
  CitationGraphNode,
} from "../domain/graphTypes";
import type { LibrarySnapshot } from "../domain/types";
import {
  getMissingPaperRecommendations,
  refreshExternalRelationships,
  externalWorkDisplayTitle,
  importExternalWork,
  type ExternalWork,
} from "./externalDiscoveryService";
import {
  confirmCitationMatch,
  confirmCitationMatchCandidate,
  getCitationMetricRecord,
  getIgnoredRelations,
  getManualRelations,
  ignoreProviderRelation,
  removeIgnoredRelation,
  removeManualRelation,
} from "./citationMetricsStore";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";
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
  relationshipStatusText,
  subscribeRelationshipMutations,
  type RelationshipViewDirection,
  type RelationshipViewSnapshot,
} from "./relationshipViewService";
import {
  createPaperListToolbar,
  describeExternalWork,
} from "./paperListViewService";
import {
  createManualRelationshipPicker,
  manualRelationsForSubject,
} from "./manualRelationshipPickerService";
import { createMetricNodeForItem } from "./itemMetricContext";
import { createPaperOverviewActionBar } from "./paperOverviewActionsService";
import { formatMetricValue, getMetricDefinition } from "./metricRegistry";
import { updateCitationDataForItems } from "./citationUpdateService";
import { createUpdateProgress } from "./updateProgressService";
import { createCitationMapIcon } from "./uiIconService";
import { buildCitationGraph } from "./citationGraphService";
import { ensureSourceMetricsForNodes } from "./sourceMetricsService";
import { refreshOpenCitationMapViews } from "./windowService";
import { loadWholeLibrary } from "./zoteroLibraryService";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const PANE_ID = "citation-map-item-pane";
const RELATION_LIMIT = RELATIONSHIP_VIEW_LIMIT;
type PaneTab = "overview" | "cited-by" | "references";
interface PaneTabState {
  itemKey: string;
  active: PaneTab;
}
let registeredPaneID: string | false | null = null;
let unsubscribeRelationshipMutations: (() => void) | null = null;
const refreshCallbacks = new Map<Element, () => Promise<void>>();
const paneTabState = new WeakMap<HTMLElement, PaneTabState>();

function el<K extends keyof HTMLElementTagNameMap>(
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

function txt<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  value: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = el(document, tag, className);
  node.textContent = value;
  return node;
}

function configureIconButton(
  button: HTMLButtonElement,
  label: string,
  name: "refresh" | "sort" | "ascending" | "descending" = "refresh",
): void {
  button.replaceChildren(createCitationMapIcon(button.ownerDocument, name));
  button.title = label;
  button.setAttribute("aria-label", label);
  button.style.width = "30px";
  button.style.minWidth = "30px";
  button.style.padding = "4px";
  button.style.justifyContent = "center";
}

function clear(node: Element): void {
  node.replaceChildren();
}

function runUIAction(context: string, action: () => Promise<void>): void {
  void action().catch((error: unknown) => {
    const normalized =
      error instanceof Error
        ? error
        : new Error(
            `Citation Map: ${context} failed (${
              error === undefined ? "undefined rejection" : String(error)
            })`,
          );
    Zotero.logError(normalized);
  });
}

function count(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "—"
    : new Intl.NumberFormat(undefined, { useGrouping: false }).format(value);
}

function externalWorkTitle(
  work: RelatedWorkMetadata | ExternalWork,
  libraryID?: number,
): string {
  const localKey =
    (work as ExternalWork).inLibraryItemKey ?? work.zoteroItemKey;
  if (localKey && libraryID !== undefined) {
    const localTitle = String(
      itemByKey(libraryID, localKey)?.getField?.("title") ?? "",
    ).trim();
    if (localTitle) return localTitle;
  }
  return externalWorkDisplayTitle(work) ?? "Title unavailable";
}

function summaryForItem(item: Zotero.Item): string {
  const node = createMetricNodeForItem(item);
  const parts = [
    node.citationCount === null ? null : `${count(node.citationCount)} C`,
    node.referenceCount === null ? null : `${count(node.referenceCount)} R`,
    node.citationVelocity === null
      ? null
      : `${formatMetricValue("citation-rate", node.citationVelocity)}/y`,
  ].filter(Boolean);
  return parts.join(" · ") || "No citation data";
}

function row(
  document: Document,
  label: string,
  value: string,
  description?: string,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const term = txt(document, "dt", label);
  if (description) term.title = description;
  fragment.append(term, txt(document, "dd", value));
  return fragment;
}

function itemByKey(libraryID: number, itemKey: string): Zotero.Item | null {
  try {
    return (
      (Zotero.Items as any).getByLibraryAndKey?.(libraryID, itemKey) ?? null
    );
  } catch {
    return null;
  }
}

function paneSubjectItem(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  let current = item ?? null;
  const visited = new Set<number>();
  while (current) {
    if (current.isRegularItem?.() && !current.deleted) return current;
    const currentID = Number(current.id);
    if (Number.isFinite(currentID)) {
      if (visited.has(currentID)) return null;
      visited.add(currentID);
    }
    const parentID = Number(
      (current as any).parentItemID ??
        (current as any).parentID ??
        (current as any).getSource?.() ??
        0,
    );
    if (!Number.isFinite(parentID) || parentID <= 0) return null;
    current = (Zotero.Items.get(parentID) as Zotero.Item | null) ?? null;
  }
  return null;
}

async function graphNodeForItem(item: Zotero.Item): Promise<{
  node: CitationGraphNode;
  graph: CitationGraphModel;
  snapshot: LibrarySnapshot;
}> {
  const snapshot = await loadWholeLibrary(Number(item.libraryID));
  const graph = buildCitationGraph(snapshot);
  const node =
    graph.nodes.find((candidate) => candidate.itemKey === String(item.key)) ??
    createMetricNodeForItem(item);
  return { node, graph, snapshot };
}

function referenceMatchesNode(
  reference: RelatedWorkMetadata,
  node: CitationGraphNode,
): boolean {
  if (reference.zoteroItemKey === node.itemKey) return true;
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

function createTabs(
  document: Document,
  active: "overview" | "cited-by" | "references",
  citationCount: number | null,
  referenceCount: number | null,
  onSelect: (tab: "overview" | "cited-by" | "references") => void,
): HTMLDivElement {
  const tabs = el(document, "div", "citation-map-pane-tabs");
  for (const [id, label] of [
    ["overview", "Overview"],
    ["cited-by", `Cited by (${count(citationCount)} reported)`],
    ["references", `References (${count(referenceCount)} reported)`],
  ] as const) {
    const button = el(document, "button");
    button.type = "button";
    button.textContent = label;
    button.dataset.selected = String(id === active);
    button.addEventListener("click", () => onSelect(id));
    tabs.appendChild(button);
  }
  return tabs;
}

function renderMatchConfirmation(
  document: Document,
  container: HTMLElement,
  item: Zotero.Item,
  rerender: () => void,
): void {
  const record = getCitationMetricRecord(
    Number(item.libraryID),
    String(item.key),
  );
  if (!record) return;
  if (!record.matchConfirmed && record.status === "success") {
    const warning = el(document, "section", "citation-map-match-warning");
    warning.append(
      txt(document, "strong", "Confirm scholarly-record match"),
      txt(
        document,
        "p",
        `Citation data were matched using ${record.matchedBy ?? "a fallback identifier"}. Confirm that the provider record is the same work.`,
      ),
    );
    const confirm = el(document, "button", "citation-map-primary-button");
    confirm.type = "button";
    confirm.textContent = "Confirm match";
    confirm.addEventListener("click", () => {
      runUIAction("confirming a citation match", async () => {
        confirm.disabled = true;
        await confirmCitationMatch(Number(item.libraryID), String(item.key));
        rerender();
      });
    });
    warning.appendChild(confirm);
    container.appendChild(warning);
  }
  if (record.matchCandidates.length > 0) {
    const warning = el(document, "section", "citation-map-match-warning");
    warning.append(
      txt(document, "strong", "Choose the matching scholarly record"),
      txt(
        document,
        "p",
        "The exact-title fallback returned multiple or contradictory records.",
      ),
    );
    for (const candidate of record.matchCandidates) {
      const card = el(document, "article", "citation-map-candidate");
      card.append(
        txt(
          document,
          "div",
          candidate.title ?? "Untitled",
          "citation-map-candidate-title",
        ),
        txt(
          document,
          "div",
          [
            candidate.authors.slice(0, 3).join(", "),
            candidate.year,
            candidate.doi,
          ]
            .filter(Boolean)
            .join(" · "),
          "citation-map-secondary-text",
        ),
      );
      const use = el(document, "button");
      use.type = "button";
      use.textContent = "Use this match";
      use.addEventListener("click", () => {
        runUIAction("confirming a citation-match candidate", async () => {
          use.disabled = true;
          await confirmCitationMatchCandidate(
            Number(item.libraryID),
            String(item.key),
            candidate,
          );
          await updateCitationDataForItems([item], {
            force: true,
            silent: true,
            includeRelationships: false,
          });
          rerender();
        });
      });
      card.appendChild(use);
      warning.appendChild(card);
    }
    container.appendChild(warning);
  }
}

function renderOverviewSimilarResults(
  document: Document,
  container: HTMLElement,
  item: Zotero.Item,
  works: ExternalWork[],
): void {
  clear(container);
  container.appendChild(txt(document, "h4", "Similar papers"));
  if (!works.length) {
    container.appendChild(
      txt(
        document,
        "p",
        "No similar papers were returned by the available providers.",
        "citation-map-secondary-text",
      ),
    );
    return;
  }
  const list = el(document, "div", "citation-map-relation-list");
  for (const work of works) {
    const card = el(document, "article", "citation-map-relation-card");
    card.append(
      txt(
        document,
        "h4",
        externalWorkTitle(work, Number(item.libraryID)),
        "citation-map-relation-title",
      ),
      txt(
        document,
        "p",
        externalWorkAuthorsText(work),
        "citation-map-secondary-text",
      ),
    );
    const metadata = externalWorkMetadataText(work, undefined);
    if (metadata) {
      card.appendChild(
        txt(document, "p", metadata, "citation-map-secondary-text"),
      );
    }

    const identity = el(document, "div", "citation-map-pane-actions");
    identity.style.justifyContent = "space-between";
    identity.style.width = "100%";
    const url = externalWorkURL(work);
    if (url) {
      const link = el(document, "a");
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
      identity.appendChild(link);
    }

    const buttons = el(document, "div", "citation-map-pane-actions");
    buttons.style.margin = "0";
    if (work.inLibraryItemKey) {
      const local = itemByKey(Number(item.libraryID), work.inLibraryItemKey);
      const show = el(document, "button", "citation-map-primary-button");
      show.type = "button";
      show.textContent = "Show in Zotero";
      show.addEventListener("click", () => {
        if (local) Zotero.getActiveZoteroPane?.()?.selectItem?.(local.id);
      });
      buttons.appendChild(show);
    } else {
      const add = el(document, "button", "citation-map-primary-button");
      add.type = "button";
      add.textContent = "Add to Zotero";
      add.addEventListener("click", () => {
        runUIAction("adding a similar paper", async () => {
          add.disabled = true;
          const imported = await importExternalWork(
            work,
            Number(item.libraryID),
            [],
          );
          const added = imported[0];
          if (!added) throw new Error("No item was imported.");
          work.inLibraryItemKey = String(added.key);
          renderOverviewSimilarResults(document, container, item, works);
        });
      });
      buttons.appendChild(add);
    }
    identity.appendChild(buttons);
    card.appendChild(identity);

    const badges = el(document, "div", "citation-map-pane-badges");
    if (work.inLibraryItemKey)
      badges.append(txt(document, "span", "In Zotero"));
    if (work.isOpenAccess) badges.append(txt(document, "span", "Open Access"));
    if (work.isRetracted) badges.append(txt(document, "span", "Retracted"));
    if (badges.childElementCount) card.appendChild(badges);

    if (work.abstract) {
      const disclosure = el(document, "details", "citation-map-data-details");
      disclosure.append(
        txt(document, "summary", "Abstract"),
        txt(document, "p", work.abstract),
      );
      card.appendChild(disclosure);
    }
    list.appendChild(card);
  }
  container.appendChild(list);
}

function renderOverview(
  document: Document,
  container: HTMLElement,
  item: Zotero.Item,
  rerender: () => void,
): void {
  const node = createMetricNodeForItem(item);
  renderMatchConfirmation(document, container, item, rerender);
  if (node.isRetracted) {
    const warning = el(document, "div", "citation-map-retraction-warning");
    warning.textContent =
      "Retraction reported by a scholarly-data provider. Verify the current status with the publisher.";
    container.appendChild(warning);
  }
  const badges = el(document, "div", "citation-map-pane-badges");
  if (node.isOpenAccess) badges.append(txt(document, "span", "Open Access"));
  if (node.isTop1Percent) badges.append(txt(document, "span", "Top 1%"));
  else if (node.isTop10Percent) badges.append(txt(document, "span", "Top 10%"));
  if (badges.childElementCount) container.appendChild(badges);

  const metrics = el(document, "dl", "citation-map-pane-metrics");
  metrics.append(
    row(document, "Citations", count(node.citationCount)),
    row(document, "References", count(node.referenceCount)),
    row(
      document,
      "Citation rate",
      node.citationVelocity === null
        ? "—"
        : `${formatMetricValue("citation-rate", node.citationVelocity)}/year`,
      getMetricDefinition("citation-rate").description,
    ),
    row(
      document,
      "Citation acceleration",
      formatMetricValue("citation-acceleration", node.citationAcceleration),
      getMetricDefinition("citation-acceleration").description,
    ),
    row(document, "FWCI", formatMetricValue("fwci", node.fwci)),
    row(
      document,
      "Journal h-index",
      formatMetricValue("journal-h-index", node.sourceMetrics?.hIndex ?? null),
      getMetricDefinition("journal-h-index").description,
    ),
    row(
      document,
      "2-year mean citedness",
      formatMetricValue(
        "two-year-mean-citedness",
        node.sourceMetrics?.twoYearMeanCitedness ?? null,
      ),
      getMetricDefinition("two-year-mean-citedness").description,
    ),
    row(
      document,
      "Citation percentile",
      formatMetricValue("citation-percentile", node.citationPercentile),
    ),
    row(
      document,
      "Library coverage",
      formatMetricValue("library-coverage", node.libraryCoverage),
      getMetricDefinition("library-coverage").description,
    ),
  );
  container.appendChild(metrics);

  const details = el(document, "details", "citation-map-data-details");
  details.appendChild(txt(document, "summary", "Data details"));
  const detailMetrics = el(document, "dl", "citation-map-pane-metrics");
  detailMetrics.append(
    row(document, "Canonical provider", node.provider ?? "—"),
    row(document, "Match method", node.matchedBy ?? "—"),
    row(
      document,
      "Structured references",
      `${count(node.resolvedReferenceCount)} of ${count(node.referenceCount)}`,
    ),
    row(
      document,
      "Updated",
      node.metricsUpdatedAt
        ? new Date(node.metricsUpdatedAt).toLocaleString()
        : "—",
    ),
    row(
      document,
      "Local manual relations",
      String(
        getManualRelations(Number(item.libraryID), String(item.key)).length,
      ),
    ),
  );
  details.appendChild(detailMetrics);
  container.appendChild(details);

  void ensureSourceMetricsForNodes([node])
    .then((updated) => {
      if (updated > 0 && container.isConnected) rerender();
    })
    .catch((error: unknown) => {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    });

  const similarResults = el(document, "section");
  similarResults.style.marginTop = "8px";
  const overviewActions = createPaperOverviewActionBar({
    document,
    actionsClass: "citation-map-pane-actions",
    primaryButtonClass: "citation-map-primary-button",
    doi: node.doi,
    onShowInZotero: () =>
      Zotero.getActiveZoteroPane?.()?.selectItem?.(Number(item.id)),
    onSimilar: async () => {
      clear(similarResults);
      similarResults.appendChild(
        txt(
          document,
          "p",
          "Finding similar papers…",
          "citation-map-secondary-text",
        ),
      );
      try {
        const { node: selected, graph } = await graphNodeForItem(item);
        const works = await getMissingPaperRecommendations(
          [selected],
          graph.nodes,
          50,
          2,
        );
        if (similarResults.isConnected) {
          renderOverviewSimilarResults(document, similarResults, item, works);
        }
      } catch (error) {
        if (similarResults.isConnected) {
          clear(similarResults);
          similarResults.appendChild(
            txt(
              document,
              "p",
              "Similar-paper search failed.",
              "citation-map-secondary-text",
            ),
          );
        }
        throw error;
      }
    },
    onRefresh: async () => {
      await updateCitationDataForItems([item], {
        force: true,
        includeRelationships: true,
        progressDocument: document,
      });
      rerender();
    },
  });
  container.append(overviewActions.root, similarResults);
}

function relationKey(work: RelatedWorkMetadata | ExternalWork): string {
  const localKey =
    (work as ExternalWork).inLibraryItemKey ?? work.zoteroItemKey;
  if (localKey) return `zotero:${localKey}`;
  const doi = normalizeDOI(work.doi);
  if (doi) return `doi:${doi}`;
  if (work.providerWorkID) {
    return `${work.provider}:${String(work.providerWorkID).toLocaleLowerCase()}`;
  }
  const title = normalizeExactTitle(work.title);
  return title ? `title:${title}` : `${work.provider}:unknown`;
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

function descriptorFromReference(
  libraryID: number,
  subjectItemKey: string,
  reference: RelatedWorkMetadata,
): IgnoredRelationDescriptor {
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

interface IgnoredRelationDescriptor {
  libraryID: number;
  subjectItemKey: string;
  direction: ManualRelationDirection;
  provider: Exclude<RelatedWorkMetadata["provider"], "manual" | "zotero">;
  providerWorkID: string | null;
  doi: string | null;
  normalizedTitle: string | null;
}

function ignoredRelationDescriptor(
  work: ExternalWork,
  item: Zotero.Item,
  direction: ManualRelationDirection,
): IgnoredRelationDescriptor {
  const libraryID = Number(item.libraryID);
  if (direction === "cited-by" && work.inLibraryItemKey) {
    const target = createMetricNodeForItem(item);
    const sourceRecord = getCitationMetricRecord(
      libraryID,
      work.inLibraryItemKey,
    );
    const reference = sourceRecord?.references.find((candidate) =>
      referenceMatchesNode(candidate, target),
    );
    if (reference) {
      return descriptorFromReference(
        libraryID,
        work.inLibraryItemKey,
        reference,
      );
    }
    return {
      libraryID,
      subjectItemKey: work.inLibraryItemKey,
      direction: "reference",
      provider: target.provider ?? "crossref",
      providerWorkID: target.providerWorkID,
      doi: target.doi,
      normalizedTitle: normalizeExactTitle(target.title) || null,
    };
  }
  if (direction === "reference") {
    const sourceRecord = getCitationMetricRecord(libraryID, String(item.key));
    const reference = sourceRecord?.references.find((candidate) =>
      referenceMatchesExternalWork(candidate, work),
    );
    if (reference) {
      return descriptorFromReference(libraryID, String(item.key), reference);
    }
  }
  return {
    libraryID,
    subjectItemKey: String(item.key),
    direction,
    provider:
      work.provider === "manual" || work.provider === "zotero"
        ? "crossref"
        : work.provider,
    providerWorkID:
      work.provider === "manual" || work.provider === "zotero"
        ? null
        : work.providerWorkID,
    doi: work.doi,
    normalizedTitle: normalizeExactTitle(work.title) || null,
  };
}

function ignoredRelationForWork(
  work: ExternalWork,
  item: Zotero.Item,
  direction: ManualRelationDirection,
): IgnoredProviderRelation | null {
  const descriptor = ignoredRelationDescriptor(work, item, direction);
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

function manualWorkForItemKey(
  libraryID: number,
  relatedItemKey: string,
): ExternalWork | null {
  const related = itemByKey(libraryID, relatedItemKey);
  if (!related) return null;
  const node = createMetricNodeForItem(related);
  return {
    provider: "manual",
    providerWorkID: null,
    doi: node.doi,
    title: node.title,
    year: node.year,
    authors: node.authors,
    sourceTitle: node.sourceTitle,
    abstract: null,
    citationCount: node.citationCount,
    referenceCount: node.referenceCount,
    isOpenAccess: node.isOpenAccess,
    openAccessStatus: node.openAccessStatus,
    isRetracted: node.isRetracted,
    zoteroItemKey: relatedItemKey,
    inLibraryItemKey: relatedItemKey,
  };
}

function manualRelationsForItem(
  item: Zotero.Item,
  direction: ManualRelationDirection,
): Array<{ relation: ManualCitationRelation; relatedItemKey: string }> {
  return manualRelationsForSubject(
    Number(item.libraryID),
    String(item.key),
    direction,
  );
}

interface RelationEntry {
  work: ExternalWork;
  manualRelation: ManualCitationRelation | null;
  ignoredRelation: IgnoredProviderRelation | null;
  providerOrder: number;
}

function relationEntriesForWorks(
  item: Zotero.Item,
  direction: ManualRelationDirection,
  manualRelations: Array<{
    relation: ManualCitationRelation;
    relatedItemKey: string;
  }>,
  providerWorks: ExternalWork[],
): RelationEntry[] {
  const entries: RelationEntry[] = [];
  const seen = new Set<string>();
  for (const { relation, relatedItemKey } of manualRelations) {
    const work = manualWorkForItemKey(Number(item.libraryID), relatedItemKey);
    if (!work) continue;
    const key = relationKey(work);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      work,
      manualRelation: relation,
      ignoredRelation: null,
      providerOrder: entries.length,
    });
  }
  const providerOffset = entries.length;
  for (const [providerOrder, work] of providerWorks.entries()) {
    const key = relationKey(work);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      work,
      manualRelation: null,
      ignoredRelation: ignoredRelationForWork(work, item, direction),
      providerOrder: providerOffset + providerOrder,
    });
  }
  return entries;
}

function renderRelationCard(
  document: Document,
  container: HTMLElement,
  item: Zotero.Item,
  direction: ManualRelationDirection,
  work: ExternalWork,
  manualRelation: ManualCitationRelation | null,
  ignoredRelation: IgnoredProviderRelation | null,
  rerender: () => void,
): void {
  let activeIgnoredRelation = ignoredRelation;
  let ignoredBadge: HTMLElement | null = null;
  let syncIgnoredControls = (): void => undefined;
  const card = el(document, "article", "citation-map-relation-card");
  card.dataset.key = relationKey(work);
  const title = txt(
    document,
    "h4",
    externalWorkTitle(work, Number(item.libraryID)),
    "citation-map-relation-title",
  );
  if (manualRelation) {
    title.classList.add("citation-map-manual-relation-title");
    title.title =
      direction === "reference"
        ? "Reference added manually in Citation Map"
        : "Citing paper added manually in Citation Map";
  }
  card.appendChild(title);
  card.appendChild(
    txt(
      document,
      "p",
      externalWorkAuthorsText(work),
      "citation-map-secondary-text",
    ),
  );
  const metadata = externalWorkMetadataText(work, undefined);
  if (metadata) {
    card.appendChild(
      txt(document, "p", metadata, "citation-map-secondary-text"),
    );
  }

  const identityRow = el(document, "div", "citation-map-pane-actions");
  identityRow.style.justifyContent = "space-between";
  identityRow.style.width = "100%";
  const url = externalWorkURL(work);
  if (url) {
    const link = el(document, "a");
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
    identityRow.appendChild(txt(document, "span", "No DOI or URL"));
  }

  const actionButtons = el(document, "div", "citation-map-pane-actions");
  actionButtons.style.margin = "0";
  if (work.inLibraryItemKey) {
    const related = itemByKey(Number(item.libraryID), work.inLibraryItemKey);
    const show = el(document, "button", "citation-map-primary-button");
    show.type = "button";
    show.textContent = "Show in Zotero";
    show.addEventListener("click", () => {
      if (related) Zotero.getActiveZoteroPane?.()?.selectItem?.(related.id);
    });
    actionButtons.appendChild(show);
  } else {
    const add = el(document, "button", "citation-map-primary-button");
    add.type = "button";
    add.textContent = "Add to Zotero";
    add.addEventListener("click", () => {
      runUIAction("adding an external relationship paper", async () => {
        add.disabled = true;
        add.textContent = "Adding…";
        const imported = await importExternalWork(
          work,
          Number(item.libraryID),
          [],
        );
        const added = imported[0];
        if (!added) throw new Error("No item was imported.");
        work.inLibraryItemKey = String(added.key);
        rerender();
      });
    });
    actionButtons.appendChild(add);
  }

  if (manualRelation) {
    const removeManual = el(document, "button");
    removeManual.type = "button";
    removeManual.textContent = "Remove manual relation";
    removeManual.addEventListener("click", () => {
      runUIAction("removing a manual citation relation", async () => {
        removeManual.disabled = true;
        await removeManualRelation(manualRelation.id);
        await refreshOpenCitationMapViews();
        rerender();
      });
    });
    actionButtons.appendChild(removeManual);
  } else if (work.provider !== "manual") {
    const toggleIgnored = el(document, "button");
    toggleIgnored.type = "button";
    syncIgnoredControls = (): void => {
      toggleIgnored.textContent = activeIgnoredRelation
        ? "Restore relationship"
        : "Mark incorrect";
      toggleIgnored.title = activeIgnoredRelation
        ? "Restore this relationship to the citation graph"
        : "Hide only this relationship edge from the citation graph";
      if (activeIgnoredRelation && !ignoredBadge) {
        ignoredBadge = txt(document, "span", "Ignored Relationship");
        badges.appendChild(ignoredBadge);
        if (!badges.parentElement) card.appendChild(badges);
      } else if (!activeIgnoredRelation && ignoredBadge) {
        ignoredBadge.remove();
        ignoredBadge = null;
        if (!badges.childElementCount) badges.remove();
      }
    };
    toggleIgnored.addEventListener("click", () => {
      runUIAction("updating an ignored citation relation", async () => {
        toggleIgnored.disabled = true;
        try {
          if (activeIgnoredRelation) {
            await removeIgnoredRelation(activeIgnoredRelation.id);
            activeIgnoredRelation = null;
          } else {
            const descriptor = ignoredRelationDescriptor(work, item, direction);
            await ignoreProviderRelation({
              ...descriptor,
              providerWorkID: descriptor.providerWorkID ?? "",
              doi: descriptor.doi ?? "",
              normalizedTitle: descriptor.normalizedTitle ?? "",
            });
            activeIgnoredRelation = ignoredRelationForWork(
              work,
              item,
              direction,
            );
          }
          syncIgnoredControls();
          notifyRelationshipMutation({
            origin: "item-pane",
            libraryID: Number(item.libraryID),
            subjectItemKey: String(item.key),
            direction: direction === "reference" ? "references" : "cited-by",
            work,
            ignored: Boolean(activeIgnoredRelation),
          });
        } finally {
          toggleIgnored.disabled = false;
        }
      });
    });
    actionButtons.appendChild(toggleIgnored);
  }
  identityRow.appendChild(actionButtons);
  card.appendChild(identityRow);

  const badges = el(document, "div", "citation-map-pane-badges");
  if (manualRelation) badges.append(txt(document, "span", "Manual"));
  if (work.inLibraryItemKey) badges.append(txt(document, "span", "In Zotero"));
  if (work.isOpenAccess) badges.append(txt(document, "span", "Open Access"));
  if (activeIgnoredRelation) {
    ignoredBadge = txt(document, "span", "Ignored Relationship");
    badges.append(ignoredBadge);
  }
  if (work.isRetracted) {
    badges.append(
      txt(document, "span", "Retracted", "citation-map-danger-badge"),
    );
  }
  if (badges.childElementCount) card.appendChild(badges);
  syncIgnoredControls();

  if (work.abstract) {
    const disclosure = el(document, "details", "citation-map-data-details");
    disclosure.append(
      txt(document, "summary", "Abstract"),
      txt(document, "p", work.abstract, "citation-map-secondary-text"),
    );
    card.appendChild(disclosure);
  }
  container.appendChild(card);
}

async function renderRelations(
  document: Document,
  container: HTMLElement,
  item: Zotero.Item,
  direction: ManualRelationDirection,
  rerender: () => void,
): Promise<void> {
  clear(container);
  const viewDirection: RelationshipViewDirection =
    direction === "reference" ? "references" : "cited-by";
  const updateLabel =
    viewDirection === "references"
      ? "Update reference papers"
      : "Update citing papers";

  const loading = txt(document, "p", "Loading…", "citation-map-secondary-text");
  container.appendChild(loading);
  try {
    const { node, graph, snapshot } = await graphNodeForItem(item);
    const libraryID = Number(item.libraryID);
    const localPapersByKey = new Map(
      snapshot.papers.map((paper) => [paper.itemKey, paper]),
    );
    let relationshipSnapshot: RelationshipViewSnapshot =
      getRelationshipViewSnapshot(
        graph,
        node,
        viewDirection,
        libraryID,
        RELATION_LIMIT,
      );
    let providerWorks = relationshipSnapshot.works;
    let manualRelations = manualRelationsForItem(item, direction);
    let entries = relationEntriesForWorks(
      item,
      direction,
      manualRelations,
      providerWorks,
    );
    let providerLookupActive = false;
    let updateOutcome: string | null = null;
    let shownCount = entries.length;
    let filtered = false;
    let renderGeneration = 0;
    let renderList = (): void => undefined;
    let updateStatus = (): void => undefined;
    loading.remove();

    const controls = el(document, "div", "citation-map-relation-controls");
    controls.style.gridTemplateColumns = "minmax(0, 1fr) 30px 30px";
    const toolbar = createPaperListToolbar({
      document,
      searchPlaceholder:
        direction === "reference"
          ? "Search references"
          : "Search citing papers",
      collections: snapshot.collections,
      inputClassName: "citation-map-paper-search",
      onChange: () => renderList(),
    });

    const update = el(document, "button");
    update.type = "button";
    configureIconButton(update, updateLabel, "refresh");

    const currentRelatedItemKeys = (): Set<string> =>
      new Set(
        entries
          .map(
            ({ work }) => work.inLibraryItemKey ?? work.zoteroItemKey ?? null,
          )
          .filter((key): key is string => Boolean(key)),
      );
    const picker = createManualRelationshipPicker({
      document,
      snapshot,
      subjectItemKey: String(item.key),
      direction,
      getAlreadyRelatedItemKeys: currentRelatedItemKeys,
      inputClassName: "citation-map-paper-search",
      onApplied: () => rerender(),
    });

    controls.append(toolbar.root, update, picker.button);
    container.append(controls, picker.overlay);

    const status = txt(document, "p", "", "citation-map-secondary-text");
    updateStatus = (): void => {
      const base = relationshipStatusText(
        relationshipSnapshot,
        shownCount,
        filtered,
        providerLookupActive,
      );
      status.textContent = updateOutcome ? `${base} · ${updateOutcome}` : base;
    };
    const list = el(document, "div", "citation-map-relation-list");
    container.append(status, list);

    renderList = (): void => {
      const generation = ++renderGeneration;
      clear(list);
      const ordered = toolbar.apply(entries, (entry) =>
        describeExternalWork(
          entry.work,
          libraryID,
          true,
          Boolean(entry.manualRelation),
          localPapersByKey,
        ),
      );
      shownCount = ordered.length;
      filtered = toolbar.hasActiveQueryOrFilters();
      updateStatus();
      if (!ordered.length) {
        list.append(txt(document, "p", "No relationships are available."));
        return;
      }

      let index = 0;
      const appendNextBatch = (): void => {
        if (generation !== renderGeneration || !list.isConnected) return;
        for (const entry of ordered.slice(index, index + 75)) {
          renderRelationCard(
            document,
            list,
            item,
            direction,
            entry.work,
            entry.manualRelation,
            entry.ignoredRelation,
            rerender,
          );
        }
        index += 75;
        if (index < ordered.length) {
          const view = document.defaultView;
          if (view) view.requestAnimationFrame(appendNextBatch);
          else setTimeout(appendNextBatch, 0);
        }
      };
      appendNextBatch();
    };

    update.addEventListener("click", () => {
      runUIAction("updating " + direction + " relationships", async () => {
        update.disabled = true;
        providerLookupActive = true;
        updateOutcome = null;
        updateStatus();
        const progress = createUpdateProgress({
          document,
          title: updateLabel,
          message: "Checking provider pages for new relationships…",
        });
        const previousWorks = providerWorks;
        try {
          await refreshExternalRelationships(
            node,
            graph.nodes,
            viewDirection,
            RELATIONSHIP_VIEW_LIMIT,
          );
          relationshipSnapshot = getRelationshipViewSnapshot(
            graph,
            node,
            viewDirection,
            libraryID,
            RELATION_LIMIT,
          );
          providerWorks = relationshipSnapshot.works;
          const added = newlyRetrievedRelationshipWorkCount(
            previousWorks,
            providerWorks,
          );
          updateOutcome = added
            ? `${added} new paper${added === 1 ? "" : "s"} added`
            : "No new papers returned";
          progress.finish(updateOutcome);
          manualRelations = manualRelationsForItem(item, direction);
          entries = relationEntriesForWorks(
            item,
            direction,
            manualRelations,
            providerWorks,
          );
        } catch (error) {
          updateOutcome = "Update failed";
          progress.fail(updateOutcome);
          throw error;
        } finally {
          providerLookupActive = false;
          update.disabled = false;
          renderList();
        }
      });
    });
    renderList();
  } catch (error) {
    loading.textContent = "Unable to load relationships.";
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
}

function renderPane(
  document: Document,
  body: HTMLElement,
  item: Zotero.Item,
  setSectionSummary?: (summary: string) => void,
): void {
  const itemKey = String(item.key);
  const previousState = paneTabState.get(body);
  let active: PaneTab =
    previousState?.itemKey === itemKey ? previousState.active : "overview";
  paneTabState.set(body, { itemKey, active });
  const render = (): void => {
    setSectionSummary?.(summaryForItem(item));
    clear(body);
    const shell = el(document, "div", "citation-map-item-pane");
    const content = el(document, "div", "citation-map-pane-content");
    const select = (tab: PaneTab): void => {
      active = tab;
      paneTabState.set(body, { itemKey, active });
      render();
    };
    const node = createMetricNodeForItem(item);
    const reportedCounts = getRelationshipReportedCounts(
      Number(item.libraryID),
      node,
    );
    shell.append(
      createTabs(
        document,
        active,
        reportedCounts.citationCount,
        reportedCounts.referenceCount,
        select,
      ),
      content,
    );
    body.appendChild(shell);
    if (active === "overview") {
      renderOverview(document, content, item, render);
    } else {
      void renderRelations(
        document,
        content,
        item,
        active === "references" ? "reference" : "cited-by",
        render,
      );
    }
  };
  render();
}

function renderPaneForItem(
  document: Document,
  body: HTMLElement,
  item: Zotero.Item,
  setEnabled: ((enabled: boolean) => void) | null,
  setSectionSummary: (summary: string) => void,
): void {
  const subject = paneSubjectItem(item);
  setEnabled?.(Boolean(subject));
  if (!subject) {
    clear(body);
    return;
  }
  renderPane(document, body, subject, setSectionSummary);
}

export function registerCitationItemPane(): void {
  if (registeredPaneID) return;
  const manager = (Zotero as any).ItemPaneManager;
  if (!manager?.registerSection) {
    Zotero.debug("Citation Map: Zotero ItemPaneManager is unavailable.");
    return;
  }
  registeredPaneID = manager.registerSection({
    paneID: PANE_ID,
    pluginID: config.addonID,
    header: {
      l10nID: "citation-map-item-pane-header",
      icon: `chrome://${config.addonRef}/content/icons/network.svg`,
    },
    sidenav: {
      l10nID: "citation-map-item-pane-sidenav",
      icon: `chrome://${config.addonRef}/content/icons/network.svg`,
    },
    onInit: ({
      body,
      refresh,
    }: {
      body: HTMLElement;
      refresh: () => Promise<void>;
    }) => {
      refreshCallbacks.set(body, refresh);
    },
    onDestroy: ({ body }: { body: HTMLElement }) => {
      refreshCallbacks.delete(body);
      paneTabState.delete(body);
    },
    onItemChange: ({
      doc,
      body,
      item,
      setEnabled,
      setSectionSummary,
    }: {
      doc: Document;
      body: HTMLElement;
      item: Zotero.Item;
      setEnabled: (enabled: boolean) => void;
      setSectionSummary: (summary: string) => void;
    }) => {
      renderPaneForItem(doc, body, item, setEnabled, setSectionSummary);
    },
    onRender: ({
      doc,
      body,
      item,
      setSectionSummary,
    }: {
      doc: Document;
      body: HTMLElement;
      item: Zotero.Item;
      setSectionSummary: (summary: string) => void;
    }) => {
      renderPaneForItem(doc, body, item, null, setSectionSummary);
    },
  });
  unsubscribeRelationshipMutations ??= subscribeRelationshipMutations(
    (event) => {
      if (event.origin === "item-pane") return;
      refreshCitationItemPanes();
    },
  );
}

export function refreshCitationItemPanes(): void {
  for (const refresh of refreshCallbacks.values()) {
    void refresh().catch((error) =>
      Zotero.debug(`Citation Map: item-pane refresh failed: ${String(error)}`),
    );
  }
}

export function unregisterCitationItemPane(): void {
  if (typeof registeredPaneID === "string") {
    try {
      (Zotero as any).ItemPaneManager?.unregisterSection?.(registeredPaneID);
    } catch (error) {
      Zotero.debug(`Citation Map: item pane cleanup failed: ${String(error)}`);
    }
  }
  registeredPaneID = null;
  unsubscribeRelationshipMutations?.();
  unsubscribeRelationshipMutations = null;
  refreshCallbacks.clear();
}
