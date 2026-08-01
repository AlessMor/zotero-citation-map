import type {
  CitationProviderID,
  IgnoredProviderRelation,
  ManualRelationDirection,
  RelatedWorkMetadata,
} from "./citationTypes";
import {
  matchRelatedWorks,
  normalizeDOI,
  normalizeExactTitle,
} from "./workIdentity";

export interface IgnoredRelationDescriptor {
  libraryID: number;
  subjectItemKey: string;
  direction: ManualRelationDirection;
  provider: CitationProviderID;
  providerWorkID: string | null;
  doi: string | null;
  normalizedTitle: string | null;
}

export interface IgnoredRelationIndex {
  readonly byLookupKey: ReadonlyMap<string, IgnoredProviderRelation>;
}

function ignoredRelationScopeKey(
  subjectItemKey: string,
  direction: ManualRelationDirection,
): string {
  return `${subjectItemKey.toLocaleUpperCase()}:${direction}`;
}

function ignoredRelationLookupKeys(
  relation: Pick<
    IgnoredProviderRelation,
    | "subjectItemKey"
    | "direction"
    | "provider"
    | "providerWorkID"
    | "doi"
    | "normalizedTitle"
  >,
): string[] {
  const scope = ignoredRelationScopeKey(
    relation.subjectItemKey,
    relation.direction,
  );
  const keys: string[] = [];
  const providerWorkID = String(relation.providerWorkID ?? "")
    .trim()
    .toLocaleLowerCase();
  if (providerWorkID) {
    keys.push(`${scope}:provider:${relation.provider}:${providerWorkID}`);
  }
  const doi = normalizeDOI(relation.doi);
  if (doi) keys.push(`${scope}:doi:${doi}`);
  const title = String(relation.normalizedTitle ?? "").trim();
  if (title) keys.push(`${scope}:title:${title}`);
  return keys;
}

export function createIgnoredRelationIndex(
  relations: readonly IgnoredProviderRelation[],
): IgnoredRelationIndex {
  const byLookupKey = new Map<string, IgnoredProviderRelation>();
  for (const relation of relations) {
    for (const key of ignoredRelationLookupKeys(relation)) {
      if (!byLookupKey.has(key)) byLookupKey.set(key, relation);
    }
  }
  return { byLookupKey };
}

export function findIgnoredRelation(
  index: IgnoredRelationIndex,
  descriptor: IgnoredRelationDescriptor,
): IgnoredProviderRelation | null {
  for (const key of ignoredRelationLookupKeys(descriptor)) {
    const relation = index.byLookupKey.get(key);
    if (relation) return relation;
  }
  return null;
}

export function relationshipDirection(
  direction: "references" | "cited-by",
): ManualRelationDirection {
  return direction === "references" ? "reference" : "cited-by";
}

export function providerForRelatedWork(
  work: RelatedWorkMetadata,
): CitationProviderID {
  return work.provider === "manual" || work.provider === "zotero"
    ? "crossref"
    : work.provider;
}

export function referenceMatchesRelatedWork(
  reference: RelatedWorkMetadata,
  work: RelatedWorkMetadata,
): boolean {
  return matchRelatedWorks(reference, work).decision === "same-work";
}

export function ignoredRelationDescriptorFromReference(
  libraryID: number,
  subjectItemKey: string,
  reference: RelatedWorkMetadata,
): IgnoredRelationDescriptor {
  return {
    libraryID,
    subjectItemKey,
    direction: "reference",
    provider: providerForRelatedWork(reference),
    providerWorkID:
      reference.provider === "manual" || reference.provider === "zotero"
        ? null
        : reference.providerWorkID,
    doi: reference.doi,
    normalizedTitle: normalizeExactTitle(reference.title) || null,
  };
}

export function ignoredRelationDescriptorForRelatedWork(
  libraryID: number,
  subjectItemKey: string,
  direction: ManualRelationDirection,
  work: RelatedWorkMetadata,
): IgnoredRelationDescriptor {
  return {
    libraryID,
    subjectItemKey,
    direction,
    provider: providerForRelatedWork(work),
    providerWorkID:
      work.provider === "manual" || work.provider === "zotero"
        ? null
        : work.providerWorkID,
    doi: work.doi,
    normalizedTitle: normalizeExactTitle(work.title) || null,
  };
}

export function ignoredRelationMatchesDescriptor(
  entry: IgnoredProviderRelation,
  descriptor: IgnoredRelationDescriptor,
): boolean {
  return (
    entry.subjectItemKey === descriptor.subjectItemKey &&
    entry.direction === descriptor.direction &&
    ((entry.provider === descriptor.provider &&
      Boolean(entry.providerWorkID) &&
      String(entry.providerWorkID).toLocaleLowerCase() ===
        String(descriptor.providerWorkID ?? "").toLocaleLowerCase()) ||
      (Boolean(entry.doi) &&
        normalizeDOI(entry.doi) === normalizeDOI(descriptor.doi)) ||
      (Boolean(entry.normalizedTitle) &&
        entry.normalizedTitle === descriptor.normalizedTitle))
  );
}
