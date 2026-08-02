import type {
  CitationProviderID,
  RelatedWorkMetadata,
} from "../domain/citationTypes";
import type {
  PreparedRelationshipProviderSnapshot,
  RelationshipDirection,
  RelationshipProviderSnapshot,
  SelectedRelationshipMembership,
} from "../providers/relationshipPolicy";
import { mergeRelatedWorkMetadata } from "../domain/relatedWorkMetadata";
import {
  enrichIdentifiedRelationshipWorks,
  partitionRelationshipCandidates,
  resolveSparseCandidatesAgainstIdentified,
} from "./relationshipIdentityService";

function prepareInitialSnapshot(
  snapshot: RelationshipProviderSnapshot,
): PreparedRelationshipProviderSnapshot {
  const partition = partitionRelationshipCandidates(snapshot.works);
  return {
    ...snapshot,
    rawRetrievedCount: snapshot.works.length,
    identifiedWorks: enrichIdentifiedRelationshipWorks(
      partition.identified,
      partition.unresolved,
      mergeRelatedWorkMetadata,
    ),
    unresolvedWorks: partition.unresolved,
  };
}

/**
 * Resolve sparse provider rows only against papers already admitted by a stable
 * identifier somewhere in the same update. Sparse rows never become members.
 */
export function prepareRelationshipSnapshots(
  snapshots: RelationshipProviderSnapshot[],
  mergeLists: (...groups: RelatedWorkMetadata[][]) => RelatedWorkMetadata[],
): PreparedRelationshipProviderSnapshot[] {
  const prepared = snapshots.map(prepareInitialSnapshot);
  if (prepared.length === 1) {
    const snapshot = prepared[0];
    const identifiedWorks = mergeLists(snapshot.identifiedWorks);
    if (snapshot.unresolvedWorks.length === 0) {
      return [{ ...snapshot, identifiedWorks }];
    }
    const promoted = resolveSparseCandidatesAgainstIdentified(
      identifiedWorks,
      snapshot.unresolvedWorks,
      mergeRelatedWorkMetadata,
    );
    return [
      {
        ...snapshot,
        identifiedWorks: promoted.length
          ? mergeLists(identifiedWorks, promoted)
          : identifiedWorks,
      },
    ];
  }
  const globallyIdentified = mergeLists(
    ...prepared.map((snapshot) => snapshot.identifiedWorks),
  );
  return prepared.map((snapshot) => {
    const promoted = resolveSparseCandidatesAgainstIdentified(
      globallyIdentified,
      snapshot.unresolvedWorks,
      mergeRelatedWorkMetadata,
    );
    return {
      ...snapshot,
      identifiedWorks: mergeLists(snapshot.identifiedWorks, promoted),
    };
  });
}

function maximumReportedCount(
  snapshots: PreparedRelationshipProviderSnapshot[],
): { count: number | null; provider: CitationProviderID | null } {
  let count: number | null = null;
  let provider: CitationProviderID | null = null;
  for (const snapshot of snapshots) {
    if (
      snapshot.reportedCount != null &&
      (count == null || snapshot.reportedCount > count)
    ) {
      count = snapshot.reportedCount;
      provider = snapshot.provider;
    }
  }
  return { count, provider };
}

export function selectRelationshipMembership(
  direction: RelationshipDirection,
  snapshots: PreparedRelationshipProviderSnapshot[],
  mergeLists: (...groups: RelatedWorkMetadata[][]) => RelatedWorkMetadata[],
): SelectedRelationshipMembership {
  const usable = snapshots.filter(
    (snapshot) =>
      snapshot.succeeded &&
      (snapshot.complete ||
        snapshot.identifiedWorks.length > 0 ||
        snapshot.reportedCount === 0),
  );
  if (!usable.length) {
    return {
      works: [],
      reportedCount: null,
      countProvider: null,
      authorityProvider: null,
      complete: false,
      providerSnapshots: snapshots,
    };
  }

  void direction;
  const reported = maximumReportedCount(usable);
  return {
    works: mergeLists(...usable.map((snapshot) => snapshot.identifiedWorks)),
    reportedCount: reported.count,
    countProvider: reported.provider,
    authorityProvider: null,
    complete:
      snapshots.length > 0 &&
      snapshots.every((snapshot) => snapshot.succeeded && snapshot.complete),
    providerSnapshots: snapshots,
  };
}
