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
  getExactTitleFallbackEnabled,
  getProviderLabel,
  getProviderPreference,
  getUpdateNewItemsEnabled,
} from "./citationPreferences";
import { refreshCitationColumns } from "./itemTreeColumnService";
import { refreshCitationItemPanes } from "./itemPaneService";
import { refreshOpenCitationMapViews } from "./windowService";

interface UpdateOptions {
  force?: boolean;
  silent?: boolean;
  provider?: CitationProviderPreference;
}

type UpdateOutcome = "updated" | "cached" | "failed" | "skipped";

const ITEM_UPDATE_CONCURRENCY = 3;
const SHUTDOWN_WAIT_TIMEOUT_MS = 5000;

let operationTail: Promise<void> = Promise.resolve();
let notifierID: string | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
const pendingItemIDs = new Set<number>();

interface ProgressCard {
  root: HTMLElement;
  label: HTMLElement;
  bar: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
}
const progressCards = new Set<ProgressCard>();

function backgroundError(context: string, error: unknown): Error {
  if (error instanceof Error) return error;
  const detail = error === undefined ? "undefined rejection" : String(error);
  return new Error(`Citation Map: ${context} failed (${detail})`);
}

function runBackgroundUpdate(
  context: string,
  operation: Promise<unknown>,
): void {
  void operation.catch((error: unknown) => {
    Zotero.logError(backgroundError(context, error));
  });
}

function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const previous = operationTail.catch(() => undefined);
  let release = (): void => undefined;
  const ticket = new Promise<void>((resolve) => {
    release = resolve;
  });
  operationTail = previous.then(() => ticket);
  return previous.then(task).finally(release);
}

function regularItems(items: Zotero.Item[]): Zotero.Item[] {
  return items.filter(
    (item) => Boolean(item) && item.isRegularItem?.() && !item.deleted,
  );
}

async function wholeLibraryItems(): Promise<Zotero.Item[]> {
  return regularItems(
    (await Zotero.Items.getAll(
      Zotero.Libraries.userLibraryID,
    )) as Zotero.Item[],
  );
}

function itemNeedsRefresh(
  item: Zotero.Item,
  provider: CitationProviderPreference,
): boolean {
  return shouldRefreshCitationMetrics(
    Number(item.libraryID),
    String(item.key),
    provider,
    getCacheDays(),
  );
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
): HTMLElementTagNameMap[K] {
  return document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElementTagNameMap[K];
}

function createProgress(
  total: number,
  provider: CitationProviderPreference,
): ProgressCard | null {
  const win = Zotero.getMainWindow() as Window | null;
  if (!win || win.closed) return null;
  try {
    const document = win.document;
    const mount =
      document.getElementById("zotero-pane") ??
      document.getElementById("main-window") ??
      document.documentElement;
    const root = createElement(document, "div");
    root.className = "citation-map-progress";
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    const heading = createElement(document, "strong");
    heading.textContent = config.addonName;
    const label = createElement(document, "div");
    label.textContent = `Updating with ${getProviderLabel(provider)} (0/${total})`;
    const track = createElement(document, "div");
    track.className = "citation-map-progress-track";
    const bar = createElement(document, "div");
    bar.className = "citation-map-progress-bar";
    track.appendChild(bar);
    root.append(heading, label, track);
    mount.appendChild(root);
    const card = { root, label, bar, timer: null };
    progressCards.add(card);
    return card;
  } catch {
    return null;
  }
}

function updateProgress(
  card: ProgressCard | null,
  current: number,
  total: number,
  title: string,
): void {
  if (!card || shuttingDown) return;
  card.label.textContent = `Updating ${current}/${total}: ${title}`;
  card.bar.style.width = `${Math.round((current / Math.max(1, total)) * 100)}%`;
}

function finishProgress(
  card: ProgressCard | null,
  result: CitationUpdateBatchResult,
): void {
  if (!card || shuttingDown) return;
  card.label.textContent = `${result.updated} updated · ${result.cached} current · ${result.failed} failed · ${result.skipped} skipped`;
  card.bar.style.width = "100%";
  card.timer = setTimeout(() => {
    card.root.remove();
    progressCards.delete(card);
  }, 3500);
}

function nextRetryAt(
  failure: ProviderLookupFailure,
  previousFailureCount: number,
): string | null {
  const now = Date.now();
  const day = 86400000;
  switch (failure.status) {
    case "no-identifier":
      return new Date(now + 30 * day).toISOString();
    case "ambiguous-match":
      return null;
    case "not-found": {
      const delays = [7, 30, 90, 180];
      return new Date(
        now + delays[Math.min(previousFailureCount, delays.length - 1)] * day,
      ).toISOString();
    }
    case "rate-limited":
      return new Date(now + 60 * 60 * 1000).toISOString();
    case "network-error":
      return new Date(now + 6 * 60 * 60 * 1000).toISOString();
    case "provider-error":
      return new Date(now + day).toISOString();
  }
}

async function updateOneItem(
  item: Zotero.Item,
  preference: CitationProviderPreference,
  force: boolean,
): Promise<UpdateOutcome> {
  if (shuttingDown || isCitationRequestCancellationRequested()) {
    return "skipped";
  }
  const libraryID = Number(item.libraryID);
  const itemKey = String(item.key);
  if (!force && !itemNeedsRefresh(item, preference)) return "cached";

  const previous = getCitationMetricRecord(libraryID, itemKey);
  const extracted = extractWorkIdentifiers(item);
  // A user-confirmed fallback match may supply a DOI that is intentionally
  // kept in Citation Map's private cache rather than written into the Zotero
  // item. Reuse it for future refreshes.
  const identifiers = {
    ...extracted,
    doi: extracted.doi ?? (previous?.matchConfirmed ? previous.doi : null),
  };
  const result = await lookupCitationMetrics(
    preference,
    identifiers,
    getExactTitleFallbackEnabled(),
    force,
  );
  if (shuttingDown || isCitationRequestCancellationRequested()) {
    return "skipped";
  }
  if (result.status !== "success") {
    await saveCitationMetricFailure(
      libraryID,
      itemKey,
      result.provider,
      result.status,
      result.message,
      nextRetryAt(result, previous?.failureCount ?? 0),
      result.candidates ?? [],
    );
    return "failed";
  }
  const now = new Date().toISOString();
  // DOI and unique non-contradictory exact-title matches are accepted
  // automatically. Exact fallback identifiers remain visible as provisional
  // until the user confirms them in the item pane.
  const sameConfirmedIdentity = Boolean(
    previous?.matchConfirmed &&
    ((previous.providerWorkID &&
      previous.providerWorkID === result.providerWorkID) ||
      (previous.doi && previous.doi === result.doi)),
  );
  const matchConfirmed =
    result.matchedBy === "doi" ||
    result.matchedBy === "title" ||
    sameConfirmedIdentity;
  const record: CitationMetricRecord = {
    libraryID,
    itemKey,
    provider: result.provider,
    providerWorkID: result.providerWorkID,
    matchedBy: result.matchedBy,
    matchConfidence: result.matchConfidence,
    matchConfirmed,
    doi: result.doi ?? identifiers.doi,
    title: result.title ?? identifiers.title,
    normalizedTitle: identifiers.normalizedTitle,
    year: result.year ?? identifiers.year,
    authors: result.authors.length ? result.authors : identifiers.authors,
    sourceTitle: result.sourceTitle ?? identifiers.sourceTitle,
    abstract: result.abstract,
    citationCount: result.citationCount,
    citationCountProvider: result.citationCountProvider,
    referenceCount: result.referenceCount,
    referenceCountProvider: result.referenceCountProvider,
    resolvedReferenceCount: result.resolvedReferenceCount,
    references: result.references,
    matchCandidates: [],
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
    sourceMetrics: result.sourceMetrics ?? null,
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

async function runUpdate(
  items: Zotero.Item[],
  options: UpdateOptions = {},
): Promise<CitationUpdateBatchResult> {
  const selected = regularItems(items);
  const provider = options.provider ?? getProviderPreference();
  const force = Boolean(options.force);
  const result: CitationUpdateBatchResult = {
    total: selected.length,
    updated: 0,
    cached: 0,
    failed: 0,
    skipped: 0,
  };

  if (shuttingDown || isCitationRequestCancellationRequested()) {
    result.skipped = selected.length;
    return result;
  }

  const pending = force
    ? selected
    : selected.filter((item) => itemNeedsRefresh(item, provider));
  result.cached = selected.length - pending.length;
  const progress = options.silent
    ? null
    : createProgress(pending.length, provider);

  let nextIndex = 0;
  let completed = 0;
  const worker = async (): Promise<void> => {
    while (!shuttingDown && !isCitationRequestCancellationRequested()) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= pending.length) return;
      const item = pending[index];
      let outcome: UpdateOutcome;
      try {
        outcome = await updateOneItem(item, provider, force);
      } catch (error) {
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
        outcome = shuttingDown ? "skipped" : "failed";
      }
      result[outcome] += 1;
      completed += 1;
      updateProgress(
        progress,
        completed,
        pending.length,
        String(item.getField("title") ?? "Untitled"),
      );
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(ITEM_UPDATE_CONCURRENCY, pending.length) },
      () => worker(),
    ),
  );

  const accounted =
    result.updated + result.cached + result.failed + result.skipped;
  if (accounted < selected.length)
    result.skipped += selected.length - accounted;

  if (!shuttingDown && !isCitationRequestCancellationRequested()) {
    refreshCitationColumns();
    refreshCitationItemPanes();
    await refreshOpenCitationMapViews();
    finishProgress(progress, result);
  }
  return result;
}

export function updateCitationDataForItems(
  items: Zotero.Item[],
  options: UpdateOptions = {},
): Promise<CitationUpdateBatchResult> {
  return runSerialized(() => runUpdate(items, options));
}

export async function updateWholeLibraryCitationData(
  options: UpdateOptions = {},
): Promise<CitationUpdateBatchResult> {
  if (shuttingDown) {
    return {
      total: 0,
      updated: 0,
      cached: 0,
      failed: 0,
      skipped: 0,
    };
  }
  return updateCitationDataForItems(await wholeLibraryItems(), options);
}

function schedulePendingItems(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const ids = [...pendingItemIDs];
    pendingItemIDs.clear();
    const items = ids
      .map((id) => Zotero.Items.get(id))
      .filter((item): item is Zotero.Item => Boolean(item));
    if (items.length) {
      runBackgroundUpdate(
        "automatic update for modified items",
        updateCitationDataForItems(items, { silent: true }),
      );
    }
  }, 1200);
}

export function registerAutomaticCitationUpdates(): void {
  shuttingDown = false;
  resetCitationRequestCancellation();
  if (notifierID) return;
  const observer = {
    notify: async (
      event: string,
      type: string,
      ids: Array<number | string>,
    ): Promise<void> => {
      if (
        type !== "item" ||
        !getAutomaticUpdatesEnabled() ||
        (event === "add" && !getUpdateNewItemsEnabled())
      ) {
        return;
      }
      if (event !== "add" && event !== "modify") return;
      for (const id of ids) pendingItemIDs.add(Number(id));
      schedulePendingItems();
    },
  };
  notifierID = Zotero.Notifier.registerObserver(
    observer,
    ["item"],
    "citation-map-updates",
  );
  if (getAutomaticUpdatesEnabled()) {
    startupTimer = setTimeout(() => {
      startupTimer = null;
      runBackgroundUpdate(
        "startup stale-item refresh",
        updateWholeLibraryCitationData({ silent: true }),
      );
    }, 4500);
  }
}

export function unregisterAutomaticCitationUpdates(): void {
  shuttingDown = true;
  cancelPendingCitationRequests();
  if (notifierID) {
    Zotero.Notifier.unregisterObserver(notifierID);
    notifierID = null;
  }
  if (startupTimer) clearTimeout(startupTimer);
  if (pendingTimer) clearTimeout(pendingTimer);
  startupTimer = null;
  pendingTimer = null;
  pendingItemIDs.clear();
  for (const card of progressCards) {
    if (card.timer) clearTimeout(card.timer);
    card.root.remove();
  }
  progressCards.clear();
}

export async function waitForCitationUpdates(
  timeoutMs = SHUTDOWN_WAIT_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const completed = operationTail.then(
    () => true as const,
    () => true as const,
  );
  const result = await Promise.race([completed, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}
