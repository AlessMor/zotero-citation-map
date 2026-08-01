import { positiveInteger } from "../domain/valueNormalization";
import { getSelectedCitationUpdateLibraryIDs } from "./citationLibraryService";
import { registerUpdateCancellationHandler } from "./updateProgressService";
import {
  getAutomaticUpdatesEnabled,
  getCheckStaleOnStartupEnabled,
  getUpdateModifiedItemsEnabled,
  getUpdateNewItemsEnabled,
} from "./citationPreferences";
import {
  cancelActiveCitationUpdate,
  startCitationUpdateRuntime,
  stopCitationUpdateRuntime,
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

async function updateLibraryGroups(groups: Zotero.Item[][]): Promise<void> {
  for (const items of groups) {
    if (shuttingDown || !items.length) {
      break;
    }
    await updateCitationDataForItems(items, {
      silent: false,
    });
  }
}

async function updateSelectedLibrariesAtStartup(): Promise<void> {
  for (const libraryID of getSelectedCitationUpdateLibraryIDs()) {
    if (shuttingDown) break;
    const items = regularItems(
      (await Zotero.Items.getAll(libraryID)) as Zotero.Item[],
    );
    if (!items.length) continue;
    await updateCitationDataForItems(items, {
      silent: false,
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
    const selectedLibraryIDs = new Set(getSelectedCitationUpdateLibraryIDs());
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
  startCitationUpdateRuntime();
  if (notifierID) return;
  unregisterCancellationHandler = registerUpdateCancellationHandler(() => {
    cancellationGeneration += 1;
    cancelActiveCitationUpdate();
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

  stopCitationUpdateRuntime();
}

export async function waitForCitationUpdates(
  timeoutMs = 5000,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const completed = Promise.allSettled([
    automaticUpdateTail,
    waitForCoreCitationUpdates(timeoutMs),
  ]).then(() => true as const);
  const result = await Promise.race([completed, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}
