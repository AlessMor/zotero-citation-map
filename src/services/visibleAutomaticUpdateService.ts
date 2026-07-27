import { resetCitationRequestCancellation } from "../providers/http";
import { registerUpdateCancellationHandler } from "./updateProgressService";
import {
  getAutomaticUpdatesEnabled,
  getCheckStaleOnStartupEnabled,
  getUpdateModifiedItemsEnabled,
  getUpdateNewItemsEnabled,
} from "./citationPreferences";
import {
  unregisterAutomaticCitationUpdates as unregisterCoreAutomaticCitationUpdates,
  updateCitationDataForItems,
  updateWholeLibraryCitationData,
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

function schedulePendingItems(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (shuttingDown) return;
    const ids = [...pendingItemIDs];
    pendingItemIDs.clear();
    const items = ids
      .map((id) => Zotero.Items.get(id))
      .filter((item): item is Zotero.Item => Boolean(item));
    if (!items.length) return;
    startVisibleUpdate("automatic update for modified items", () =>
      updateCitationDataForItems(items, {
        silent: false,
        includeRelationships: false,
      }),
    );
  }, 1200);
}

/**
 * Register automatic updates without any silent execution path. Zotero item
 * notifications are coalesced into one visible update, and the startup stale
 * item sweep also uses the normal cancellable progress window.
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
        updateWholeLibraryCitationData({
          silent: false,
          includeRelationships: false,
        }),
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
