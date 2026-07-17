/// <reference lib="dom" />

import { config } from "../../package.json";
import type { LibrarySnapshot, ZoteroPaper } from "../domain/types";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const styledDocuments = new WeakSet<Document>();

export type GraphViewMode = "tab" | "window";

export interface GraphSearchDetail {
  query: string;
  matchingItemIDs: number[];
}

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

function dispatchSearchEvent(
  document: Document,
  root: HTMLElement,
  detail: GraphSearchDetail,
): void {
  const event = document.createEvent("CustomEvent");
  event.initCustomEvent("citationmap-search", true, false, detail);
  root.dispatchEvent(event);
}

export function renderCitationMapView(
  document: Document,
  mount: Element,
  snapshot: LibrarySnapshot,
  options: GraphViewOptions,
): HTMLElement {
  ensureGraphStyle(document);
  clearElement(mount);

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

  const searchInput = createHTMLElement(document, "input");
  searchInput.type = "search";
  searchInput.className = "cm-search-input";
  searchInput.placeholder = "Search all fields and tags";
  searchInput.setAttribute("aria-label", "Search all fields and tags");
  searchInput.autocomplete = "off";
  headerActions.appendChild(searchInput);

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

  const main = createHTMLElement(document, "main");
  main.className = "cm-main";

  const graphShell = createHTMLElement(document, "section");
  graphShell.className = "cm-graph-shell";
  graphShell.setAttribute("aria-label", "Citation graph");

  const graphSurface = createHTMLElement(document, "div");
  graphSurface.className = "cm-graph-surface";
  graphSurface.tabIndex = 0;
  graphSurface.dataset.totalNodes = String(snapshot.papers.length);
  graphSurface.dataset.matchingNodes = String(snapshot.papers.length);

  const emptyState = createHTMLElement(document, "div");
  emptyState.className = "cm-graph-empty-state";
  emptyState.appendChild(createTextElement(document, "h2", "Citation graph"));
  const emptyStateText = createTextElement(
    document,
    "p",
    "Citation relationships will appear here after citation data is loaded.",
  );
  emptyState.appendChild(emptyStateText);
  graphSurface.appendChild(emptyState);
  graphShell.appendChild(graphSurface);
  main.appendChild(graphShell);
  root.appendChild(main);
  mount.appendChild(root);

  let searchTimer: number | null = null;
  let searchGeneration = 0;

  const applySearch = async (): Promise<void> => {
    const generation = ++searchGeneration;
    const query = searchInput.value.trim();

    if (!query) {
      const allItemIDs = snapshot.papers.map((paper) => paper.itemID);
      searchStatus.textContent = "";
      graphSurface.dataset.matchingNodes = String(allItemIDs.length);
      emptyStateText.textContent =
        "Citation relationships will appear here after citation data is loaded.";
      dispatchSearchEvent(document, root, {
        query: "",
        matchingItemIDs: allItemIDs,
      });
      return;
    }

    searchStatus.textContent = "Searching…";
    const matchingItemIDs = await runZoteroSearch(query, snapshot);

    if (generation !== searchGeneration) {
      return;
    }

    graphSurface.dataset.matchingNodes = String(matchingItemIDs.length);
    searchStatus.textContent = `${formatCount(matchingItemIDs.length)} match${
      matchingItemIDs.length === 1 ? "" : "es"
    }`;
    emptyStateText.textContent =
      matchingItemIDs.length === 0
        ? "No papers match the current search."
        : `${formatCount(
            matchingItemIDs.length,
          )} matching papers will be highlighted in the graph.`;

    dispatchSearchEvent(document, root, {
      query,
      matchingItemIDs,
    });
  };

  const scheduleSearch = (): void => {
    if (searchTimer !== null) {
      document.defaultView?.clearTimeout(searchTimer);
    }

    searchTimer =
      document.defaultView?.setTimeout(() => {
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

  graphSurface.addEventListener("dblclick", () => {
    const matchingItemIDs = fallbackSearch(searchInput.value, snapshot.papers);

    if (matchingItemIDs.length === 1) {
      void options.onSelectPaper(matchingItemIDs[0]);
    }
  });

  return root;
}
