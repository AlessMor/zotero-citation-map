export interface CitationUpdateCompletedEvent {
  refreshGraph: boolean;
  refreshColumns: boolean;
  refreshItemPanes: boolean;
}

export type CitationUpdateCompletedListener = (
  event: CitationUpdateCompletedEvent,
) => void | Promise<void>;

const listeners = new Set<CitationUpdateCompletedListener>();
let publicationBatchDepth = 0;
let deferredEvent: CitationUpdateCompletedEvent | null = null;

function mergeEvents(
  previous: CitationUpdateCompletedEvent | null,
  next: CitationUpdateCompletedEvent,
): CitationUpdateCompletedEvent {
  return {
    refreshGraph: Boolean(previous?.refreshGraph || next.refreshGraph),
    refreshColumns: Boolean(previous?.refreshColumns || next.refreshColumns),
    refreshItemPanes: Boolean(
      previous?.refreshItemPanes || next.refreshItemPanes,
    ),
  };
}

function notifyListeners(event: CitationUpdateCompletedEvent): void {
  for (const listener of listeners) {
    void Promise.resolve(listener(event)).catch((error: unknown) => {
      Zotero.debug(
        `Citation Map: update-completed listener failed: ${String(error)}`,
      );
    });
  }
}

export function subscribeToCitationUpdates(
  listener: CitationUpdateCompletedListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Hold presentation refreshes while a multi-stage update mutates the metric
 * store. Nested batches are supported. The final release emits one merged
 * refresh request, so columns and panes read the same completed snapshot.
 */
export function beginCitationUpdatePublicationBatch(): void {
  publicationBatchDepth += 1;
}

export function endCitationUpdatePublicationBatch(
  finalEvent?: CitationUpdateCompletedEvent,
): void {
  if (publicationBatchDepth <= 0) {
    if (finalEvent) notifyListeners(finalEvent);
    return;
  }
  if (finalEvent) deferredEvent = mergeEvents(deferredEvent, finalEvent);
  publicationBatchDepth -= 1;
  if (publicationBatchDepth > 0 || !deferredEvent) return;
  const event = deferredEvent;
  deferredEvent = null;
  notifyListeners(event);
}

export function publishCitationUpdateCompleted(
  event: CitationUpdateCompletedEvent,
): void {
  if (publicationBatchDepth > 0) {
    deferredEvent = mergeEvents(deferredEvent, event);
    return;
  }
  notifyListeners(event);
}
