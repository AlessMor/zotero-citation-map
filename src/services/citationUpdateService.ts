import { config } from "../../package.json";
import type {
  CitationMetricRecord,
  CitationProviderPreference,
  CitationUpdateBatchResult,
  ProviderLookupFailure,
} from "../domain/citationTypes";
import { lookupCitationMetrics } from "../providers/registry";
import {
  cancelPendingCitationRequests,
  isCitationRequestCancellationRequested,
  resetCitationRequestCancellation,
} from "../providers/http";
import { extractWorkIdentifiers } from "./citationIdentifiers";
import {
  getCitationMetricRecord,
  saveCitationMetricFailure,
  saveCitationMetricRecord,
  shouldRefreshCitationMetrics,
} from "./citationMetricsStore";
import {
  getAutomaticUpdatesEnabled,
  getCacheDays,
  getProviderLabel,
  getProviderPreference,
} from "./citationPreferences";
import { refreshCitationColumns } from "./itemTreeColumnService";
import { refreshOpenCitationMapViews } from "./windowService";

interface UpdateOptions {
  force?: boolean;
  silent?: boolean;
  provider?: CitationProviderPreference;
}

let operationTail: Promise<void> = Promise.resolve();
let notifierID: string | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
const pendingItemIDs = new Set<number>();
interface UpdateProgressCard {
  hostWindow: Window;
  root: HTMLElement;
  label: HTMLElement;
  progressBar: HTMLElement;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const activeProgressCards = new Set<UpdateProgressCard>();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const previous = operationTail.catch(() => undefined);

  let release = (): void => undefined;
  const ticket = new Promise<void>((resolve) => {
    release = resolve;
  });

  operationTail = previous.then(() => ticket);
  await previous;

  try {
    return await task();
  } finally {
    release();
  }
}

function getRegularItems(items: Zotero.Item[]): Zotero.Item[] {
  return items.filter(
    (item) => Boolean(item) && item.isRegularItem?.() && !item.deleted,
  );
}

async function getWholeLibraryItems(): Promise<Zotero.Item[]> {
  const items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID);
  return getRegularItems(items as Zotero.Item[]);
}

function removeProgressCard(card: UpdateProgressCard): void {
  if (card.cleanupTimer !== null) {
    clearTimeout(card.cleanupTimer);
    card.cleanupTimer = null;
  }

  try {
    card.root.remove();
  } catch {
    // The host window may already be unloading.
  }
  activeProgressCards.delete(card);
}

function createHtmlElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tagName: K,
): HTMLElementTagNameMap[K] {
  return document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tagName,
  ) as HTMLElementTagNameMap[K];
}

function createProgressWindow(
  total: number,
  provider: CitationProviderPreference,
): UpdateProgressCard | null {
  const hostWindow = Zotero.getMainWindow() as Window | null;
  if (!hostWindow || hostWindow.closed) {
    return null;
  }

  try {
    const document = hostWindow.document;
    const root = createHtmlElement(document, "div");
    root.dataset.citationMapProgress = "true";
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    Object.assign(root.style, {
      position: "fixed",
      insetInlineEnd: "18px",
      bottom: "18px",
      zIndex: "2147483647",
      width: "min(380px, calc(100vw - 36px))",
      boxSizing: "border-box",
      padding: "12px 14px",
      border: "1px solid var(--fill-quinary, rgba(127, 127, 127, 0.35))",
      borderRadius: "9px",
      background: "var(--material-background, Canvas)",
      color: "var(--fill-primary, CanvasText)",
      boxShadow: "0 8px 28px rgba(0, 0, 0, 0.28)",
      font: "menu",
      pointerEvents: "none",
    });

    const heading = createHtmlElement(document, "div");
    heading.textContent = config.addonName;
    Object.assign(heading.style, {
      marginBottom: "5px",
      fontWeight: "600",
      fontSize: "13px",
    });

    const label = createHtmlElement(document, "div");
    label.textContent = `Updating citation data with ${getProviderLabel(provider)} (0/${total})`;
    Object.assign(label.style, {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontSize: "12px",
      opacity: "0.9",
    });

    const track = createHtmlElement(document, "div");
    Object.assign(track.style, {
      height: "4px",
      marginTop: "9px",
      overflow: "hidden",
      borderRadius: "999px",
      background: "var(--fill-quinary, rgba(127, 127, 127, 0.25))",
    });

    const progressBar = createHtmlElement(document, "div");
    Object.assign(progressBar.style, {
      width: "0%",
      height: "100%",
      borderRadius: "inherit",
      background: "var(--accent-blue, #4a90e2)",
      transition: "width 120ms ease-out",
    });

    track.appendChild(progressBar);
    root.append(heading, label, track);
    document.documentElement.appendChild(root);

    const card: UpdateProgressCard = {
      hostWindow,
      root,
      label,
      progressBar,
      cleanupTimer: null,
    };
    activeProgressCards.add(card);

    hostWindow.addEventListener("unload", () => removeProgressCard(card), {
      once: true,
    });
    return card;
  } catch (error) {
    Zotero.debug(
      `Citation Map: could not create in-window progress card: ${error}`,
    );
    return null;
  }
}

function updateProgress(
  progressCard: UpdateProgressCard | null,
  current: number,
  total: number,
  title: string,
): void {
  if (!progressCard || progressCard.hostWindow.closed) {
    return;
  }

  progressCard.label.textContent = `Updating ${current}/${total}: ${title}`;
  progressCard.progressBar.style.width = `${Math.round((current / Math.max(total, 1)) * 100)}%`;
}

function finishProgress(
  progressCard: UpdateProgressCard | null,
  result: CitationUpdateBatchResult,
): void {
  if (!progressCard || progressCard.hostWindow.closed) {
    return;
  }

  progressCard.label.textContent = [
    `${result.updated} updated`,
    `${result.cached} already current`,
    `${result.failed} failed`,
    `${result.skipped} skipped`,
  ].join(" · ");
  progressCard.progressBar.style.width = "100%";

  if (progressCard.cleanupTimer !== null) {
    clearTimeout(progressCard.cleanupTimer);
  }
  progressCard.cleanupTimer = setTimeout(
    () => removeProgressCard(progressCard),
    3000,
  );
}

function closeActiveProgressWindows(): void {
  for (const card of [...activeProgressCards]) {
    removeProgressCard(card);
  }
}

function addDays(date: Date, days: number): string {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function getNextRetryAt(
  failure: ProviderLookupFailure,
  previousFailureCount: number,
): string | null {
  const now = new Date();

  switch (failure.status) {
    case "no-identifier":
      return addDays(now, 30);

    case "not-found": {
      const delays = [7, 30, 90, 180];
      return addDays(
        now,
        delays[Math.min(previousFailureCount, delays.length - 1)],
      );
    }

    case "rate-limited":
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    case "network-error":
      return new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString();

    case "provider-error":
      return addDays(now, 1);
  }
}

async function updateOneItem(
  item: Zotero.Item,
  preference: CitationProviderPreference,
  force: boolean,
): Promise<"updated" | "cached" | "failed" | "skipped"> {
  if (shuttingDown || isCitationRequestCancellationRequested()) {
    return "skipped";
  }

  const libraryID = Number(item.libraryID);
  const itemKey = String(item.key);

  if (
    !force &&
    !shouldRefreshCitationMetrics(
      libraryID,
      itemKey,
      preference,
      getCacheDays(),
    )
  ) {
    return "cached";
  }

  const identifiers = extractWorkIdentifiers(item);
  const result = await lookupCitationMetrics(preference, identifiers);

  if (shuttingDown || isCitationRequestCancellationRequested()) {
    return "skipped";
  }

  if (result.status !== "success") {
    const existing = getCitationMetricRecord(libraryID, itemKey);

    await saveCitationMetricFailure(
      libraryID,
      itemKey,
      result.provider,
      result.status,
      result.message,
      getNextRetryAt(result, existing?.failureCount ?? 0),
    );

    Zotero.debug(
      `Citation Map: ${itemKey} failed via ${result.provider}: ${result.status} (${result.message})`,
    );
    return "failed";
  }

  const now = new Date().toISOString();
  const record: CitationMetricRecord = {
    libraryID,
    itemKey,
    provider: result.provider,
    providerWorkID: result.providerWorkID,
    matchedBy: result.matchedBy,
    doi: result.doi ?? identifiers.doi,
    title: result.title ?? identifiers.title,
    year: result.year ?? identifiers.year,
    authors: result.authors.length > 0 ? result.authors : identifiers.authors,
    citationCount: result.citationCount,
    citationCountProvider: result.citationCountProvider,
    referenceCount: result.referenceCount,
    referenceCountProvider: result.referenceCountProvider,
    resolvedReferenceCount: result.resolvedReferenceCount,
    references: result.references,
    fwci: result.fwci ?? null,
    citationPercentile: result.citationPercentile ?? null,
    isTop1Percent: result.isTop1Percent ?? null,
    isTop10Percent: result.isTop10Percent ?? null,
    citationCountsByYear: result.citationCountsByYear ?? [],
    citationsLastYear: result.citationsLastYear ?? null,
    citationVelocity: result.citationVelocity ?? null,
    citationAcceleration: result.citationAcceleration ?? null,
    influentialCitationCount: result.influentialCitationCount ?? null,
    isRetracted: result.isRetracted ?? null,
    openAccessStatus: result.openAccessStatus ?? null,
    isOpenAccess: result.isOpenAccess ?? null,
    publicationType: result.publicationType ?? null,
    status: "success",
    fetchedAt: now,
    lastAttemptAt: now,
    errorMessage: null,
    failureCount: 0,
    nextRetryAt: null,
  };

  await saveCitationMetricRecord(record);
  return "updated";
}

export function updateCitationMetricsForItems(
  items: Zotero.Item[],
  options: UpdateOptions = {},
): Promise<CitationUpdateBatchResult> {
  return runSerialized(async () => {
    const regularItems = getRegularItems(items);
    const preference = options.provider ?? getProviderPreference();
    const result: CitationUpdateBatchResult = {
      total: regularItems.length,
      updated: 0,
      cached: 0,
      failed: 0,
      skipped: items.length - regularItems.length,
    };

    if (regularItems.length === 0) {
      return result;
    }

    const progressWindow = options.silent
      ? null
      : createProgressWindow(regularItems.length, preference);

    for (let index = 0; index < regularItems.length; index += 1) {
      if (shuttingDown || isCitationRequestCancellationRequested()) {
        result.skipped += regularItems.length - index;
        break;
      }

      const item = regularItems[index];
      const title = String(
        item.getDisplayTitle?.() ?? item.getField("title") ?? item.key,
      );

      updateProgress(progressWindow, index + 1, regularItems.length, title);

      try {
        const status = await updateOneItem(
          item,
          preference,
          Boolean(options.force),
        );
        result[status] += 1;
      } catch (error) {
        result.failed += 1;
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }

      if ((index + 1) % 20 === 0 && !shuttingDown) {
        refreshCitationColumns();
        await delay(0);
      }
    }

    if (!shuttingDown) {
      refreshCitationColumns();
      await refreshOpenCitationMapViews().catch((error: unknown) => {
        Zotero.debug(`Citation Map: could not refresh an open graph: ${error}`);
      });
      finishProgress(progressWindow, result);
    } else if (progressWindow) {
      // unregisterAutomaticCitationUpdates() closes all tracked windows.
    }
    return result;
  });
}

export async function updateCitationMetricsForLibrary(
  options: UpdateOptions = {},
): Promise<CitationUpdateBatchResult> {
  const items = await getWholeLibraryItems();
  return updateCitationMetricsForItems(items, options);
}

async function flushPendingItemUpdates(): Promise<void> {
  pendingTimer = null;

  if (
    shuttingDown ||
    !getAutomaticUpdatesEnabled() ||
    pendingItemIDs.size === 0
  ) {
    pendingItemIDs.clear();
    return;
  }

  const ids = [...pendingItemIDs];
  pendingItemIDs.clear();

  const items = ids
    .map((id) => Zotero.Items.get(id))
    .filter((item): item is Zotero.Item => Boolean(item));

  await updateCitationMetricsForItems(items, {
    force: true,
    silent: true,
  });
}

function queueChangedItems(ids: Array<number | string>): void {
  for (const id of ids) {
    const itemID = Number(id);
    if (Number.isFinite(itemID)) {
      pendingItemIDs.add(itemID);
    }
  }

  if (pendingTimer) {
    clearTimeout(pendingTimer);
  }

  pendingTimer = setTimeout(() => {
    void flushPendingItemUpdates();
  }, 2500);
}

export function scheduleAutomaticLibraryUpdate(delayMilliseconds = 500): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
  }

  startupTimer = setTimeout(() => {
    startupTimer = null;

    if (shuttingDown || !getAutomaticUpdatesEnabled()) {
      return;
    }

    void updateCitationMetricsForLibrary({
      force: false,
      silent: true,
    }).catch((error: unknown) => {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  }, delayMilliseconds);
}

export function registerAutomaticCitationUpdates(): void {
  if (notifierID) {
    return;
  }

  shuttingDown = false;
  resetCitationRequestCancellation();

  notifierID = Zotero.Notifier.registerObserver(
    {
      notify: (event: string, type: string, ids: Array<number | string>) => {
        if (
          type === "item" &&
          (event === "add" || event === "modify") &&
          getAutomaticUpdatesEnabled()
        ) {
          queueChangedItems(ids);
        }
      },
    },
    ["item"],
    "citation-map-metrics",
  );

  scheduleAutomaticLibraryUpdate(8000);
}

export async function waitForCitationUpdates(
  timeoutMilliseconds = 4000,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let completed = false;

  try {
    await Promise.race([
      operationTail
        .catch(() => undefined)
        .then(() => {
          completed = true;
        }),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }

  if (!completed) {
    Zotero.debug(
      `Citation Map: citation-update shutdown drain exceeded ${timeoutMilliseconds} ms`,
    );
  }
}

export function unregisterAutomaticCitationUpdates(): void {
  shuttingDown = true;
  cancelPendingCitationRequests();
  closeActiveProgressWindows();
  if (notifierID) {
    Zotero.Notifier.unregisterObserver(notifierID);
    notifierID = null;
  }

  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  pendingItemIDs.clear();
}
