import type { RelatedWorkMetadata } from "../domain/citationTypes";
import {
  normalizeDOI,
  normalizeExactTitle,
  normalizeIdentifier,
  relatedWorkStableAliases,
} from "./citationIdentifiers";

function normalizedSurname(value: string): string {
  const compact = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .trim();
  return compact.split(/\s+/).filter(Boolean).at(-1) ?? compact;
}

function stableAliases(work: RelatedWorkMetadata): string[] {
  return relatedWorkStableAliases(work).filter(
    (alias) => !alias.startsWith("title:"),
  );
}

export function stableRelationshipIdentity(
  work: RelatedWorkMetadata,
): string | null {
  return stableAliases(work)[0] ?? null;
}

export function hasStableRelationshipIdentity(
  work: RelatedWorkMetadata,
): boolean {
  return stableRelationshipIdentity(work) !== null;
}

export function partitionRelationshipCandidates(works: RelatedWorkMetadata[]): {
  identified: RelatedWorkMetadata[];
  unresolved: RelatedWorkMetadata[];
} {
  const identified: RelatedWorkMetadata[] = [];
  const unresolved: RelatedWorkMetadata[] = [];
  for (const work of works) {
    (hasStableRelationshipIdentity(work) ? identified : unresolved).push(work);
  }
  return { identified, unresolved };
}

function identifierNamespaces(
  work: RelatedWorkMetadata,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const add = (namespace: string, raw: unknown): void => {
    const value = normalizeIdentifier(raw);
    if (!value) return;
    const values = result.get(namespace) ?? new Set<string>();
    values.add(value);
    result.set(namespace, values);
  };

  add("doi", normalizeDOI(work.doi));
  add("pmid", work.pmid);
  add("arxiv", work.arxiv);
  add("isbn", String(work.isbn ?? "").replace(/[-\s]/g, ""));
  add("zotero", work.inLibraryItemKey ?? work.zoteroItemKey);
  if (work.providerWorkID && work.provider !== "manual") {
    add(`provider:${work.provider}`, work.providerWorkID);
  }
  return result;
}

function sharedIdentifierEvidence(
  left: RelatedWorkMetadata,
  right: RelatedWorkMetadata,
): { match: boolean; conflict: boolean } {
  const leftIDs = identifierNamespaces(left);
  const rightIDs = identifierNamespaces(right);
  let match = false;
  for (const [namespace, leftValues] of leftIDs) {
    const rightValues = rightIDs.get(namespace);
    if (!rightValues?.size) continue;
    const overlaps = [...leftValues].some((value) => rightValues.has(value));
    if (!overlaps) return { match: false, conflict: true };
    match = true;
  }
  return { match, conflict: false };
}

function titleEvidence(
  left: RelatedWorkMetadata,
  right: RelatedWorkMetadata,
): { match: boolean; conflict: boolean } {
  const leftTitle = normalizeExactTitle(left.title);
  const rightTitle = normalizeExactTitle(right.title);
  if (!leftTitle || !rightTitle) return { match: false, conflict: false };
  return leftTitle === rightTitle
    ? { match: true, conflict: false }
    : { match: false, conflict: true };
}

function authorYearEvidence(
  left: RelatedWorkMetadata,
  right: RelatedWorkMetadata,
): { match: boolean; conflict: boolean } {
  if (
    left.year == null ||
    right.year == null ||
    !left.authors.length ||
    !right.authors.length
  ) {
    return { match: false, conflict: false };
  }
  if (Math.abs(left.year - right.year) > 1) {
    return { match: false, conflict: true };
  }
  const leftSurnames = new Set(
    left.authors.map(normalizedSurname).filter(Boolean),
  );
  const overlaps = right.authors.some((author) =>
    leftSurnames.has(normalizedSurname(author)),
  );
  return overlaps
    ? { match: true, conflict: false }
    : { match: false, conflict: true };
}

/**
 * A sparse candidate may enrich an already identified paper when at least one
 * evidence group matches and every evidence group available on both records is
 * non-contradictory. Sparse candidates never create relationship membership.
 */
export function candidateCanEnrichIdentifiedWork(
  identified: RelatedWorkMetadata,
  candidate: RelatedWorkMetadata,
): boolean {
  const identifier = sharedIdentifierEvidence(identified, candidate);
  if (identifier.conflict) return false;
  const title = titleEvidence(identified, candidate);
  if (title.conflict) return false;
  const authorYear = authorYearEvidence(identified, candidate);
  if (authorYear.conflict) return false;
  return identifier.match || title.match || authorYear.match;
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
