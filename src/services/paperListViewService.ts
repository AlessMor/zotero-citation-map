/// <reference lib="dom" />

import type {
  LibraryCollectionFilter,
  LibrarySnapshot,
  ZoteroPaper,
} from "../domain/types";
import type { ExternalWork } from "./externalDiscoveryService";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";
import { createCitationMapIcon } from "./uiIconService";
import {
  relationshipSortOptions,
  type RelationshipSortKey,
} from "./relationshipViewService";

const HTML_NS = "http://www.w3.org/1999/xhtml";

export type PaperRelationFilter = "all" | "related" | "unrelated";

export interface PaperListDescriptor {
  key: string;
  title: string;
  authors: string[];
  sourceTitle: string | null;
  year: number | null;
  citationCount: number | null;
  referenceCount: number | null;
  dateAdded: number | null;
  dateModified: number | null;
  itemType: string | null;
  tags: string[];
  collectionIDs: number[];
  inZotero: boolean;
  alreadyRelated: boolean;
  manuallyRelated: boolean;
  isOpenAccess: boolean | null;
  isRetracted: boolean | null;
}

export interface PaperListFilterState {
  collectionID: number | null;
  tag: string | null;
  relation: PaperRelationFilter;
  itemType: string | null;
  yearMin: number | null;
  yearMax: number | null;
  includeMissingYear: boolean;
  includeMissingCitations: boolean;
  includeMissingReferences: boolean;
  excludeRetracted: boolean;
  openAccessOnly: boolean;
}

export interface PaperListToolbarOptions {
  document: Document;
  searchPlaceholder: string;
  collections?: LibraryCollectionFilter[];
  buttonClassName?: string;
  inputClassName?: string;
  initialSort?: RelationshipSortKey;
  showRelationshipFilter?: boolean;
  showItemTypeFilter?: boolean;
  onChange: () => void;
}

export interface PaperFilterControllerOptions {
  document: Document;
  collections?: LibraryCollectionFilter[];
  buttonClassName?: string;
  getDescriptors: () => PaperListDescriptor[];
  showRelationshipFilter?: boolean;
  showItemTypeFilter?: boolean;
  onChange: () => void;
}

export interface PaperFilterController {
  root: HTMLDivElement;
  button: HTMLButtonElement;
  matches(descriptor: PaperListDescriptor): boolean;
  state(): PaperListFilterState;
  hasActiveFilters(): boolean;
  reset(): void;
  destroy(): void;
}

export interface PaperListToolbar {
  root: HTMLDivElement;
  searchInput: HTMLInputElement;
  apply<T>(entries: T[], describe: (entry: T) => PaperListDescriptor): T[];
  sortValue(): RelationshipSortKey;
  filterState(): PaperListFilterState;
  hasActiveQueryOrFilters(): boolean;
  reset(): void;
  destroy(): void;
}

interface PopupController {
  root: HTMLDivElement;
  button: HTMLButtonElement;
  menu: HTMLDivElement;
  open(): void;
  close(focusButton?: boolean): void;
  destroy(): void;
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

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateOrNull(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function itemByKey(
  libraryID: number,
  itemKey: string | null | undefined,
): Zotero.Item | null {
  if (!itemKey) return null;
  try {
    return (
      (Zotero.Items as any).getByLibraryAndKey?.(libraryID, itemKey) ?? null
    );
  } catch {
    return null;
  }
}

function itemTags(item: Zotero.Item | null): string[] {
  if (!item) return [];
  try {
    return (item.getTags?.() ?? [])
      .map((entry: any) => String(entry?.tag ?? entry ?? "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function itemCollections(item: Zotero.Item | null): number[] {
  if (!item) return [];
  try {
    return (item.getCollections?.() ?? [])
      .map((value: unknown) => Number(value))
      .filter((value: number) => Number.isFinite(value));
  } catch {
    return [];
  }
}

function itemType(item: Zotero.Item | null): string | null {
  if (!item) return null;
  const direct = String((item as any).itemType ?? "").trim();
  if (direct) return direct;
  try {
    const name = String(
      (Zotero.ItemTypes as any)?.getName?.(item.itemTypeID) ?? "",
    ).trim();
    return name || null;
  } catch {
    return null;
  }
}

function itemField(item: Zotero.Item | null, field: string): string {
  if (!item) return "";
  try {
    return String((item as any)[field] ?? item.getField?.(field) ?? "").trim();
  } catch {
    return "";
  }
}

interface LocalPaperIndexes {
  byDOI: Map<string, ZoteroPaper>;
  byTitle: Map<string, ZoteroPaper>;
}

const localPaperIndexes = new WeakMap<object, LocalPaperIndexes>();

function indexesForLocalPapers(
  papers: ReadonlyMap<string, ZoteroPaper>,
): LocalPaperIndexes {
  const owner = papers as object;
  const cached = localPaperIndexes.get(owner);
  if (cached) return cached;
  const byDOI = new Map<string, ZoteroPaper>();
  const byTitle = new Map<string, ZoteroPaper>();
  for (const paper of papers.values()) {
    const doi = normalizeDOI(paper.doi);
    const title = normalizeExactTitle(paper.title);
    if (doi && !byDOI.has(doi)) byDOI.set(doi, paper);
    if (title && !byTitle.has(title)) byTitle.set(title, paper);
  }
  const created = { byDOI, byTitle };
  localPaperIndexes.set(owner, created);
  return created;
}

function localPaperForExternalWork(
  work: ExternalWork,
  papers?: ReadonlyMap<string, ZoteroPaper>,
): ZoteroPaper | null {
  if (!papers) return null;
  const explicitKey = work.inLibraryItemKey ?? work.zoteroItemKey ?? null;
  if (explicitKey) {
    const explicit = papers.get(explicitKey);
    if (explicit) return explicit;
  }
  const indexes = indexesForLocalPapers(papers);
  const doi = normalizeDOI(work.doi);
  if (doi) {
    const match = indexes.byDOI.get(doi);
    if (match) return match;
  }
  const title = normalizeExactTitle(work.title);
  return title ? (indexes.byTitle.get(title) ?? null) : null;
}

function listenForSelectCommit(
  select: HTMLSelectElement,
  commit: () => void,
): void {
  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    const view = select.ownerDocument.defaultView;
    const run = (): void => {
      scheduled = false;
      commit();
    };
    if (view) view.setTimeout(run, 0);
    else setTimeout(run, 0);
  };
  for (const eventName of ["input", "change", "command"]) {
    select.addEventListener(eventName, schedule);
  }
  select.addEventListener("blur", schedule);
}

export function describeZoteroPaper(
  paper: ZoteroPaper,
  alreadyRelated = false,
  manuallyRelated = false,
): PaperListDescriptor {
  const item = itemByKey(paper.libraryID, paper.itemKey);
  return {
    key: paper.itemKey,
    title: paper.title || "Title unavailable",
    authors: paper.authors,
    sourceTitle: paper.sourceTitle,
    year: paper.year,
    citationCount: paper.metrics.citationCount,
    referenceCount: paper.metrics.referenceCount,
    dateAdded: dateOrNull(itemField(item, "dateAdded")),
    dateModified: dateOrNull(itemField(item, "dateModified")),
    itemType: itemType(item),
    tags: paper.tags.length ? paper.tags : itemTags(item),
    collectionIDs: paper.collectionIDs.length
      ? paper.collectionIDs
      : itemCollections(item),
    inZotero: true,
    alreadyRelated,
    manuallyRelated,
    isOpenAccess: paper.metrics.isOpenAccess,
    isRetracted: paper.metrics.isRetracted,
  };
}

export function describeExternalWork(
  work: ExternalWork,
  libraryID: number,
  alreadyRelated = true,
  manuallyRelated = false,
  localPapersByKey?: ReadonlyMap<string, ZoteroPaper>,
): PaperListDescriptor {
  const explicitLocalKey = work.inLibraryItemKey ?? work.zoteroItemKey ?? null;
  const localPaper = localPaperForExternalWork(work, localPapersByKey);
  const localKey = localPaper?.itemKey ?? explicitLocalKey;
  const item = localPaper
    ? ((Zotero.Items.get(localPaper.itemID) as Zotero.Item | null) ??
      itemByKey(libraryID, localPaper.itemKey))
    : itemByKey(libraryID, localKey);
  const localTitle = localPaper?.title ?? itemField(item, "title");
  const title =
    String(work.title ?? "").trim() || localTitle || "Title unavailable";
  const localYear = Number.parseInt(
    itemField(item, "year") || itemField(item, "date"),
    10,
  );
  return {
    key:
      localKey ??
      work.doi ??
      work.providerWorkID ??
      `${work.provider}:${normalize(title)}`,
    title,
    authors: work.authors.length ? work.authors : (localPaper?.authors ?? []),
    sourceTitle:
      (work.sourceTitle ??
        localPaper?.sourceTitle ??
        itemField(item, "publicationTitle")) ||
      null,
    year:
      work.year ??
      localPaper?.year ??
      (Number.isFinite(localYear) && localYear > 0 ? localYear : null),
    citationCount:
      work.citationCount ?? localPaper?.metrics.citationCount ?? null,
    referenceCount:
      work.referenceCount ?? localPaper?.metrics.referenceCount ?? null,
    dateAdded: dateOrNull(itemField(item, "dateAdded")),
    dateModified: dateOrNull(itemField(item, "dateModified")),
    itemType: itemType(item),
    tags: localPaper?.tags.length ? localPaper.tags : itemTags(item),
    collectionIDs: localPaper?.collectionIDs.length
      ? localPaper.collectionIDs
      : itemCollections(item),
    inZotero: Boolean(localPaper || item),
    alreadyRelated,
    manuallyRelated,
    isOpenAccess: work.isOpenAccess ?? localPaper?.metrics.isOpenAccess ?? null,
    isRetracted: work.isRetracted ?? localPaper?.metrics.isRetracted ?? null,
  };
}

function configureIconButton(
  button: HTMLButtonElement,
  label: string,
  name: "sort" | "filter",
): void {
  button.replaceChildren(createCitationMapIcon(button.ownerDocument, name));
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  Object.assign(button.style, {
    width: "30px",
    minWidth: "30px",
    padding: "4px",
    justifyContent: "center",
    color: "inherit",
  });
}

function createPopupController(
  document: Document,
  buttonClassName: string | undefined,
  label: string,
  iconName: "sort" | "filter",
  beforeOpen?: () => void,
): PopupController {
  const root = element(document, "div");
  Object.assign(root.style, { position: "relative", width: "30px" });
  const button = element(document, "button", buttonClassName);
  configureIconButton(button, label, iconName);
  const menu = element(document, "div");
  menu.setAttribute("role", "menu");
  Object.assign(menu.style, {
    display: "none",
    position: "fixed",
    zIndex: "2147483647",
    top: "0",
    left: "0",
    right: "auto",
    minWidth: "190px",
    maxWidth: "min(390px, calc(100vw - 16px))",
    maxHeight: "min(620px, calc(100vh - 16px))",
    overflow: "auto",
    padding: "5px",
    border: "1px solid color-mix(in srgb, CanvasText 18%, transparent)",
    borderRadius: "7px",
    background: "Canvas",
    color: "CanvasText",
    boxShadow: "0 8px 24px rgba(0, 0, 0, .24)",
  });

  // Keep the popup outside the item-pane/graph containers. Those containers
  // use overflow clipping, which cannot be escaped by increasing z-index.
  const overlayHost = document.body ?? document.documentElement;
  root.appendChild(button);
  overlayHost.appendChild(menu);

  let nativeFilterSelectActive = false;
  const isTaggedFilterSelect = (target: EventTarget | null): boolean => {
    const targetElement = target as Element | null;
    return Boolean(
      targetElement?.closest?.(
        'select[data-citation-map-filter-select="true"]',
      ),
    );
  };
  menu.addEventListener(
    "pointerdown",
    (event) => {
      if (isTaggedFilterSelect(event.target)) nativeFilterSelectActive = true;
    },
    true,
  );
  menu.addEventListener(
    "change",
    (event) => {
      if (isTaggedFilterSelect(event.target)) nativeFilterSelectActive = false;
    },
    true,
  );

  const isOpen = (): boolean => menu.style.display !== "none";
  const positionMenu = (): void => {
    if (!isOpen() || !button.isConnected) return;
    const view = document.defaultView;
    const viewportWidth =
      view?.innerWidth ?? document.documentElement.clientWidth;
    const viewportHeight =
      view?.innerHeight ?? document.documentElement.clientHeight;
    const margin = 8;
    const gap = 4;
    const buttonRect = button.getBoundingClientRect();

    // Measure after display so the actual menu width and content height are
    // available. Keep it invisible during positioning to avoid a visible jump.
    menu.style.visibility = "hidden";
    menu.style.maxHeight = `${Math.max(96, viewportHeight - margin * 2)}px`;
    const naturalRect = menu.getBoundingClientRect();
    const menuWidth = Math.min(naturalRect.width, viewportWidth - margin * 2);
    const below = Math.max(
      0,
      viewportHeight - buttonRect.bottom - gap - margin,
    );
    const above = Math.max(0, buttonRect.top - gap - margin);
    const opensBelow =
      below >= Math.min(naturalRect.height, 240) || below >= above;
    const availableHeight = Math.max(96, opensBelow ? below : above);

    menu.style.maxHeight = `${Math.min(620, availableHeight)}px`;
    const measuredHeight = Math.min(
      menu.getBoundingClientRect().height,
      availableHeight,
    );
    const left = Math.max(
      margin,
      Math.min(
        buttonRect.right - menuWidth,
        viewportWidth - menuWidth - margin,
      ),
    );
    const top = opensBelow
      ? Math.min(
          buttonRect.bottom + gap,
          viewportHeight - measuredHeight - margin,
        )
      : Math.max(margin, buttonRect.top - gap - measuredHeight);

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.visibility = "visible";
  };
  const close = (focusButton = false): void => {
    nativeFilterSelectActive = false;
    menu.style.display = "none";
    menu.style.visibility = "visible";
    button.setAttribute("aria-expanded", "false");
    if (focusButton && root.isConnected) button.focus();
  };
  const open = (): void => {
    beforeOpen?.();
    menu.style.display = "grid";
    button.setAttribute("aria-expanded", "true");
    positionMenu();
  };
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (isOpen()) close();
    else open();
  });
  const onDocumentPointerDown = (event: Event): void => {
    if (!root.isConnected) {
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      document.removeEventListener("scroll", onViewportChange, true);
      document.defaultView?.removeEventListener("resize", onViewportChange);
      menu.remove();
      return;
    }
    const target = event.target as Node | null;
    if (target && (root.contains(target) || menu.contains(target))) return;
    if (nativeFilterSelectActive) {
      // Firefox renders native HTML select options outside the document tree.
      // Ignore the option-selection pointer event so the select can commit.
      nativeFilterSelectActive = false;
      return;
    }
    const focused = document.activeElement;
    // Firefox renders the native <select> popup outside the document subtree.
    // Do not close while a select in this detached overlay owns focus.
    if (focused?.tagName === "SELECT" && menu.contains(focused)) return;
    close();
  };
  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !isOpen()) return;
    event.preventDefault();
    close(true);
  };
  const onViewportChange = (): void => {
    if (isOpen()) positionMenu();
  };
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeyDown, true);
  document.addEventListener("scroll", onViewportChange, true);
  document.defaultView?.addEventListener("resize", onViewportChange);
  return {
    root,
    button,
    menu,
    open,
    close,
    destroy: () => {
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      document.removeEventListener("scroll", onViewportChange, true);
      document.defaultView?.removeEventListener("resize", onViewportChange);
      close();
      menu.remove();
    },
  };
}

function compareNullable(
  left: number | null,
  right: number | null,
  descending: boolean,
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return descending ? right - left : left - right;
}

function sortDescriptors<T>(
  entries: Array<{ entry: T; descriptor: PaperListDescriptor; index: number }>,
  key: RelationshipSortKey,
): T[] {
  return entries
    .sort((left, right) => {
      const a = left.descriptor;
      const b = right.descriptor;
      let comparison = 0;
      switch (key) {
        case "newest":
          comparison = compareNullable(a.year, b.year, true);
          break;
        case "oldest":
          comparison = compareNullable(a.year, b.year, false);
          break;
        case "date-saved":
          comparison = compareNullable(a.dateAdded, b.dateAdded, true);
          break;
        case "date-updated":
          comparison = compareNullable(a.dateModified, b.dateModified, true);
          break;
        case "title":
          comparison = a.title.localeCompare(b.title, undefined, {
            sensitivity: "base",
          });
          break;
        case "most-cited":
          comparison = compareNullable(a.citationCount, b.citationCount, true);
          break;
        case "most-references":
          comparison = compareNullable(
            a.referenceCount,
            b.referenceCount,
            true,
          );
          break;
      }
      return (
        comparison ||
        a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
        left.index - right.index
      );
    })
    .map(({ entry }) => entry);
}

function descriptorSearchText(descriptor: PaperListDescriptor): string {
  return normalize(
    [
      descriptor.title,
      descriptor.authors.join(" "),
      descriptor.sourceTitle ?? "",
      descriptor.year ?? "",
      descriptor.itemType ?? "",
      descriptor.tags.join(" "),
    ].join(" "),
  );
}

function activeFilterCount(state: PaperListFilterState): number {
  return [
    state.collectionID !== null,
    Boolean(state.tag),
    state.relation !== "all",
    Boolean(state.itemType),
    state.yearMin !== null || state.yearMax !== null,
    !state.includeMissingYear,
    !state.includeMissingCitations,
    !state.includeMissingReferences,
    state.excludeRetracted,
    state.openAccessOnly,
  ].filter(Boolean).length;
}

function defaultFilterState(): PaperListFilterState {
  return {
    collectionID: null,
    tag: null,
    relation: "all",
    itemType: null,
    yearMin: null,
    yearMax: null,
    includeMissingYear: true,
    includeMissingCitations: true,
    includeMissingReferences: true,
    excludeRetracted: false,
    openAccessOnly: false,
  };
}

function appendOption(
  document: Document,
  select: HTMLSelectElement,
  label: string,
  value: string,
): void {
  const option = element(document, "option");
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

function appendLabelledControl(
  document: Document,
  menu: HTMLElement,
  labelText: string,
  control: HTMLElement,
): void {
  const wrapper = element(document, "label");
  Object.assign(wrapper.style, {
    display: "grid",
    gridTemplateColumns: "105px minmax(0, 1fr)",
    gap: "8px",
    alignItems: "center",
    padding: "3px",
  });
  const label = element(document, "span");
  label.textContent = labelText;
  label.style.fontSize = "11px";
  wrapper.append(label, control);
  menu.appendChild(wrapper);
}

function appendCheckbox(
  document: Document,
  menu: HTMLElement,
  labelText: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
): void {
  const label = element(document, "label");
  Object.assign(label.style, {
    display: "flex",
    alignItems: "center",
    gap: "7px",
    padding: "4px 3px",
  });
  const input = element(document, "input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  label.append(input, element(document, "span"));
  label.lastElementChild!.textContent = labelText;
  menu.appendChild(label);
}

function ensureDualRangeStyles(document: Document): void {
  if (document.getElementById("citation-map-dual-range-styles")) return;
  const style = element(document, "style");
  style.id = "citation-map-dual-range-styles";
  style.textContent = `
    .citation-map-dual-range {
      position: relative;
      height: 28px;
      margin: 2px 5px;
    }
    .citation-map-dual-range-track,
    .citation-map-dual-range-fill {
      position: absolute;
      top: 13px;
      height: 4px;
      border-radius: 999px;
      pointer-events: none;
    }
    .citation-map-dual-range-track {
      left: 0;
      right: 0;
      background: color-mix(in srgb, CanvasText 18%, Canvas);
    }
    .citation-map-dual-range-fill {
      background: var(--accent-blue, Highlight);
    }
    .citation-map-dual-range input[type="range"] {
      appearance: none;
      position: absolute;
      inset: 0;
      width: 100%;
      height: 28px;
      margin: 0;
      background: transparent;
      pointer-events: none;
    }
    .citation-map-dual-range input[type="range"]::-moz-range-track {
      height: 4px;
      border: 0;
      background: transparent;
    }
    .citation-map-dual-range input[type="range"]::-moz-range-progress {
      height: 4px;
      background: transparent;
    }
    .citation-map-dual-range input[type="range"]::-moz-range-thumb {
      width: 14px;
      height: 14px;
      border: 2px solid Canvas;
      border-radius: 50%;
      background: var(--accent-blue, Highlight);
      box-shadow: 0 0 0 1px color-mix(in srgb, CanvasText 28%, transparent);
      pointer-events: auto;
      cursor: grab;
    }
    .citation-map-dual-range input[type="range"]:focus-visible::-moz-range-thumb {
      outline: 2px solid var(--accent-blue, Highlight);
      outline-offset: 2px;
    }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

function indentedCollectionLabel(collection: LibraryCollectionFilter): string {
  return `${"\u00a0\u00a0\u00a0\u00a0".repeat(Math.max(0, collection.depth))}${collection.name}`;
}

export function createPaperFilterController(
  options: PaperFilterControllerOptions,
): PaperFilterController {
  const { document } = options;
  let filters = defaultFilterState();

  const updateFilterButton = (): void => {
    const count = activeFilterCount(filters);
    const label = count ? `Filter papers (${count} active)` : "Filter papers";
    filterPopup.button.title = label;
    filterPopup.button.setAttribute("aria-label", label);
    const active = count > 0;
    filterPopup.button.dataset.active = String(active);
    filterPopup.button.style.background = active
      ? "var(--accent-blue, Highlight)"
      : "";
    filterPopup.button.style.borderColor = active
      ? "var(--accent-blue, Highlight)"
      : "";
    filterPopup.button.style.color = active ? "HighlightText" : "inherit";
  };

  const rebuildFilterMenu = (): void => {
    const menu = filterPopup.menu;
    menu.replaceChildren();
    menu.style.gap = "4px";
    menu.style.minWidth = "330px";
    const latestDescriptors = options.getDescriptors();

    const collections = options.collections ?? [];
    const collectionSelect = element(document, "select");
    collectionSelect.dataset.citationMapFilterSelect = "true";
    appendOption(document, collectionSelect, "Whole library", "");
    for (const collection of collections) {
      appendOption(
        document,
        collectionSelect,
        indentedCollectionLabel(collection),
        String(collection.collectionID),
      );
    }
    collectionSelect.value =
      filters.collectionID === null ? "" : String(filters.collectionID);
    const commitCollection = (): void => {
      const next = numberOrNull(collectionSelect.value);
      if (next === filters.collectionID) return;
      filters.collectionID = next;
      updateFilterButton();
      options.onChange();
    };
    listenForSelectCommit(collectionSelect, commitCollection);
    appendLabelledControl(document, menu, "Collection", collectionSelect);

    const tagSelect = element(document, "select");
    tagSelect.dataset.citationMapFilterSelect = "true";
    appendOption(document, tagSelect, "All tags", "");
    const tags = [...new Set(latestDescriptors.flatMap((entry) => entry.tags))]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    for (const tag of tags) appendOption(document, tagSelect, tag, tag);
    tagSelect.value = filters.tag ?? "";
    const commitTag = (): void => {
      const next = tagSelect.value || null;
      if (next === filters.tag) return;
      filters.tag = next;
      updateFilterButton();
      options.onChange();
    };
    listenForSelectCommit(tagSelect, commitTag);
    appendLabelledControl(document, menu, "Tag", tagSelect);

    if (options.showRelationshipFilter) {
      const relationSelect = element(document, "select");
      appendOption(document, relationSelect, "All papers", "all");
      appendOption(document, relationSelect, "Already related", "related");
      appendOption(
        document,
        relationSelect,
        "Not already related",
        "unrelated",
      );
      relationSelect.value = filters.relation;
      const commitRelation = (): void => {
        const next = relationSelect.value as PaperRelationFilter;
        if (next === filters.relation) return;
        filters.relation = next;
        updateFilterButton();
        options.onChange();
      };
      listenForSelectCommit(relationSelect, commitRelation);
      appendLabelledControl(document, menu, "Relationship", relationSelect);
    }

    if (options.showItemTypeFilter) {
      const typeSelect = element(document, "select");
      appendOption(document, typeSelect, "All item types", "");
      const itemTypes = [
        ...new Set(
          latestDescriptors
            .map((entry) => entry.itemType)
            .filter((entry): entry is string => Boolean(entry)),
        ),
      ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      for (const type of itemTypes) {
        appendOption(document, typeSelect, type, type);
      }
      typeSelect.value = filters.itemType ?? "";
      const commitItemType = (): void => {
        const next = typeSelect.value || null;
        if (next === filters.itemType) return;
        filters.itemType = next;
        updateFilterButton();
        options.onChange();
      };
      listenForSelectCommit(typeSelect, commitItemType);
      appendLabelledControl(document, menu, "Item type", typeSelect);
    }

    const years = latestDescriptors
      .map((entry) => entry.year)
      .filter(
        (entry): entry is number => entry !== null && Number.isFinite(entry),
      );
    const currentYear = new Date().getFullYear();
    const minimumYear = years.length ? Math.min(...years) : currentYear - 100;
    const maximumYear = years.length ? Math.max(...years) : currentYear;
    const yearSection = element(document, "fieldset");
    Object.assign(yearSection.style, {
      display: "grid",
      gap: "5px",
      margin: "4px 3px",
      padding: "7px",
      border: "1px solid color-mix(in srgb, CanvasText 14%, transparent)",
      borderRadius: "6px",
    });
    const legend = element(document, "legend");
    legend.textContent = "Publication year";
    legend.style.padding = "0 4px";
    yearSection.appendChild(legend);

    ensureDualRangeStyles(document);
    const rangeRoot = element(document, "div", "citation-map-dual-range");
    const track = element(document, "div", "citation-map-dual-range-track");
    const fill = element(document, "div", "citation-map-dual-range-fill");
    const minRange = element(document, "input");
    const maxRange = element(document, "input");
    for (const range of [minRange, maxRange]) {
      range.type = "range";
      range.min = String(minimumYear);
      range.max = String(maximumYear);
      range.step = "1";
    }
    minRange.setAttribute("aria-label", "Minimum publication year");
    maxRange.setAttribute("aria-label", "Maximum publication year");
    minRange.value = String(filters.yearMin ?? minimumYear);
    maxRange.value = String(filters.yearMax ?? maximumYear);
    rangeRoot.append(track, fill, minRange, maxRange);

    const numbers = element(document, "div");
    Object.assign(numbers.style, {
      display: "grid",
      gridTemplateColumns: "1fr auto 1fr",
      gap: "6px",
      alignItems: "center",
    });
    const minNumber = element(document, "input");
    minNumber.type = "number";
    minNumber.min = String(minimumYear);
    minNumber.max = String(maximumYear);
    minNumber.value = String(filters.yearMin ?? minimumYear);
    minNumber.setAttribute("aria-label", "Minimum publication year");
    const maxNumber = element(document, "input");
    maxNumber.type = "number";
    maxNumber.min = String(minimumYear);
    maxNumber.max = String(maximumYear);
    maxNumber.value = String(filters.yearMax ?? maximumYear);
    maxNumber.setAttribute("aria-label", "Maximum publication year");
    const separator = element(document, "span");
    separator.textContent = "to";
    numbers.append(minNumber, separator, maxNumber);

    const updateRangeVisuals = (): void => {
      const lower = Number(minRange.value);
      const upper = Number(maxRange.value);
      const span = Math.max(1, maximumYear - minimumYear);
      const left = ((lower - minimumYear) / span) * 100;
      const right = ((maximumYear - upper) / span) * 100;
      fill.style.left = `${left}%`;
      fill.style.right = `${right}%`;
      minNumber.value = String(lower);
      maxNumber.value = String(upper);
    };
    const commitRange = (lower: number, upper: number): void => {
      const boundedLower = Math.max(
        minimumYear,
        Math.min(maximumYear, Math.min(lower, upper)),
      );
      const boundedUpper = Math.max(
        minimumYear,
        Math.min(maximumYear, Math.max(lower, upper)),
      );
      minRange.value = String(boundedLower);
      maxRange.value = String(boundedUpper);
      filters.yearMin = boundedLower === minimumYear ? null : boundedLower;
      filters.yearMax = boundedUpper === maximumYear ? null : boundedUpper;
      updateRangeVisuals();
      updateFilterButton();
      options.onChange();
    };
    minRange.addEventListener("input", () => {
      const upper = Number(maxRange.value);
      const lower = Math.min(Number(minRange.value), upper);
      commitRange(lower, upper);
    });
    maxRange.addEventListener("input", () => {
      const lower = Number(minRange.value);
      const upper = Math.max(Number(maxRange.value), lower);
      commitRange(lower, upper);
    });
    const commitNumbers = (): void => {
      const lower = numberOrNull(minNumber.value) ?? minimumYear;
      const upper = numberOrNull(maxNumber.value) ?? maximumYear;
      commitRange(lower, upper);
    };
    minNumber.addEventListener("change", commitNumbers);
    maxNumber.addEventListener("change", commitNumbers);
    updateRangeVisuals();
    yearSection.append(rangeRoot, numbers);
    menu.appendChild(yearSection);

    appendCheckbox(
      document,
      menu,
      "Include missing year",
      filters.includeMissingYear,
      (checked) => {
        filters.includeMissingYear = checked;
        updateFilterButton();
        options.onChange();
      },
    );
    appendCheckbox(
      document,
      menu,
      "Include missing citations",
      filters.includeMissingCitations,
      (checked) => {
        filters.includeMissingCitations = checked;
        updateFilterButton();
        options.onChange();
      },
    );
    appendCheckbox(
      document,
      menu,
      "Include missing references",
      filters.includeMissingReferences,
      (checked) => {
        filters.includeMissingReferences = checked;
        updateFilterButton();
        options.onChange();
      },
    );
    appendCheckbox(
      document,
      menu,
      "Exclude retracted",
      filters.excludeRetracted,
      (checked) => {
        filters.excludeRetracted = checked;
        updateFilterButton();
        options.onChange();
      },
    );
    appendCheckbox(
      document,
      menu,
      "Open access only",
      filters.openAccessOnly,
      (checked) => {
        filters.openAccessOnly = checked;
        updateFilterButton();
        options.onChange();
      },
    );

    const reset = element(document, "button");
    reset.type = "button";
    reset.textContent = "Reset filters";
    reset.style.justifyContent = "center";
    reset.addEventListener("click", () => {
      filters = defaultFilterState();
      updateFilterButton();
      rebuildFilterMenu();
      options.onChange();
    });
    menu.appendChild(reset);
  };

  const filterPopup = createPopupController(
    document,
    options.buttonClassName,
    "Filter papers",
    "filter",
    rebuildFilterMenu,
  );
  updateFilterButton();

  const collectionIDsForFilter = (collectionID: number): Set<number> => {
    const collection = (options.collections ?? []).find(
      (candidate) => candidate.collectionID === collectionID,
    );
    return new Set(
      collection?.includedCollectionIDs?.length
        ? collection.includedCollectionIDs
        : [collectionID],
    );
  };

  const matches = (descriptor: PaperListDescriptor): boolean => {
    if (filters.collectionID !== null) {
      const allowedCollections = collectionIDsForFilter(filters.collectionID);
      if (!descriptor.collectionIDs.some((id) => allowedCollections.has(id))) {
        return false;
      }
    }
    if (
      filters.tag &&
      !descriptor.tags.some((tag) => normalize(tag) === normalize(filters.tag!))
    ) {
      return false;
    }
    if (filters.relation === "related" && !descriptor.alreadyRelated) {
      return false;
    }
    if (filters.relation === "unrelated" && descriptor.alreadyRelated) {
      return false;
    }
    if (filters.itemType && descriptor.itemType !== filters.itemType) {
      return false;
    }
    if (descriptor.year === null) {
      if (!filters.includeMissingYear) return false;
    } else {
      if (filters.yearMin !== null && descriptor.year < filters.yearMin) {
        return false;
      }
      if (filters.yearMax !== null && descriptor.year > filters.yearMax) {
        return false;
      }
    }
    if (!filters.includeMissingCitations && descriptor.citationCount === null) {
      return false;
    }
    if (
      !filters.includeMissingReferences &&
      descriptor.referenceCount === null
    ) {
      return false;
    }
    if (filters.excludeRetracted && descriptor.isRetracted === true) {
      return false;
    }
    if (filters.openAccessOnly && descriptor.isOpenAccess !== true) {
      return false;
    }
    return true;
  };

  return {
    root: filterPopup.root,
    button: filterPopup.button,
    matches,
    state: () => ({ ...filters }),
    hasActiveFilters: () => activeFilterCount(filters) > 0,
    reset: () => {
      filters = defaultFilterState();
      updateFilterButton();
      filterPopup.close();
      options.onChange();
    },
    destroy: () => filterPopup.destroy(),
  };
}

export function createPaperListToolbar(
  options: PaperListToolbarOptions,
): PaperListToolbar {
  const { document } = options;
  let sortKey = options.initialSort ?? "newest";
  let latestDescriptors: PaperListDescriptor[] = [];
  const root = element(document, "div");
  Object.assign(root.style, {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 30px 30px",
    gap: "6px",
    alignItems: "center",
    minWidth: "0",
  });
  const searchInput = element(document, "input", options.inputClassName);
  searchInput.type = "search";
  searchInput.placeholder = options.searchPlaceholder;
  searchInput.style.minWidth = "0";
  searchInput.style.width = "100%";
  searchInput.style.maxWidth = "none";
  searchInput.addEventListener("input", options.onChange);

  const sortPopup = createPopupController(
    document,
    options.buttonClassName,
    "Sort: Newest",
    "sort",
  );
  const sortButtons = new Map<RelationshipSortKey, HTMLButtonElement>();
  const updateSortState = (): void => {
    const label =
      relationshipSortOptions.find((option) => option.value === sortKey)
        ?.label ?? "Newest";
    sortPopup.button.title = `Sort: ${label}`;
    sortPopup.button.setAttribute("aria-label", sortPopup.button.title);
    for (const option of relationshipSortOptions) {
      const button = sortButtons.get(option.value);
      if (!button) continue;
      const selected = option.value === sortKey;
      button.textContent = `${selected ? "✓ " : ""}${option.label}`;
      button.setAttribute("aria-checked", String(selected));
      button.style.fontWeight = selected ? "650" : "400";
    }
  };
  for (const option of relationshipSortOptions) {
    const button = element(document, "button");
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    Object.assign(button.style, {
      width: "100%",
      justifyContent: "flex-start",
      borderColor: "transparent",
      background: "transparent",
      textAlign: "left",
      whiteSpace: "nowrap",
    });
    button.addEventListener("click", () => {
      sortKey = option.value;
      updateSortState();
      sortPopup.close(true);
      options.onChange();
    });
    sortButtons.set(option.value, button);
    sortPopup.menu.appendChild(button);
  }
  updateSortState();

  const filterController = createPaperFilterController({
    document,
    collections: options.collections,
    buttonClassName: options.buttonClassName,
    getDescriptors: () => latestDescriptors,
    showRelationshipFilter: options.showRelationshipFilter,
    showItemTypeFilter: options.showItemTypeFilter,
    onChange: options.onChange,
  });

  root.append(searchInput, sortPopup.root, filterController.root);

  const apply = <T>(
    entries: T[],
    describe: (entry: T) => PaperListDescriptor,
  ): T[] => {
    const prepared = entries.map((entry, index) => ({
      entry,
      descriptor: describe(entry),
      index,
    }));
    latestDescriptors = prepared.map(({ descriptor }) => descriptor);
    const query = normalize(searchInput.value);
    const filtered = prepared.filter(({ descriptor }) => {
      if (query && !descriptorSearchText(descriptor).includes(query)) {
        return false;
      }
      return filterController.matches(descriptor);
    });
    return sortDescriptors(filtered, sortKey);
  };

  return {
    root,
    searchInput,
    apply,
    sortValue: () => sortKey,
    filterState: () => filterController.state(),
    hasActiveQueryOrFilters: () =>
      Boolean(normalize(searchInput.value)) ||
      filterController.hasActiveFilters(),
    reset: () => {
      searchInput.value = "";
      sortKey = options.initialSort ?? "newest";
      updateSortState();
      sortPopup.close();
      filterController.reset();
    },
    destroy: () => {
      sortPopup.destroy();
      filterController.destroy();
    },
  };
}

export function descriptorsFromSnapshot(
  snapshot: LibrarySnapshot,
  subjectItemKey: string,
  alreadyRelatedKeys: Set<string>,
  manuallyRelatedKeys: Set<string>,
): Array<{ paper: ZoteroPaper; descriptor: PaperListDescriptor }> {
  return snapshot.papers
    .filter((paper) => paper.itemKey !== subjectItemKey)
    .map((paper) => ({
      paper,
      descriptor: describeZoteroPaper(
        paper,
        alreadyRelatedKeys.has(paper.itemKey),
        manuallyRelatedKeys.has(paper.itemKey),
      ),
    }));
}
