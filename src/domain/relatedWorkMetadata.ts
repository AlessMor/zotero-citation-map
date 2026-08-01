import type {
  CitationProviderID,
  ProviderLookupSuccess,
  RelatedWorkMetadata,
  RelatedWorkPropertyConflict,
  RelatedWorkPropertyName,
  RelatedWorkPropertySource,
} from "./citationTypes";
import { publicationYearOrNull } from "./valueNormalization";
import {
  matchRelatedWorks,
  normalizeDOI,
  normalizeExactTitle,
  normalizeISBN,
  stableWorkAliases,
} from "./workIdentity";

export function relatedWorkFromProviderLookup(
  result: ProviderLookupSuccess,
): RelatedWorkMetadata {
  return {
    provider: result.provider,
    providerWorkID: result.providerWorkID,
    doi: result.doi,
    title: result.title,
    year: publicationYearOrNull(result.year),
    publicationDate: result.publicationDate ?? null,
    authors: [...result.authors],
    sourceTitle: result.sourceTitle,
    abstract: result.abstract,
    citationCount: result.citationCount,
    referenceCount: result.referenceCount,
    resolvedReferenceCount: result.resolvedReferenceCount,
    references: result.references,
    fwci: result.fwci ?? null,
    citationPercentile: result.citationPercentile ?? null,
    isTop1Percent: result.isTop1Percent ?? null,
    isTop10Percent: result.isTop10Percent ?? null,
    citationCountsByYear: result.citationCountsByYear ?? [],
    citationsLastYear: result.citationsLastYear ?? null,
    citationVelocity: result.citationVelocity ?? null,
    citationAcceleration: result.citationAcceleration ?? null,
    influentialCitationCount: result.influentialCitationCount ?? null,
    isRetracted: result.isRetracted ?? null,
    openAccessStatus: result.openAccessStatus ?? null,
    isOpenAccess: result.isOpenAccess ?? null,
    publicationType: result.publicationType ?? null,
    sourceMetrics: result.sourceMetrics ?? null,
    dataSources: [result.provider],
  };
}

export type MetadataPreference = "existing" | "incoming" | "richer";

export interface RelatedWorkMergePolicy {
  /** Controls optional scalar fields when both records have a value. */
  scalarPreference?: MetadataPreference;
  /** Controls provider/providerWorkID ownership. */
  providerPreference?: "existing" | "incoming";
  /** Use the largest known count; appropriate for independently observed totals. */
  countPreference?: "maximum" | "existing" | "incoming";
}

export const CANONICAL_RELATED_WORK_MERGE: Readonly<RelatedWorkMergePolicy> = {
  scalarPreference: "existing",
  providerPreference: "existing",
  countPreference: "maximum",
};

export const CACHE_RELATED_WORK_MERGE: Readonly<RelatedWorkMergePolicy> = {
  scalarPreference: "incoming",
  providerPreference: "incoming",
  countPreference: "maximum",
};

export function mergeRelatedWorkMetadata<T extends RelatedWorkMetadata>(
  work: T,
  metadata: RelatedWorkMetadata | null,
): T {
  if (!metadata) return work;
  return mergeRelatedWorkRecords(work, metadata, CANONICAL_RELATED_WORK_MERGE);
}

const TRACKED_PROPERTIES: readonly RelatedWorkPropertyName[] = [
  "doi",
  "pmid",
  "arxiv",
  "isbn",
  "title",
  "year",
  "publicationDate",
  "authors",
  "authorIDs",
  "sourceTitle",
  "abstract",
  "citationCount",
  "referenceCount",
  "citationCountsByYear",
  "references",
  "resolvedReferenceCount",
  "fwci",
  "citationPercentile",
  "isTop1Percent",
  "isTop10Percent",
  "citationsLastYear",
  "citationVelocity",
  "citationAcceleration",
  "influentialCitationCount",
  "publicationType",
  "sourceMetrics",
  "referenceAgeMean",
  "referenceAgeSpread",
  "selfCitationEstimate",
  "futureReferenceCount",
  "metadataCompleteness",
  "isOpenAccess",
  "openAccessStatus",
  "isRetracted",
];

function nonEmptyString(value: string | null | undefined): boolean {
  return Boolean(String(value ?? "").trim());
}

function latestTimestamp(
  left: string | null | undefined,
  right: string | null | undefined,
): string | null {
  const candidates = [left, right]
    .filter((value): value is string => Boolean(value))
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return candidates.at(-1) ?? right ?? left ?? null;
}

function maximumKnown(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null | undefined {
  const values = [left, right].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (!values.length) return left ?? right;
  return Math.max(...values);
}

function chooseCount(
  existing: number | null | undefined,
  incoming: number | null | undefined,
  preference: RelatedWorkMergePolicy["countPreference"],
): number | null | undefined {
  if (preference === "incoming") return incoming ?? existing;
  if (preference === "existing") return existing ?? incoming;
  return maximumKnown(existing, incoming);
}

function chooseScalar<T>(
  existing: T | null | undefined,
  incoming: T | null | undefined,
  preference: MetadataPreference,
): T | null | undefined {
  if (preference === "incoming") return incoming ?? existing;
  return existing ?? incoming;
}

function chooseString(
  existing: string | null | undefined,
  incoming: string | null | undefined,
  preference: MetadataPreference,
): string | null | undefined {
  if (preference === "incoming") {
    return nonEmptyString(incoming) ? incoming : existing;
  }
  if (preference === "richer") {
    const left = String(existing ?? "").trim();
    const right = String(incoming ?? "").trim();
    return right.length > left.length ? incoming : existing;
  }
  return nonEmptyString(existing) ? existing : incoming;
}

function richerArray<T>(
  existing: T[] | null | undefined,
  incoming: T[] | null | undefined,
): T[] | undefined {
  const selected =
    (incoming?.length ?? 0) > (existing?.length ?? 0) ? incoming : existing;
  return selected ? [...selected] : undefined;
}

function sourceSet(
  existing: RelatedWorkMetadata,
  incoming: RelatedWorkMetadata,
): CitationProviderID[] {
  const sources = new Set<CitationProviderID>();
  for (const source of existing.dataSources ?? []) sources.add(source);
  for (const source of incoming.dataSources ?? []) sources.add(source);
  if (existing.provider !== "manual" && existing.provider !== "zotero") {
    sources.add(existing.provider);
  }
  if (incoming.provider !== "manual" && incoming.provider !== "zotero") {
    sources.add(incoming.provider);
  }
  return [...sources];
}

function propertySource(work: RelatedWorkMetadata): RelatedWorkPropertySource {
  return work.provider;
}

function hasPropertyValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function propertyValue(
  work: RelatedWorkMetadata,
  property: RelatedWorkPropertyName,
): unknown {
  return work[property];
}

function normalizedArray(values: unknown[]): string[] {
  return values.map((value) => normalizeExactTitle(value));
}

function propertyValuesEqual(
  property: RelatedWorkPropertyName,
  left: unknown,
  right: unknown,
): boolean {
  if (!hasPropertyValue(left) || !hasPropertyValue(right)) return false;
  if (property === "doi") return normalizeDOI(left) === normalizeDOI(right);
  if (property === "isbn") return normalizeISBN(left) === normalizeISBN(right);
  if (property === "title") {
    return normalizeExactTitle(left) === normalizeExactTitle(right);
  }
  if (property === "authors" || property === "authorIDs") {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      JSON.stringify(normalizedArray(left)) ===
      JSON.stringify(normalizedArray(right))
    );
  }
  if (typeof left === "string" && typeof right === "string") {
    return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
  }
  if (
    typeof left === "number" ||
    typeof left === "boolean" ||
    typeof right === "number" ||
    typeof right === "boolean"
  ) {
    return Object.is(left, right);
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function propertySources(
  work: RelatedWorkMetadata,
  property: RelatedWorkPropertyName,
): RelatedWorkPropertySource[] {
  const existing = work.propertySources?.[property] ?? [];
  if (existing.length > 0) return [...existing];
  return hasPropertyValue(propertyValue(work, property))
    ? [propertySource(work)]
    : [];
}

function serializedPropertyValue(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function conflictKey(conflict: RelatedWorkPropertyConflict): string {
  return [
    conflict.property,
    conflict.existingValue,
    conflict.incomingValue,
  ].join("\u0000");
}

function addPropertyConflict(
  conflicts: Map<string, RelatedWorkPropertyConflict>,
  conflict: RelatedWorkPropertyConflict,
): void {
  const key = conflictKey(conflict);
  const current = conflicts.get(key);
  conflicts.set(key, {
    ...conflict,
    existingSources: [
      ...new Set([
        ...(current?.existingSources ?? []),
        ...conflict.existingSources,
      ]),
    ],
    incomingSources: [
      ...new Set([
        ...(current?.incomingSources ?? []),
        ...conflict.incomingSources,
      ]),
    ],
  });
}

function mergePropertyEvidence(
  existing: RelatedWorkMetadata,
  incoming: RelatedWorkMetadata,
  merged: RelatedWorkMetadata,
): Pick<RelatedWorkMetadata, "propertySources" | "propertyConflicts"> {
  const sources: NonNullable<RelatedWorkMetadata["propertySources"]> = {};
  const conflicts = new Map<string, RelatedWorkPropertyConflict>();
  for (const conflict of [
    ...(existing.propertyConflicts ?? []),
    ...(incoming.propertyConflicts ?? []),
  ]) {
    addPropertyConflict(conflicts, conflict);
  }

  for (const property of TRACKED_PROPERTIES) {
    const left = propertyValue(existing, property);
    const right = propertyValue(incoming, property);
    const selected = propertyValue(merged, property);
    const leftSources = propertySources(existing, property);
    const rightSources = propertySources(incoming, property);
    if (property === "references") {
      if (hasPropertyValue(selected)) {
        sources[property] = [...new Set([...leftSources, ...rightSources])];
      }
      continue;
    }
    if (propertyValuesEqual(property, left, right)) {
      sources[property] = [...new Set([...leftSources, ...rightSources])];
      continue;
    }
    if (propertyValuesEqual(property, selected, right)) {
      sources[property] = [...new Set(rightSources)];
    } else if (propertyValuesEqual(property, selected, left)) {
      sources[property] = [...new Set(leftSources)];
    } else if (hasPropertyValue(selected)) {
      sources[property] = [propertySource(merged)];
    }
    if (hasPropertyValue(left) && hasPropertyValue(right)) {
      const conflict: RelatedWorkPropertyConflict = {
        property,
        existingValue: serializedPropertyValue(left),
        incomingValue: serializedPropertyValue(right),
        existingSources: leftSources,
        incomingSources: rightSources,
      };
      addPropertyConflict(conflicts, conflict);
    }
  }
  return {
    propertySources: sources,
    propertyConflicts: [...conflicts.values()],
  };
}

function initialPropertySources(
  work: RelatedWorkMetadata,
): NonNullable<RelatedWorkMetadata["propertySources"]> {
  const sources: NonNullable<RelatedWorkMetadata["propertySources"]> = {};
  for (const property of TRACKED_PROPERTIES) {
    if (hasPropertyValue(propertyValue(work, property))) {
      sources[property] = propertySources(work, property);
    }
  }
  return sources;
}

export function cloneRelatedWorkMetadata<T extends RelatedWorkMetadata>(
  work: T,
): T {
  return {
    ...work,
    authors: [...work.authors],
    authorIDs: work.authorIDs ? [...work.authorIDs] : undefined,
    citationCountsByYear: work.citationCountsByYear
      ? work.citationCountsByYear.map((entry) => ({ ...entry }))
      : undefined,
    references: work.references?.map((reference) =>
      cloneRelatedWorkMetadata(reference),
    ),
    dataSources: work.dataSources ? [...work.dataSources] : undefined,
    propertySources: work.propertySources
      ? Object.fromEntries(
          Object.entries(work.propertySources).map(([property, sources]) => [
            property,
            [...sources],
          ]),
        )
      : initialPropertySources(work),
    propertyConflicts: work.propertyConflicts?.map((conflict) => ({
      ...conflict,
      existingSources: [...conflict.existingSources],
      incomingSources: [...conflict.incomingSources],
    })),
    identityConflict: work.identityConflict
      ? {
          ...work.identityConflict,
          existingAliases: [...work.identityConflict.existingAliases],
          incomingAliases: [...work.identityConflict.incomingAliases],
        }
      : null,
    identityStatus:
      work.identityStatus ??
      (stableWorkAliases(work).length > 0 ? "resolved" : "ambiguous"),
  };
}

/**
 * Canonical merge used by caches, provider orchestration and relationship
 * lists. Policy differences are explicit rather than reimplemented ad hoc.
 */
export function mergeRelatedWorkRecords<T extends RelatedWorkMetadata>(
  existing: T | null | undefined,
  incoming: RelatedWorkMetadata | null | undefined,
  policy: RelatedWorkMergePolicy,
): T {
  if (!existing && !incoming) {
    throw new Error("Cannot merge two empty related-work records.");
  }
  if (!existing) return cloneRelatedWorkMetadata(incoming as T);
  if (!incoming) return cloneRelatedWorkMetadata(existing);

  const identity = matchRelatedWorks(existing, incoming);
  if (identity.decision !== "same-work") {
    const retained = cloneRelatedWorkMetadata(existing);
    return {
      ...retained,
      identityStatus: identity.identityConflict
        ? "conflict"
        : identity.decision === "possible-version"
          ? "possible-version"
          : "ambiguous",
      identityConflict: identity.identityConflict
        ? {
            reason: identity.reason,
            existingAliases: stableWorkAliases(existing),
            incomingAliases: stableWorkAliases(incoming),
          }
        : retained.identityConflict,
    };
  }

  const scalarPreference = policy.scalarPreference ?? "existing";
  const providerPreference = policy.providerPreference ?? "existing";
  const countPreference = policy.countPreference ?? "maximum";
  const provider =
    providerPreference === "incoming" ? incoming.provider : existing.provider;
  const providerWorkID =
    providerPreference === "incoming"
      ? (incoming.providerWorkID ?? existing.providerWorkID)
      : (existing.providerWorkID ?? incoming.providerWorkID);

  const merged: T = {
    ...existing,
    provider,
    providerWorkID,
    doi: existing.doi ?? incoming.doi,
    pmid: existing.pmid ?? incoming.pmid,
    arxiv: existing.arxiv ?? incoming.arxiv,
    isbn: existing.isbn ?? incoming.isbn,
    title:
      chooseString(existing.title, incoming.title, scalarPreference) ?? null,
    year:
      chooseScalar(
        publicationYearOrNull(existing.year),
        publicationYearOrNull(incoming.year),
        scalarPreference,
      ) ?? null,
    publicationDate:
      chooseString(
        existing.publicationDate,
        incoming.publicationDate,
        scalarPreference,
      ) ?? null,
    authors: richerArray(existing.authors, incoming.authors) ?? [
      ...existing.authors,
    ],
    authorIDs: [
      ...new Set([
        ...(existing.authorIDs ?? []),
        ...(incoming.authorIDs ?? []),
      ]),
    ],
    sourceTitle:
      chooseString(
        existing.sourceTitle,
        incoming.sourceTitle,
        scalarPreference,
      ) ?? null,
    abstract:
      chooseString(existing.abstract, incoming.abstract, "richer") ?? null,
    citationCount:
      chooseCount(
        existing.citationCount,
        incoming.citationCount,
        countPreference,
      ) ?? null,
    referenceCount:
      chooseCount(
        existing.referenceCount,
        incoming.referenceCount,
        countPreference,
      ) ?? null,
    citationCountsByYear: richerArray(
      existing.citationCountsByYear,
      incoming.citationCountsByYear,
    ),
    references: richerArray(existing.references, incoming.references)?.map(
      (reference) => cloneRelatedWorkMetadata(reference),
    ),
    resolvedReferenceCount:
      maximumKnown(
        maximumKnown(
          existing.resolvedReferenceCount,
          incoming.resolvedReferenceCount,
        ),
        maximumKnown(existing.references?.length, incoming.references?.length),
      ) ?? null,
    fwci: chooseScalar(existing.fwci, incoming.fwci, scalarPreference) ?? null,
    citationPercentile:
      chooseScalar(
        existing.citationPercentile,
        incoming.citationPercentile,
        scalarPreference,
      ) ?? null,
    isTop1Percent:
      chooseScalar(
        existing.isTop1Percent,
        incoming.isTop1Percent,
        scalarPreference,
      ) ?? null,
    isTop10Percent:
      chooseScalar(
        existing.isTop10Percent,
        incoming.isTop10Percent,
        scalarPreference,
      ) ?? null,
    citationsLastYear:
      chooseScalar(
        existing.citationsLastYear,
        incoming.citationsLastYear,
        scalarPreference,
      ) ?? null,
    citationVelocity:
      chooseScalar(
        existing.citationVelocity,
        incoming.citationVelocity,
        scalarPreference,
      ) ?? null,
    citationAcceleration:
      chooseScalar(
        existing.citationAcceleration,
        incoming.citationAcceleration,
        scalarPreference,
      ) ?? null,
    influentialCitationCount:
      chooseScalar(
        existing.influentialCitationCount,
        incoming.influentialCitationCount,
        scalarPreference,
      ) ?? null,
    publicationType:
      chooseString(
        existing.publicationType,
        incoming.publicationType,
        scalarPreference,
      ) ?? null,
    sourceMetrics:
      chooseScalar(
        existing.sourceMetrics,
        incoming.sourceMetrics,
        scalarPreference,
      ) ?? null,
    referenceAgeMean:
      chooseScalar(
        existing.referenceAgeMean,
        incoming.referenceAgeMean,
        scalarPreference,
      ) ?? null,
    referenceAgeSpread:
      chooseScalar(
        existing.referenceAgeSpread,
        incoming.referenceAgeSpread,
        scalarPreference,
      ) ?? null,
    selfCitationEstimate:
      chooseScalar(
        existing.selfCitationEstimate,
        incoming.selfCitationEstimate,
        scalarPreference,
      ) ?? null,
    futureReferenceCount:
      chooseScalar(
        existing.futureReferenceCount,
        incoming.futureReferenceCount,
        scalarPreference,
      ) ?? null,
    metadataCompleteness:
      chooseScalar(
        existing.metadataCompleteness,
        incoming.metadataCompleteness,
        scalarPreference,
      ) ?? null,
    isOpenAccess:
      chooseScalar(
        existing.isOpenAccess,
        incoming.isOpenAccess,
        scalarPreference,
      ) ?? null,
    openAccessStatus:
      chooseString(
        existing.openAccessStatus,
        incoming.openAccessStatus,
        scalarPreference,
      ) ?? null,
    isRetracted:
      chooseScalar(
        existing.isRetracted,
        incoming.isRetracted,
        scalarPreference,
      ) ?? null,
    zoteroItemKey: existing.zoteroItemKey ?? incoming.zoteroItemKey ?? null,
    inLibraryItemKey:
      existing.inLibraryItemKey ?? incoming.inLibraryItemKey ?? null,
    dataSources: sourceSet(existing, incoming),
    updatedAt: latestTimestamp(existing.updatedAt, incoming.updatedAt),
    identityStatus:
      existing.identityStatus === "conflict" ? "conflict" : "resolved",
    identityConflict: existing.identityConflict ?? null,
  } as T;
  return {
    ...merged,
    ...mergePropertyEvidence(existing, incoming, merged),
  };
}
