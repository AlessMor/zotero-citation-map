import type { CitationProviderID } from "../domain/citationTypes";
import { publishCitationUpdateCompleted } from "./citationUpdateEvents";

export type PublishedRelationshipDirection = "references" | "cited-by";
export type RelationshipPublicationPhase =
  | "refresh-started"
  | "membership-published"
  | "metadata-published"
  | "refresh-finished";

export interface RelationshipPublicationEvent {
  libraryID: number;
  subjectItemKey: string;
  direction: PublishedRelationshipDirection;
  phase: RelationshipPublicationPhase;
  reportedCount: number | null;
  reportedCountProvider: CitationProviderID | null;
  identifiedCount: number;
}

export interface RelationshipPublicationState {
  active: boolean;
  membershipPublished: boolean;
  reportedCount: number | null;
  reportedCountProvider: CitationProviderID | null;
  identifiedCount: number;
}

type RelationshipPublicationListener = (
  event: RelationshipPublicationEvent,
) => void | Promise<void>;

interface DeferredRelationshipPublication {
  content: RelationshipPublicationEvent | null;
  finished: RelationshipPublicationEvent | null;
}

const listeners = new Set<RelationshipPublicationListener>();
const states = new Map<string, RelationshipPublicationState>();
const deferredPublications = new Map<string, DeferredRelationshipPublication>();
let publicationBatchDepth = 0;

function publicationKey(
  libraryID: number,
  subjectItemKey: string,
  direction: PublishedRelationshipDirection,
): string {
  return `${libraryID}:${subjectItemKey.toLocaleUpperCase()}:${direction}`;
}

function notifyListeners(event: RelationshipPublicationEvent): void {
  for (const listener of [...listeners]) {
    void Promise.resolve(listener(event)).catch((error: unknown) => {
      Zotero.debug(
        `Citation Map: relationship-publication listener failed: ${String(error)}`,
      );
    });
  }
}

function deferListenerPublication(
  key: string,
  event: RelationshipPublicationEvent,
): void {
  const deferred = deferredPublications.get(key) ?? {
    content: null,
    finished: null,
  };
  if (
    event.phase === "membership-published" ||
    event.phase === "metadata-published"
  ) {
    // Metadata publication supersedes membership publication because the
    // relationship store and scalar counts are both final at that point.
    deferred.content = event;
  } else if (event.phase === "refresh-finished") {
    deferred.finished = event;
  }
  deferredPublications.set(key, deferred);
}

function requestPresentationRefresh(event: RelationshipPublicationEvent): void {
  // The initiating view already marks itself as updating, and graph listeners
  // receive the publication directly. Re-rendering every item pane and item
  // tree at refresh start is expensive for large relationship lists and
  // exposes no new persisted data.
  if (event.phase === "refresh-started") return;

  // Summary hydration changes card metadata only. Counts, membership and item
  // tree properties were committed earlier, so a global column refresh and a
  // full refresh of every open item pane are both unnecessary. Item panes and
  // graph views subscribe to the targeted relationship publication directly.
  if (event.phase === "metadata-published") return;

  publishCitationUpdateCompleted({
    refreshGraph: false,
    refreshColumns: event.phase === "membership-published",
    refreshItemPanes: true,
  });
}

export function getRelationshipPublicationState(
  libraryID: number,
  subjectItemKey: string,
  direction: PublishedRelationshipDirection,
): RelationshipPublicationState | null {
  const state = states.get(
    publicationKey(libraryID, subjectItemKey, direction),
  );
  return state ? { ...state } : null;
}

export function subscribeRelationshipPublications(
  listener: RelationshipPublicationListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Defer relationship listeners while a multi-stage item update is in flight.
 * Store state continues to advance, but graph and pane listeners receive only
 * the final content publication and completion event for each relationship.
 */
export function beginRelationshipPublicationBatch(): void {
  publicationBatchDepth += 1;
}

export function endRelationshipPublicationBatch(): void {
  if (publicationBatchDepth <= 0) return;
  publicationBatchDepth -= 1;
  if (publicationBatchDepth > 0) return;
  const publications = [...deferredPublications.values()];
  deferredPublications.clear();
  for (const publication of publications) {
    if (publication.content) notifyListeners(publication.content);
    if (publication.finished) notifyListeners(publication.finished);
  }
}

export function publishRelationshipPublication(
  event: RelationshipPublicationEvent,
): void {
  const key = publicationKey(
    event.libraryID,
    event.subjectItemKey,
    event.direction,
  );
  const previous = states.get(key);
  let removeStateAfterPublish = false;
  if (event.phase === "refresh-started") {
    states.set(key, {
      active: true,
      membershipPublished: false,
      reportedCount: previous?.reportedCount ?? null,
      reportedCountProvider: previous?.reportedCountProvider ?? null,
      identifiedCount: previous?.identifiedCount ?? 0,
    });
  } else if (event.phase === "membership-published") {
    states.set(key, {
      active: previous?.active ?? false,
      membershipPublished: true,
      reportedCount: event.reportedCount,
      reportedCountProvider: event.reportedCountProvider,
      identifiedCount: event.identifiedCount,
    });
  } else if (event.phase === "metadata-published") {
    states.set(key, {
      active: previous?.active ?? false,
      membershipPublished: previous?.membershipPublished ?? true,
      reportedCount: event.reportedCount ?? previous?.reportedCount ?? null,
      reportedCountProvider:
        event.reportedCountProvider ?? previous?.reportedCountProvider ?? null,
      identifiedCount: Math.max(
        event.identifiedCount,
        previous?.identifiedCount ?? 0,
      ),
    });
  } else {
    states.set(key, {
      active: false,
      membershipPublished: previous?.membershipPublished ?? false,
      reportedCount: event.reportedCount ?? previous?.reportedCount ?? null,
      reportedCountProvider:
        event.reportedCountProvider ?? previous?.reportedCountProvider ?? null,
      identifiedCount: Math.max(
        event.identifiedCount,
        previous?.identifiedCount ?? 0,
      ),
    });
    removeStateAfterPublish = true;
  }

  if (
    event.phase !== "refresh-started" &&
    event.phase !== "refresh-finished" &&
    states.get(key)?.active !== true
  ) {
    removeStateAfterPublish = true;
  }

  requestPresentationRefresh(event);
  if (publicationBatchDepth > 0) {
    deferListenerPublication(key, event);
  } else {
    notifyListeners(event);
  }
  if (removeStateAfterPublish) states.delete(key);
}
