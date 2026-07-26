import type {
  CitationProviderID,
  RelatedWorkMetadata,
} from "../domain/citationTypes";
import {
  relationshipAdapterFor,
  type PreparedRelationshipProviderSnapshot,
  type RelationshipDirection,
  type RelationshipProviderSnapshot,
  type SelectedRelationshipMembership,
} from "../providers/relationshipAdapters";
import { mergeRelatedWorkMetadata } from "../providers/registry";
import {
  enrichIdentifiedRelationshipWorks,
  partitionRelationshipCandidates,
  resolveSparseCandidatesAgainstIdentified,
} from "./relationshipIdentityService";

export function relationshipPageSizeForProvider(
  provider: CitationProviderID,
): number {
  return relationshipAdapterFor(provider).relationshipPageSize;
}

export function metadataBatchSizeForProvider(
  provider: CitationProviderID,
): number {
  return relationshipAdapterFor(provider).metadataBatchSize;
}

/**
 * Providers run concurrently; each provider's HTTP scheduler remains isolated.
 */
export async function dispatchRelationshipProviders<T>(
  providers: CitationProviderID[],
  task: (provider: CitationProviderID) => Promise<T>,
): Promise<T[]> {
  return Promise.all(providers.map((provider) => task(provider)));
}

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

function consistencyDistance(
  snapshot: PreparedRelationshipProviderSnapshot,
): number {
  if (snapshot.reportedCount == null) return 1;
  return (
    Math.abs(snapshot.rawRetrievedCount - snapshot.reportedCount) /
    Math.max(1, snapshot.reportedCount)
  );
}

function compareReferenceAuthority(
  left: PreparedRelationshipProviderSnapshot,
  right: PreparedRelationshipProviderSnapshot,
): number {
  if (left.complete !== right.complete) return left.complete ? -1 : 1;
  const leftDistance = consistencyDistance(left);
  const rightDistance = consistencyDistance(right);
  if (leftDistance !== rightDistance) return leftDistance - rightDistance;
  const leftPriority = relationshipAdapterFor(
    left.provider,
  ).referenceAuthorityPriority;
  const rightPriority = relationshipAdapterFor(
    right.provider,
  ).referenceAuthorityPriority;
  if (leftPriority !== rightPriority) return rightPriority - leftPriority;
  return right.identifiedWorks.length - left.identifiedWorks.length;
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

  if (direction === "cited-by") {
    const reported = maximumReportedCount(usable);
    return {
      works: mergeLists(...usable.map((snapshot) => snapshot.identifiedWorks)),
      reportedCount: reported.count,
      countProvider: reported.provider,
      authorityProvider: null,
      complete: usable.every((snapshot) => snapshot.complete),
      providerSnapshots: snapshots,
    };
  }

  const authority = [...usable].sort(compareReferenceAuthority)[0];
  const incomplete =
    !authority.complete ||
    (authority.reportedCount != null &&
      authority.rawRetrievedCount < authority.reportedCount);
  const works = incomplete
    ? mergeLists(
        authority.identifiedWorks,
        ...usable
          .filter((snapshot) => snapshot.provider !== authority.provider)
          .map((snapshot) => snapshot.identifiedWorks),
      )
    : mergeLists(authority.identifiedWorks);

  return {
    works,
    reportedCount: authority.reportedCount,
    countProvider: authority.provider,
    authorityProvider: authority.provider,
    complete: authority.complete,
    providerSnapshots: snapshots,
  };
}
