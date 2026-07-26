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

let notifierID: string | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
const pendingItemIDs = new Set<number>();
let shuttingDown = false;
let unregisterCancellationHandler: (() => void) | null = null;

function reportBackgroundError(context: string, error: unknown): void {
  const detail = error instanceof Error ? error : new Error(String(error));
  Zotero.logError(
    new Error(`Citation Map: ${context} failed: ${detail.message}`, {
      cause: detail,
    }),
  );
}

function startVisibleUpdate(
  context: string,
  operation: () => Promise<unknown>,
): void {
  if (shuttingDown) return;
  // Closing a previous progress window cancels its provider requests. Every new
  // user-visible operation starts with a clean cancellation state.
  resetCitationRequestCancellation();
  void operation().catch((error: unknown) =>
    reportBackgroundError(context, error),
  );
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
