import { config } from "../../package.json";
import type {
  ManualCitationRelation,
  ManualRelationDirection,
  RelatedWorkMetadata,
} from "../domain/citationTypes";
import type { CitationGraphNode } from "../domain/graphTypes";
import {
  getExternalCitedBy,
  getExternalReferences,
  type ExternalWork,
} from "./externalDiscoveryService";
import {
  addManualRelation,
  confirmCitationMatch,
  confirmCitationMatchCandidate,
  getCitationMetricRecord,
  getIgnoredRelations,
  getManualRelations,
  ignoreProviderRelation,
  removeIgnoredRelation,
  removeManualRelation,
} from "./citationMetricsStore";
import { createMetricNodeForItem } from "./itemMetricContext";
import { formatMetricValue, getMetricDefinition } from "./metricRegistry";
import { updateCitationDataForItems } from "./citationUpdateService";
import { loadWholeLibrary } from "./zoteroLibraryService";
import { buildCitationGraph } from "./citationGraphService";
import { openCitationMapAndSelectItem } from "./windowService";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const PANE_ID = "citation-map-item-pane";
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

function count(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "—"
    : new Intl.NumberFormat().format(value);
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
  libraryNodes: CitationGraphNode[];
}> {
  const snapshot = await loadWholeLibrary(Number(item.libraryID));
  const graph = buildCitationGraph(snapshot);
  return {
    node:
      graph.nodes.find((candidate) => candidate.itemKey === String(item.key)) ??
      createMetricNodeForItem(item),
    libraryNodes: graph.nodes,
  };
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
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      await confirmCitationMatch(Number(item.libraryID), String(item.key));
      rerender();
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
      use.addEventListener("click", async () => {
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
    const retraction = el(document, "div", "citation-map-retraction-warning");
    retraction.textContent =
      "Retraction reported by a scholarly-data provider. Verify the current status with the publisher.";
    container.appendChild(retraction);
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
      "Citation percentile",
      formatMetricValue("citation-percentile", node.citationPercentile),
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
      "Journal h-index",
      formatMetricValue("journal-h-index", node.sourceMetrics?.hIndex ?? null),
      getMetricDefinition("journal-h-index").description,
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
    row(document, "Citation-count provider", node.citationCountProvider ?? "—"),
    row(
      document,
      "Reference-count provider",
      node.referenceCountProvider ?? "—",
    ),
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
  );
  const corrections = getIgnoredRelations(
    Number(item.libraryID),
    String(item.key),
  );
  const manual = getManualRelations(Number(item.libraryID), String(item.key));
  detailMetrics.append(
    row(document, "Local manual relations", String(manual.length)),
    row(document, "Ignored provider relations", String(corrections.length)),
    row(
      document,
      "Aggregate-count policy",
      "Provider totals retained; local corrections are shown separately",
    ),
  );
  details.appendChild(detailMetrics);
  container.appendChild(details);

  const actions = el(document, "div", "citation-map-pane-actions");
  const refresh = el(document, "button", "citation-map-primary-button");
  refresh.type = "button";
  refresh.textContent = "Refresh";
  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    await updateCitationDataForItems([item], { force: true });
    rerender();
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

function relationKey(work: RelatedWorkMetadata): string {
  return [work.provider, work.providerWorkID, work.doi, work.title]
    .filter(Boolean)
    .join(":");
}

function ignored(
  work: RelatedWorkMetadata,
  item: Zotero.Item,
  direction: ManualRelationDirection,
): boolean {
  const ignoredRelations = getIgnoredRelations(
    Number(item.libraryID),
    String(item.key),
  );
  const normalizedTitle = String(work.title ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  return ignoredRelations.some(
    (entry) =>
      entry.direction === direction &&
      entry.provider === work.provider &&
      ((entry.providerWorkID && entry.providerWorkID === work.providerWorkID) ||
        (entry.doi && entry.doi === work.doi) ||
        (entry.normalizedTitle && entry.normalizedTitle === normalizedTitle)),
  );
}

function manualWork(relation: ManualCitationRelation): ExternalWork | null {
  const related = itemByKey(relation.libraryID, relation.relatedItemKey);
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
    zoteroItemKey: relation.relatedItemKey,
    inLibraryItemKey: relation.relatedItemKey,
  };
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
  card.append(
    txt(document, "h4", externalWorkTitle(work)),
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
      if (related) {
        const pane = Zotero.getActiveZoteroPane?.();
        pane?.selectItem?.(related.id);
      }
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
  const remove = el(document, "button");
  remove.type = "button";
  remove.textContent = manualRelation
    ? "Remove manual relation"
    : "Mark incorrect";
  remove.addEventListener("click", async () => {
    remove.disabled = true;
    if (manualRelation) {
      await removeManualRelation(manualRelation.id);
    } else {
      const normalizedTitle = String(work.title ?? "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ");
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
  actions.appendChild(remove);
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
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", actionLabel);

  const header = el(document, "header", "citation-map-relation-dialog-header");
  header.appendChild(txt(document, "strong", actionLabel));
  const close = el(document, "button", "citation-map-dialog-close");
  close.type = "button";
  close.textContent = "×";
  close.title = "Close";
  close.setAttribute("aria-label", "Close");
  header.appendChild(close);

  const input = el(document, "input");
  input.type = "search";
  input.placeholder = "Search this Zotero library";
  input.setAttribute("aria-label", "Search Zotero library");
  const results = el(document, "div", "citation-map-local-results");
  results.append(txt(document, "p", "Enter a title, author, DOI or year."));
  let timer: number | null = null;

  const closeDialog = (): void => {
    overlay.hidden = true;
    document.removeEventListener("keydown", onKeyDown);
    button.focus();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") closeDialog();
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
    if (!matches.length) {
      results.append(
        txt(
          document,
          "p",
          "No matching Zotero items. Manual relations can only point to existing Zotero items.",
        ),
      );
      return;
    }
    for (const candidate of matches) {
      const result = el(document, "button", "citation-map-local-result");
      result.type = "button";
      result.textContent = itemLabel(candidate);
      result.addEventListener("click", async () => {
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
      results.appendChild(result);
    }
  };

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
    document.addEventListener("keydown", onKeyDown);
    input.focus();
    input.select();
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
  container.append(
    txt(
      document,
      "p",
      direction === "reference"
        ? "Provider references and local manual relations."
        : "Known citing works. The provider aggregate count is retained even when individual relations are corrected locally.",
      "citation-map-secondary-text",
    ),
  );
  const loading = txt(document, "p", "Loading…", "citation-map-secondary-text");
  container.appendChild(loading);
  try {
    const { node, libraryNodes } = await graphNodeForItem(item);
    const providerWorks =
      direction === "reference"
        ? await getExternalReferences(node, libraryNodes, 150)
        : await getExternalCitedBy(node, libraryNodes, 150);
    const manualRelations = getManualRelations(
      Number(item.libraryID),
      String(item.key),
    ).filter((relation) => relation.direction === direction);
    loading.remove();

    const entries: Array<{
      work: ExternalWork;
      manualRelation: ManualCitationRelation | null;
      providerOrder: number;
    }> = [];
    const seen = new Set<string>();
    for (const [providerOrder, work] of providerWorks.entries()) {
      if (ignored(work, item, direction)) continue;
      const key = relationKey(work);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ work, manualRelation: null, providerOrder });
    }
    for (const relation of manualRelations) {
      const work = manualWork(relation);
      if (!work) continue;
      const key = work.inLibraryItemKey ?? relationKey(work);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        work,
        manualRelation: relation,
        providerOrder: providerWorks.length + entries.length,
      });
    }

    const controls = el(document, "div", "citation-map-relation-controls");
    const search = el(document, "input");
    search.type = "search";
    search.placeholder =
      direction === "reference" ? "Search references" : "Search citing papers";
    search.setAttribute("aria-label", search.placeholder);
    const sort = el(document, "select");
    sort.setAttribute("aria-label", "Sort relationships");
    const sortOptions: Array<[string, string]> =
      direction === "reference"
        ? [
            ["provider", "Bibliography/provider order"],
            ["recent", "Most recent"],
            ["oldest", "Oldest"],
            ["cited", "Most cited"],
            ["title", "Title"],
            ["library", "In Zotero first"],
          ]
        : [
            ["recent", "Most recent"],
            ["oldest", "Oldest"],
            ["cited", "Most cited"],
            ["title", "Title"],
            ["library", "In Zotero first"],
          ];
    for (const [value, label] of sortOptions) {
      const option = el(document, "option");
      option.value = value;
      option.textContent = label;
      sort.appendChild(option);
    }
    const relationDialog = createManualRelationDialog(
      document,
      item,
      direction,
      rerender,
    );
    controls.append(search, sort, relationDialog.button);
    container.append(controls, relationDialog.overlay);

    const status = txt(document, "p", "", "citation-map-secondary-text");
    const list = el(document, "div", "citation-map-relation-list");
    const loadMore = el(document, "button", "citation-map-relation-load-more");
    loadMore.type = "button";
    loadMore.textContent = "Load more";
    let visibleLimit = 50;

    const renderList = (): void => {
      clear(list);
      const query = search.value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase()
        .trim();
      const filtered = entries.filter(({ work }) =>
        query ? relationSearchText(work).includes(query) : true,
      );
      const sorted = [...filtered].sort((left, right) => {
        switch (sort.value) {
          case "recent":
            return (right.work.year ?? -1) - (left.work.year ?? -1);
          case "oldest":
            return (
              (left.work.year ?? Number.MAX_SAFE_INTEGER) -
              (right.work.year ?? Number.MAX_SAFE_INTEGER)
            );
          case "cited":
            return (
              (right.work.citationCount ?? -1) - (left.work.citationCount ?? -1)
            );
          case "title":
            return externalWorkTitle(left.work).localeCompare(
              externalWorkTitle(right.work),
            );
          case "library": {
            const localDifference =
              Number(Boolean(right.work.inLibraryItemKey)) -
              Number(Boolean(left.work.inLibraryItemKey));
            return localDifference || left.providerOrder - right.providerOrder;
          }
          default:
            return left.providerOrder - right.providerOrder;
        }
      });
      for (const entry of sorted.slice(0, visibleLimit)) {
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
      if (!sorted.length) {
        list.append(
          txt(
            document,
            "p",
            query
              ? "No relationships match the current search."
              : "No relationships are currently available.",
          ),
        );
      }
      const shown = Math.min(sorted.length, visibleLimit);
      status.textContent = `${count(shown)} of ${count(sorted.length)} relationship${sorted.length === 1 ? "" : "s"}`;
      loadMore.hidden = shown >= sorted.length;
    };

    search.addEventListener("input", () => {
      visibleLimit = 50;
      renderList();
    });
    sort.addEventListener("change", () => {
      visibleLimit = 50;
      renderList();
    });
    loadMore.addEventListener("click", () => {
      visibleLimit += 50;
      renderList();
    });
    renderList();
    container.append(status, list, loadMore);

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
        restore.addEventListener("click", async () => {
          await removeIgnoredRelation(relation.id);
          rerender();
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
      item,
      setEnabled,
      setSectionSummary,
    }: {
      item: Zotero.Item;
      setEnabled: (enabled: boolean) => void;
      setSectionSummary: (summary: string) => void;
    }) => {
      const subject = paneSubjectItem(item);
      setEnabled(Boolean(subject));
      if (subject) setSectionSummary(summaryForItem(subject));
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
      const subject = paneSubjectItem(item);
      if (!subject) {
        clear(body);
        return;
      }
      renderPane(doc, body, subject, setSectionSummary);
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
