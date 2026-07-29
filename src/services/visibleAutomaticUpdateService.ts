import {
  isCitationRequestCancellationRequested,
  resetCitationRequestCancellation,
} from "../providers/http";
import { getAvailableCitationLibraries } from "./citationLibraryService";
import { registerUpdateCancellationHandler } from "./updateProgressService";
import {
  getAutomaticUpdatesEnabled,
  getCheckStaleOnStartupEnabled,
  getUpdateLibraryIDs,
  getUpdateModifiedItemsEnabled,
  getUpdateNewItemsEnabled,
} from "./citationPreferences";
import {
  unregisterAutomaticCitationUpdates as unregisterCoreAutomaticCitationUpdates,
  updateCitationDataForItems,
  waitForCitationUpdates as waitForCoreCitationUpdates,
} from "./citationUpdateService";

const CORE_IDLE_POLL_MS = 1000;

let notifierID: string | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
const pendingItemIDs = new Set<number>();
let shuttingDown = false;
let unregisterCancellationHandler: (() => void) | null = null;
let cancellationGeneration = 0;
let automaticUpdateTail: Promise<void> = Promise.resolve();

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function reportBackgroundError(context: string, error: unknown): void {
  const detail = error instanceof Error ? error : new Error(String(error));
  Zotero.logError(
    new Error(`Citation Map: ${context} failed: ${detail.message}`, {
      cause: detail,
    }),
  );
}

async function waitUntilCoreUpdateIsIdle(generation: number): Promise<boolean> {
  while (!shuttingDown && generation === cancellationGeneration) {
    if (await waitForCoreCitationUpdates(CORE_IDLE_POLL_MS)) return true;
  }
  return false;
}

function startVisibleUpdate(
  context: string,
  operation: () => Promise<unknown>,
): void {
  if (shuttingDown) return;
  const generation = cancellationGeneration;
  const scheduled = automaticUpdateTail
    .catch(() => undefined)
    .then(async () => {
      if (!(await waitUntilCoreUpdateIsIdle(generation))) return;
      if (shuttingDown || generation !== cancellationGeneration) return;

      // Reset cancellation only when this operation is actually about to start.
      // Resetting while another operation is draining allows an older queued task
      // to reopen the progress window after the user has closed it.
      resetCitationRequestCancellation();
      await operation();
    });
  automaticUpdateTail = scheduled.catch((error: unknown) => {
    reportBackgroundError(context, error);
  });
}

function regularItems(
  items: Array<Zotero.Item | null | undefined>,
): Zotero.Item[] {
  return items.filter((item): item is Zotero.Item =>
    Boolean(item?.isRegularItem?.() && !item.deleted),
  );
}

function groupItemsByLibrary(items: Zotero.Item[]): Zotero.Item[][] {
  const groups = new Map<number, Zotero.Item[]>();
  for (const item of items) {
    const libraryID = positiveInteger(item.libraryID);
    if (!libraryID) continue;
    const group = groups.get(libraryID) ?? [];
    group.push(item);
    groups.set(libraryID, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, group]) => group);
}

function selectedUpdateLibraryIDs(): number[] {
  const available = new Set(
    getAvailableCitationLibraries().map((library) => library.libraryID),
  );
  return getUpdateLibraryIDs().filter((libraryID) => available.has(libraryID));
}

async function updateLibraryGroups(groups: Zotero.Item[][]): Promise<void> {
  for (const items of groups) {
    if (
      shuttingDown ||
      isCitationRequestCancellationRequested() ||
      !items.length
    ) {
      break;
    }
    await updateCitationDataForItems(items, {
      silent: false,
      includeRelationships: false,
    });
  }
}

async function updateSelectedLibrariesAtStartup(): Promise<void> {
  for (const libraryID of selectedUpdateLibraryIDs()) {
    if (shuttingDown || isCitationRequestCancellationRequested()) break;
    const items = regularItems(
      (await Zotero.Items.getAll(libraryID)) as Zotero.Item[],
    );
    if (!items.length) continue;
    await updateCitationDataForItems(items, {
      silent: false,
      includeRelationships: false,
    });
  }
}

function schedulePendingItems(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (shuttingDown) return;
    const ids = [...pendingItemIDs];
    pendingItemIDs.clear();
    const selectedLibraryIDs = new Set(selectedUpdateLibraryIDs());
    if (!selectedLibraryIDs.size) return;
    const items = regularItems(ids.map((id) => Zotero.Items.get(id))).filter(
      (item) => selectedLibraryIDs.has(Number(item.libraryID)),
    );
    if (!items.length) return;
    const groups = groupItemsByLibrary(items);
    startVisibleUpdate("automatic update for modified items", () =>
      updateLibraryGroups(groups),
    );
  }, 1200);
}

/**
 * Register automatic updates without any silent execution path. Zotero item
 * notifications are coalesced and then processed one library at a time. All
 * automatic work is limited to the libraries selected in Citation Map
 * settings. Each library is processed separately through the normal cancellable
 * progress window.
 */
export function registerAutomaticCitationUpdates(): void {
  shuttingDown = false;
  resetCitationRequestCancellation();
  if (notifierID) return;
  unregisterCancellationHandler = registerUpdateCancellationHandler(() => {
    cancellationGeneration += 1;
    if (pendingTimer) clearTimeout(pendingTimer);
    if (startupTimer) clearTimeout(startupTimer);
    pendingTimer = null;
    startupTimer = null;
    pendingItemIDs.clear();
  });

  const observer = {
    notify: async (
      event: string,
      type: string,
      ids: Array<number | string>,
    ): Promise<void> => {
      if (type !== "item" || !getAutomaticUpdatesEnabled()) return;
      if (event === "add" && !getUpdateNewItemsEnabled()) return;
      if (event === "modify" && !getUpdateModifiedItemsEnabled()) return;
      if (event !== "add" && event !== "modify") return;
      for (const id of ids) pendingItemIDs.add(Number(id));
      schedulePendingItems();
    },
  };

  notifierID = Zotero.Notifier.registerObserver(
    observer,
    ["item"],
    "citation-map-visible-updates",
  );

  if (getAutomaticUpdatesEnabled() && getCheckStaleOnStartupEnabled()) {
    startupTimer = setTimeout(() => {
      startupTimer = null;
      startVisibleUpdate("startup stale-item refresh", () =>
        updateSelectedLibrariesAtStartup(),
      );
    }, 30000);
  }
}

export function unregisterAutomaticCitationUpdates(): void {
  shuttingDown = true;
  cancellationGeneration += 1;
  if (notifierID) {
    Zotero.Notifier.unregisterObserver(notifierID);
    notifierID = null;
  }
  if (startupTimer) clearTimeout(startupTimer);
  if (pendingTimer) clearTimeout(pendingTimer);
  startupTimer = null;
  pendingTimer = null;
  pendingItemIDs.clear();
  unregisterCancellationHandler?.();
  unregisterCancellationHandler = null;

  // Reuse the core shutdown path for request cancellation and progress cleanup.
  unregisterCoreAutomaticCitationUpdates();
}

export function waitForCitationUpdates(timeoutMs?: number): Promise<boolean> {
  return waitForCoreCitationUpdates(timeoutMs);
}
