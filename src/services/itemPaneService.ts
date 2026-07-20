import { config, version } from "../../package.json";
import type {
  ManualCitationRelation,
  ManualRelationDirection,
  RelatedWorkMetadata,
} from "../domain/citationTypes";
import type {
  CitationGraphModel,
  CitationGraphNode,
} from "../domain/graphTypes";
import {
  getCachedExternalCitedBy,
  getCachedExternalReferences,
  getExternalCitedBy,
  getExternalReferences,
  hydrateExternalWorksMetadata,
  type ExternalWork,
} from "./externalDiscoveryService";
import {
  addManualRelation,
  confirmCitationMatch,
  confirmCitationMatchCandidate,
  getCitationMetricRecord,
  getCitationMetricRecords,
  getIgnoredRelations,
  getManualRelations,
  ignoreProviderRelation,
  removeIgnoredRelation,
  removeManualRelation,
} from "./citationMetricsStore";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";
import { createMetricNodeForItem } from "./itemMetricContext";
import { formatMetricValue, getMetricDefinition } from "./metricRegistry";
import { updateCitationDataForItems } from "./citationUpdateService";
import { buildCitationGraph } from "./citationGraphService";
import { ensureSourceMetricsForNodes } from "./sourceMetricsService";
import { openCitationMapAndSelectItem } from "./windowService";
import { loadWholeLibrary } from "./zoteroLibraryService";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const PANE_ID = "citation-map-item-pane";
const RELATION_LIMIT = 100;
let registeredPaneID: string | false | null = null;
const refreshCallbacks = new Map<Element, () => Promise<void>>();

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

function externalWorkTitle(work: RelatedWorkMetadata): string {
  return (
    work.title?.trim() ||
    work.doi?.trim() ||
    work.providerWorkID?.trim() ||
    "Untitled work"
  );
}

function relationSearchText(work: RelatedWorkMetadata): string {
  return [
    externalWorkTitle(work),
    work.authors.join(" "),
    work.sourceTitle ?? "",
    work.doi ?? "",
    work.providerWorkID ?? "",
    work.year ?? "",
  ]
    .join(" ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
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

function itemLabel(item: Zotero.Item): string {
  const creator = String(item.getField?.("firstCreator") ?? "").trim();
  const date = String(item.getField?.("date") ?? "").match(/\b\d{4}\b/)?.[0];
  return [String(item.getField?.("title") ?? "Untitled"), creator, date]
    .filter(Boolean)
    .join(" · ");
}

async function graphNodeForItem(item: Zotero.Item): Promise<{
  node: CitationGraphNode;
  graph: CitationGraphModel;
}> {
  const snapshot = await loadWholeLibrary(Number(item.libraryID));
  const graph = buildCitationGraph(snapshot);
  const node =
    graph.nodes.find((candidate) => candidate.itemKey === String(item.key)) ??
    createMetricNodeForItem(item);
  return { node, graph };
}

function graphRelationWorks(
  graph: CitationGraphModel,
  node: CitationGraphNode,
  direction: ManualRelationDirection,
): ExternalWork[] {
  // The graph is already the authoritative resolved view used by the graph
  // window. Mirror every visible graph edge here, including manual edges.
  // Manual edges are deduplicated later against the richer manual-relation
  // records, so excluding them here can incorrectly leave the pane empty.
  const subjectKeys = new Set([node.key, node.itemKey]);
  const relatedKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (direction === "reference" && subjectKeys.has(edge.source)) {
      relatedKeys.add(edge.target);
    } else if (direction === "cited-by" && subjectKeys.has(edge.target)) {
      relatedKeys.add(edge.source);
    }
  }

  const nodeByKey = new Map<string, CitationGraphNode>();
  for (const candidate of graph.nodes) {
    nodeByKey.set(candidate.key, candidate);
    nodeByKey.set(candidate.itemKey, candidate);
  }

  const works: ExternalWork[] = [];
  for (const relatedKey of relatedKeys) {
    const related = nodeByKey.get(relatedKey);
    if (!related) continue;
    works.push({
      provider: "zotero",
      providerWorkID: related.itemKey,
      doi: related.doi,
      title: related.title,
      year: related.year,
      authors: related.authors,
      sourceTitle: related.sourceTitle,
      abstract: related.abstract,
      citationCount: related.citationCount,
      referenceCount: related.referenceCount,
      isOpenAccess: related.isOpenAccess,
      openAccessStatus: related.openAccessStatus,
      isRetracted: related.isRetracted,
      zoteroItemKey: related.itemKey,
      inLibraryItemKey: related.itemKey,
    });
  }
  return works;
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

function graphNodeAsExternalWork(node: CitationGraphNode): ExternalWork {
  return {
    provider: "zotero",
    providerWorkID: node.itemKey,
    doi: node.doi,
    title: node.title,
    year: node.year,
    authors: node.authors,
    sourceTitle: node.sourceTitle,
    abstract: node.abstract,
    citationCount: node.citationCount,
    referenceCount: node.referenceCount,
    isOpenAccess: node.isOpenAccess,
    openAccessStatus: node.openAccessStatus,
    isRetracted: node.isRetracted,
    zoteroItemKey: node.itemKey,
    inLibraryItemKey: node.itemKey,
  };
}

function storedRelationWorks(
  graph: CitationGraphModel,
  node: CitationGraphNode,
  direction: ManualRelationDirection,
  libraryID: number,
): ExternalWork[] {
  const records = getCitationMetricRecords(libraryID);
  const nodeByKey = new Map(
    graph.nodes.map((candidate) => [candidate.itemKey, candidate]),
  );

  if (direction === "cited-by") {
    const works: ExternalWork[] = [];
    const seen = new Set<string>();
    const addNode = (candidate: CitationGraphNode): void => {
      if (candidate.itemKey === node.itemKey || seen.has(candidate.itemKey)) {
        return;
      }
      seen.add(candidate.itemKey);
      works.push(graphNodeAsExternalWork(candidate));
    };

    // Prefer the graph nodes because they are the exact records already used
    // by the graph window, including data loaded after the database snapshot.
    for (const candidate of graph.nodes) {
      if (
        candidate.references.some((reference) =>
          referenceMatchesNode(reference, node),
        )
      ) {
        addNode(candidate);
      }
    }

    // Also scan persisted records in case the graph was built before a recent
    // relationship refresh.
    for (const record of records) {
      if (
        record.itemKey === node.itemKey ||
        !record.references.some((reference) =>
          referenceMatchesNode(reference, node),
        )
      ) {
        continue;
      }
      const graphNode = nodeByKey.get(record.itemKey);
      if (graphNode) {
        addNode(graphNode);
        continue;
      }
      const item = itemByKey(libraryID, record.itemKey);
      if (item) addNode(createMetricNodeForItem(item));
    }
    return works;
  }

  const record = getCitationMetricRecord(libraryID, node.itemKey);
  const references = record?.references.length
    ? record.references
    : node.references;
  const byDOI = new Map<string, CitationGraphNode>();
  const byTitle = new Map<string, CitationGraphNode>();
  const byProviderIdentity = new Map<string, CitationGraphNode>();
  for (const candidate of graph.nodes) {
    const doi = normalizeDOI(candidate.doi);
    const title = normalizeExactTitle(candidate.title);
    if (doi && !byDOI.has(doi)) byDOI.set(doi, candidate);
    if (title && !byTitle.has(title)) byTitle.set(title, candidate);
    if (candidate.provider && candidate.providerWorkID) {
      byProviderIdentity.set(
        `${candidate.provider}:${String(candidate.providerWorkID).toLocaleLowerCase()}`,
        candidate,
      );
    }
  }

  return references.map((reference) => {
    const doi = normalizeDOI(reference.doi);
    const title = normalizeExactTitle(reference.title);
    const identity = reference.providerWorkID
      ? `${reference.provider}:${String(reference.providerWorkID).toLocaleLowerCase()}`
      : null;
    const local =
      (reference.zoteroItemKey
        ? nodeByKey.get(reference.zoteroItemKey)
        : null) ??
      (doi ? byDOI.get(doi) : null) ??
      (identity ? byProviderIdentity.get(identity) : null) ??
      (title ? byTitle.get(title) : null) ??
      null;
    return {
      ...reference,
      zoteroItemKey: local?.itemKey ?? reference.zoteroItemKey ?? null,
      inLibraryItemKey: local?.itemKey ?? reference.zoteroItemKey ?? null,
    };
  });
}

function mergeRelationWorks(...groups: ExternalWork[][]): ExternalWork[] {
  const merged = new Map<string, ExternalWork>();
  for (const group of groups) {
    for (const work of group) {
      const key = relationKey(work);
      const previous = merged.get(key);
      if (!previous) {
        merged.set(key, work);
        continue;
      }
      merged.set(key, {
        ...previous,
        ...work,
        providerWorkID: previous.providerWorkID ?? work.providerWorkID,
        doi: previous.doi ?? work.doi,
        title: previous.title?.trim() ? previous.title : work.title,
        year: previous.year ?? work.year,
        authors: previous.authors.length ? previous.authors : work.authors,
        sourceTitle: previous.sourceTitle ?? work.sourceTitle,
        abstract: previous.abstract ?? work.abstract,
        citationCount: previous.citationCount ?? work.citationCount,
        referenceCount: previous.referenceCount ?? work.referenceCount,
        zoteroItemKey: previous.zoteroItemKey ?? work.zoteroItemKey,
        inLibraryItemKey:
          previous.inLibraryItemKey ?? work.inLibraryItemKey ?? null,
      });
    }
  }
  return [...merged.values()];
}

function createTabs(
  document: Document,
  active: "overview" | "cited-by" | "references",
  onSelect: (tab: "overview" | "cited-by" | "references") => void,
): HTMLDivElement {
  const tabs = el(document, "div", "citation-map-pane-tabs");
  for (const [id, label] of [
    ["overview", "Overview"],
    ["cited-by", "Cited by"],
    ["references", "References"],
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
    row(document, "Matched by", node.matchedBy ?? "—"),
    row(
      document,
      "Match confidence",
      formatMetricValue("match-confidence", node.matchConfidence),
    ),
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

  const actions = el(document, "div", "citation-map-pane-actions");
  const refresh = el(document, "button", "citation-map-primary-button");
  refresh.type = "button";
  refresh.textContent = "Refresh";
  refresh.addEventListener("click", () => {
    runUIAction("refreshing item citation data", async () => {
      refresh.disabled = true;
      await updateCitationDataForItems([item], { force: true });
      rerender();
    });
  });
  const map = el(document, "button");
  map.type = "button";
  map.textContent = "Show in Citation Map";
  map.addEventListener(
    "click",
    () => void openCitationMapAndSelectItem(Number(item.id)),
  );
  actions.append(refresh, map);
  container.appendChild(actions);
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

function ignored(
  work: RelatedWorkMetadata,
  item: Zotero.Item,
  direction: ManualRelationDirection,
): boolean {
  const normalizedTitle = String(work.title ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  return getIgnoredRelations(Number(item.libraryID), String(item.key)).some(
    (entry) =>
      entry.direction === direction &&
      entry.provider === work.provider &&
      ((entry.providerWorkID && entry.providerWorkID === work.providerWorkID) ||
        (entry.doi && entry.doi === work.doi) ||
        (entry.normalizedTitle && entry.normalizedTitle === normalizedTitle)),
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
  const itemKey = String(item.key);
  const relations = getManualRelations(Number(item.libraryID));
  const output: Array<{
    relation: ManualCitationRelation;
    relatedItemKey: string;
  }> = [];
  for (const relation of relations) {
    if (relation.direction === "reference") {
      if (direction === "reference" && relation.subjectItemKey === itemKey) {
        output.push({ relation, relatedItemKey: relation.relatedItemKey });
      } else if (
        direction === "cited-by" &&
        relation.relatedItemKey === itemKey
      ) {
        output.push({ relation, relatedItemKey: relation.subjectItemKey });
      }
    } else if (relation.direction === "cited-by") {
      if (direction === "cited-by" && relation.subjectItemKey === itemKey) {
        output.push({ relation, relatedItemKey: relation.relatedItemKey });
      } else if (
        direction === "reference" &&
        relation.relatedItemKey === itemKey
      ) {
        output.push({ relation, relatedItemKey: relation.subjectItemKey });
      }
    }
  }
  return output;
}

interface RelationEntry {
  work: ExternalWork;
  manualRelation: ManualCitationRelation | null;
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
      providerOrder: entries.length,
    });
  }
  const providerOffset = entries.length;
  for (const [providerOrder, work] of providerWorks.entries()) {
    if (ignored(work, item, direction)) continue;
    const key = relationKey(work);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      work,
      manualRelation: null,
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
  rerender: () => void,
): void {
  const card = el(document, "article", "citation-map-relation-card");
  card.dataset.key = relationKey(work);
  const title = txt(
    document,
    "h4",
    externalWorkTitle(work),
    "citation-map-relation-title",
  );
  if (manualRelation) {
    title.classList.add("citation-map-manual-relation-title");
    title.title =
      direction === "reference"
        ? "Reference added manually in Citation Map"
        : "Citing paper added manually in Citation Map";
  }
  card.append(
    title,
    txt(
      document,
      "p",
      [
        work.authors.slice(0, 3).join(", "),
        work.sourceTitle,
        work.year,
        work.citationCount === null || work.citationCount === undefined
          ? ""
          : `${count(work.citationCount)} citations`,
      ]
        .filter(Boolean)
        .join(" · "),
      "citation-map-secondary-text",
    ),
  );
  const badges = el(document, "div", "citation-map-pane-badges");
  if (manualRelation) badges.append(txt(document, "span", "Manual"));
  if (work.inLibraryItemKey) badges.append(txt(document, "span", "In Zotero"));
  if (work.isRetracted)
    badges.append(
      txt(document, "span", "Retracted", "citation-map-danger-badge"),
    );
  if (badges.childElementCount) card.appendChild(badges);
  const actions = el(document, "div", "citation-map-pane-actions");
  if (work.inLibraryItemKey) {
    const related = itemByKey(Number(item.libraryID), work.inLibraryItemKey);
    const show = el(document, "button");
    show.type = "button";
    show.textContent = "Show in Zotero";
    show.addEventListener("click", () => {
      if (related) Zotero.getActiveZoteroPane?.()?.selectItem?.(related.id);
    });
    actions.appendChild(show);
  } else if (work.doi) {
    const doi = el(document, "button");
    doi.type = "button";
    doi.textContent = "Open DOI";
    doi.addEventListener("click", () =>
      Zotero.launchURL(`https://doi.org/${encodeURIComponent(work.doi ?? "")}`),
    );
    actions.appendChild(doi);
  }
  if (manualRelation || work.provider !== "zotero") {
    const remove = el(document, "button");
    remove.type = "button";
    remove.textContent = manualRelation
      ? "Remove manual relation"
      : "Mark incorrect";
    remove.addEventListener("click", () => {
      runUIAction("removing a citation relation", async () => {
        remove.disabled = true;
        if (manualRelation) {
          await removeManualRelation(manualRelation.id);
        } else {
          const normalizedTitle = normalizeExactTitle(work.title);
          await ignoreProviderRelation({
            libraryID: Number(item.libraryID),
            subjectItemKey: String(item.key),
            direction,
            provider:
              work.provider === "manual" || work.provider === "zotero"
                ? "crossref"
                : work.provider,
            providerWorkID: work.providerWorkID,
            doi: work.doi,
            normalizedTitle: normalizedTitle || null,
          });
        }
        rerender();
      });
    });
    actions.appendChild(remove);
  }
  card.appendChild(actions);
  container.appendChild(card);
}

function createManualRelationDialog(
  document: Document,
  item: Zotero.Item,
  direction: ManualRelationDirection,
  onAdded: () => void,
): { button: HTMLButtonElement; overlay: HTMLDivElement } {
  const button = el(
    document,
    "button",
    "citation-map-add-relation-button citation-map-primary-button",
  );
  button.type = "button";
  button.textContent = "+";
  const actionLabel =
    direction === "reference" ? "Add reference" : "Add citing paper";
  button.title = actionLabel;
  button.setAttribute("aria-label", actionLabel);

  const overlay = el(document, "div", "citation-map-relation-dialog-overlay");
  overlay.hidden = true;
  const dialog = el(document, "section", "citation-map-relation-dialog");
  const header = el(document, "header", "citation-map-relation-dialog-header");
  header.appendChild(txt(document, "strong", actionLabel));
  const close = el(document, "button", "citation-map-dialog-close");
  close.type = "button";
  close.textContent = "×";
  header.appendChild(close);
  const input = el(document, "input");
  input.type = "search";
  input.placeholder = "Search this Zotero library";
  const results = el(document, "div", "citation-map-local-results");
  const closeDialog = (): void => {
    overlay.hidden = true;
    button.focus();
  };
  const search = async (): Promise<void> => {
    clear(results);
    const query = input.value.trim().toLocaleLowerCase();
    if (!query) {
      results.append(txt(document, "p", "Enter a title, author, DOI or year."));
      return;
    }
    const items = (await Zotero.Items.getAll(
      Number(item.libraryID),
    )) as Zotero.Item[];
    const matches = items
      .filter(
        (candidate) =>
          candidate.isRegularItem?.() &&
          !candidate.deleted &&
          candidate.id !== item.id,
      )
      .filter((candidate) =>
        [
          candidate.getField?.("title"),
          candidate.getField?.("firstCreator"),
          candidate.getField?.("DOI"),
          candidate.getField?.("date"),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query),
      )
      .slice(0, 30);
    for (const candidate of matches) {
      const result = el(document, "button", "citation-map-local-result");
      result.type = "button";
      result.textContent = itemLabel(candidate);
      result.addEventListener("click", () => {
        runUIAction("adding a manual citation relation", async () => {
          result.disabled = true;
          await addManualRelation(
            Number(item.libraryID),
            String(item.key),
            String(candidate.key),
            direction,
          );
          closeDialog();
          onAdded();
        });
      });
      results.appendChild(result);
    }
    if (!matches.length)
      results.append(txt(document, "p", "No matching Zotero items."));
  };
  let timer: number | null = null;
  input.addEventListener("input", () => {
    if (timer !== null) document.defaultView?.clearTimeout(timer);
    timer =
      document.defaultView?.setTimeout(() => {
        timer = null;
        void search();
      }, 160) ?? null;
  });
  button.addEventListener("click", () => {
    overlay.hidden = false;
    input.focus();
  });
  close.addEventListener("click", closeDialog);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeDialog();
  });
  dialog.append(
    header,
    txt(
      document,
      "p",
      "Select an existing Zotero item. Citation Map stores a local relation without changing the provider aggregate count.",
      "citation-map-secondary-text",
    ),
    input,
    results,
  );
  overlay.appendChild(dialog);
  return { button, overlay };
}

async function renderRelations(
  document: Document,
  container: HTMLElement,
  item: Zotero.Item,
  direction: ManualRelationDirection,
  rerender: () => void,
): Promise<void> {
  clear(container);
  const controls = el(document, "div", "citation-map-relation-controls");
  const search = el(document, "input");
  search.type = "search";
  search.placeholder =
    direction === "reference" ? "Search references" : "Search citing papers";
  const sort = el(document, "select");
  for (const [value, label] of [
    ["provider", "Provider order"],
    ["recent", "Newest first"],
    ["oldest", "Oldest first"],
    ["cited", "Most cited"],
    ["title", "Title"],
    ["library", "In Zotero first"],
  ]) {
    const option = el(document, "option");
    option.value = value;
    option.textContent = label;
    sort.appendChild(option);
  }
  const adder = createManualRelationDialog(document, item, direction, rerender);
  controls.append(search, sort, adder.button);
  container.append(controls, adder.overlay);
  const loading = txt(document, "p", "Loading…", "citation-map-secondary-text");
  container.appendChild(loading);
  try {
    let { node, graph } = await graphNodeForItem(item);
    const loadCachedWorks = (): ExternalWork[] => {
      const storedWorks = storedRelationWorks(
        graph,
        node,
        direction,
        Number(item.libraryID),
      );
      const localGraphWorks = graphRelationWorks(graph, node, direction);
      const cachedProviderWorks =
        direction === "reference"
          ? getCachedExternalReferences(node, graph.nodes, RELATION_LIMIT, 0)
          : getCachedExternalCitedBy(node, graph.nodes, RELATION_LIMIT, 0);
      return mergeRelationWorks(
        storedWorks,
        cachedProviderWorks,
        localGraphWorks,
      );
    };
    const loadProviderWorks = async (
      currentWorks: ExternalWork[],
    ): Promise<ExternalWork[]> => {
      const localGraphWorks = graphRelationWorks(graph, node, direction);
      let providerWorks: ExternalWork[] = [];
      try {
        providerWorks =
          direction === "reference"
            ? await getExternalReferences(node, graph.nodes, RELATION_LIMIT)
            : await getExternalCitedBy(node, graph.nodes, RELATION_LIMIT);
      } catch (error) {
        Zotero.debug(
          `Citation Map: item-pane ${direction} lookup failed: ${String(error)}`,
        );
      }
      Zotero.debug(
        `Citation Map ${version}: item-pane ${direction} relations: ` +
          `graph=${localGraphWorks.length}, cached=${currentWorks.length}, ` +
          `provider=${providerWorks.length}`,
      );
      return mergeRelationWorks(currentWorks, providerWorks, localGraphWorks);
    };

    let providerWorks = loadCachedWorks();
    const expectedRelationshipCount =
      direction === "reference"
        ? (node.referenceCount ?? 0)
        : (node.citationCount ?? 0);
    const relationshipCountKnown =
      direction === "reference"
        ? node.referenceCount !== null
        : node.citationCount !== null;
    const manualRelations = manualRelationsForItem(item, direction);
    loading.remove();
    let entries = relationEntriesForWorks(
      item,
      direction,
      manualRelations,
      providerWorks,
    );
    let providerLookupActive =
      !relationshipCountKnown ||
      providerWorks.length < expectedRelationshipCount;
    const status = txt(document, "p", "", "citation-map-secondary-text");
    const list = el(document, "div", "citation-map-relation-list");
    const renderList = (): void => {
      clear(list);
      const query = relationSearchText({
        provider: "manual",
        providerWorkID: null,
        doi: null,
        title: search.value,
        year: null,
        authors: [],
      });
      const filtered = entries.filter(({ work }) =>
        query ? relationSearchText(work).includes(query) : true,
      );
      filtered.sort((left, right) => {
        if (sort.value === "recent")
          return (right.work.year ?? -1) - (left.work.year ?? -1);
        if (sort.value === "oldest")
          return (left.work.year ?? 9999) - (right.work.year ?? 9999);
        if (sort.value === "cited")
          return (
            (right.work.citationCount ?? -1) - (left.work.citationCount ?? -1)
          );
        if (sort.value === "title")
          return externalWorkTitle(left.work).localeCompare(
            externalWorkTitle(right.work),
          );
        if (sort.value === "library")
          return (
            Number(Boolean(right.work.inLibraryItemKey)) -
              Number(Boolean(left.work.inLibraryItemKey)) ||
            left.providerOrder - right.providerOrder
          );
        return left.providerOrder - right.providerOrder;
      });
      for (const entry of filtered) {
        renderRelationCard(
          document,
          list,
          item,
          direction,
          entry.work,
          entry.manualRelation,
          rerender,
        );
      }
      if (!filtered.length) {
        list.append(
          txt(
            document,
            "p",
            providerLookupActive
              ? "Searching provider relationships..."
              : "No relationships are available.",
          ),
        );
      }
      const base = `${count(filtered.length)} relationship${filtered.length === 1 ? "" : "s"}`;
      status.textContent = providerLookupActive
        ? `${base}; searching providers...`
        : base;
    };
    search.addEventListener("input", renderList);
    sort.addEventListener("change", renderList);
    renderList();
    container.append(status, list);

    void (async (): Promise<void> => {
      try {
        let loadedWorks = await loadProviderWorks(providerWorks);
        if (loadedWorks.length === 0 && expectedRelationshipCount > 0) {
          await updateCitationDataForItems([item], {
            force: true,
            silent: true,
          });
          ({ node, graph } = await graphNodeForItem(item));
          loadedWorks = await loadProviderWorks(loadCachedWorks());
        }
        providerWorks = mergeRelationWorks(providerWorks, loadedWorks);
        entries = relationEntriesForWorks(
          item,
          direction,
          manualRelations,
          providerWorks,
        );
        renderList();
        const worksToHydrate = providerWorks;
        void hydrateExternalWorksMetadata(worksToHydrate)
          .then((hydratedWorks) => {
            providerWorks = mergeRelationWorks(providerWorks, hydratedWorks);
            entries = relationEntriesForWorks(
              item,
              direction,
              manualRelations,
              providerWorks,
            );
            renderList();
          })
          .catch((error: unknown) => {
            Zotero.debug(
              `Citation Map: item-pane relationship metadata hydration failed: ${String(error)}`,
            );
          });
      } catch (error) {
        Zotero.debug(
          `Citation Map: item-pane ${direction} provider refresh failed: ${String(error)}`,
        );
      } finally {
        providerLookupActive = false;
        renderList();
      }
    })();

    const ignoredRelations = getIgnoredRelations(
      Number(item.libraryID),
      String(item.key),
    ).filter((relation) => relation.direction === direction);
    if (ignoredRelations.length) {
      const disclosure = el(document, "details", "citation-map-data-details");
      disclosure.appendChild(
        txt(
          document,
          "summary",
          `${ignoredRelations.length} ignored provider relation${ignoredRelations.length === 1 ? "" : "s"}`,
        ),
      );
      for (const relation of ignoredRelations) {
        const line = el(document, "div", "citation-map-ignored-relation");
        line.append(
          txt(
            document,
            "span",
            relation.doi ??
              relation.normalizedTitle ??
              relation.providerWorkID ??
              "Unknown relation",
          ),
        );
        const restore = el(document, "button");
        restore.type = "button";
        restore.textContent = "Restore";
        restore.addEventListener("click", () => {
          runUIAction("restoring a citation relation", async () => {
            await removeIgnoredRelation(relation.id);
            rerender();
          });
        });
        line.appendChild(restore);
        disclosure.appendChild(line);
      }
      container.appendChild(disclosure);
    }
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
  let active: "overview" | "cited-by" | "references" = "overview";
  const render = (): void => {
    setSectionSummary?.(summaryForItem(item));
    clear(body);
    const shell = el(document, "div", "citation-map-item-pane");
    const content = el(document, "div", "citation-map-pane-content");
    const select = (tab: typeof active): void => {
      active = tab;
      render();
    };
    shell.append(createTabs(document, active, select), content);
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
  refreshCallbacks.clear();
}
