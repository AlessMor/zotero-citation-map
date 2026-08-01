import type { RelatedWorkMetadata } from "../domain/citationTypes";
import { matchRelatedWorks, stableWorkAliases } from "../domain/workIdentity";

export function partitionRelationshipCandidates(works: RelatedWorkMetadata[]): {
  identified: RelatedWorkMetadata[];
  unresolved: RelatedWorkMetadata[];
} {
  const identified: RelatedWorkMetadata[] = [];
  const unresolved: RelatedWorkMetadata[] = [];
  for (const work of works) {
    (stableWorkAliases(work).length > 0 ? identified : unresolved).push(work);
  }
  return { identified, unresolved };
}

/**
 * A sparse candidate may enrich an already identified paper when at least one
 * evidence group matches and every evidence group available on both records is
 * non-contradictory. Sparse candidates never create relationship membership.
 */
function candidateCanEnrichIdentifiedWork(
  identified: RelatedWorkMetadata,
  candidate: RelatedWorkMetadata,
): boolean {
  return matchRelatedWorks(identified, candidate).decision === "same-work";
}

export function enrichIdentifiedRelationshipWorks(
  identified: RelatedWorkMetadata[],
  candidates: RelatedWorkMetadata[],
  merge: (
    existing: RelatedWorkMetadata,
    candidate: RelatedWorkMetadata,
  ) => RelatedWorkMetadata,
): RelatedWorkMetadata[] {
  const result = identified.map((work) => ({
    ...work,
    authors: [...work.authors],
  }));
  for (const candidate of candidates) {
    const matches: number[] = [];
    for (const [index, work] of result.entries()) {
      if (candidateCanEnrichIdentifiedWork(work, candidate)) {
        matches.push(index);
      }
      if (matches.length > 1) break;
    }
    // Ambiguous sparse metadata is ignored rather than guessed onto a paper.
    if (matches.length === 1) {
      result[matches[0]] = merge(result[matches[0]], candidate);
    }
  }
  return result;
}

export function resolveSparseCandidatesAgainstIdentified(
  identified: RelatedWorkMetadata[],
  candidates: RelatedWorkMetadata[],
  merge: (
    existing: RelatedWorkMetadata,
    candidate: RelatedWorkMetadata,
  ) => RelatedWorkMetadata,
): RelatedWorkMetadata[] {
  const resolved: RelatedWorkMetadata[] = [];
  for (const candidate of candidates) {
    const matches = identified.filter((work) =>
      candidateCanEnrichIdentifiedWork(work, candidate),
    );
    if (matches.length === 1) resolved.push(merge(matches[0], candidate));
  }
  return resolved;
}
