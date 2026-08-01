import type {
  CitationProviderID,
  RelatedWorkMetadata,
} from "../domain/citationTypes";
import type { ExternalWork } from "../domain/externalWork";
import { mergeRelatedWorkMetadata } from "../domain/relatedWorkMetadata";
import {
  normalizeDOI,
  normalizeExactTitle,
  stableExternalWorkIdentity,
} from "../domain/workIdentity";
import { cachedExternalWorkMetadata } from "./externalWorkCacheService";
import { registerExternalWorkMetrics } from "./externalWorkMetricRegistry";
import { mergeRelatedWorkHydrationState } from "./relatedWorkHydrationState";
import {
  normalizeRelatedWorkText,
  normalizeScholarlyText,
} from "./scholarlyTextService";

export interface LocalExternalWorkIndexes {
  byDOI: Map<string, string>;
  byTitle: Map<string, string>;
}

export interface LibraryWorkIdentity {
  itemKey: string;
  doi: string | null;
  title: string;
}

export function usableExternalTitle(
  title: string | null | undefined,
  doi: string | null | undefined,
): string | null {
  const value = normalizeScholarlyText(title);
  if (!value) return null;
  const normalizedValue = value
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .trim()
    .toLocaleLowerCase();
  const normalizedDOI = normalizeDOI(doi);
  if (normalizedDOI && normalizedValue === normalizedDOI) return null;
  if (/^https?:\/\//i.test(value)) return null;
  return value;
}

export function externalWorkDisplayTitle(
  work: RelatedWorkMetadata,
): string | null {
  const direct = usableExternalTitle(work.title, work.doi);
  if (direct) return direct;
  const key = stableExternalWorkIdentity(work);
  const cached = key ? cachedExternalWorkMetadata(key) : null;
  return cached
    ? usableExternalTitle(cached.title, cached.doi ?? work.doi)
    : null;
}

export function mergeExternalWorkMetadata<T extends RelatedWorkMetadata>(
  work: T,
  metadata: RelatedWorkMetadata | null,
): T {
  const merged = mergeRelatedWorkMetadata(work, metadata);
  const sources = new Set<CitationProviderID>(work.dataSources ?? []);
  if (work.provider !== "manual" && work.provider !== "zotero") {
    sources.add(work.provider);
  }
  for (const source of metadata?.dataSources ?? []) sources.add(source);
  if (
    metadata &&
    metadata.provider !== "manual" &&
    metadata.provider !== "zotero"
  ) {
    sources.add(metadata.provider);
  }
  const timestamps = [work.updatedAt, metadata?.updatedAt]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const authors =
    work.authors.length >= (metadata?.authors.length ?? 0)
      ? work.authors
      : (metadata?.authors ?? []);
  const normalized = normalizeRelatedWorkText({
    ...merged,
    authors: [...authors],
    authorIDs: [
      ...new Set([...(work.authorIDs ?? []), ...(metadata?.authorIDs ?? [])]),
    ],
    citationCountsByYear: work.citationCountsByYear?.length
      ? work.citationCountsByYear
      : (metadata?.citationCountsByYear ?? []),
    references:
      (work.references?.length ?? 0) >= (metadata?.references?.length ?? 0)
        ? work.references
        : metadata?.references,
    resolvedReferenceCount:
      work.resolvedReferenceCount ?? metadata?.resolvedReferenceCount ?? null,
    fwci: work.fwci ?? metadata?.fwci ?? null,
    citationPercentile:
      work.citationPercentile ?? metadata?.citationPercentile ?? null,
    isTop1Percent: work.isTop1Percent ?? metadata?.isTop1Percent ?? null,
    isTop10Percent: work.isTop10Percent ?? metadata?.isTop10Percent ?? null,
    citationsLastYear:
      work.citationsLastYear ?? metadata?.citationsLastYear ?? null,
    citationVelocity:
      work.citationVelocity ?? metadata?.citationVelocity ?? null,
    citationAcceleration:
      work.citationAcceleration ?? metadata?.citationAcceleration ?? null,
    influentialCitationCount:
      work.influentialCitationCount ??
      metadata?.influentialCitationCount ??
      null,
    publicationType: work.publicationType ?? metadata?.publicationType ?? null,
    sourceMetrics: work.sourceMetrics ?? metadata?.sourceMetrics ?? null,
    referenceAgeMean:
      work.referenceAgeMean ?? metadata?.referenceAgeMean ?? null,
    referenceAgeSpread:
      work.referenceAgeSpread ?? metadata?.referenceAgeSpread ?? null,
    selfCitationEstimate:
      work.selfCitationEstimate ?? metadata?.selfCitationEstimate ?? null,
    futureReferenceCount:
      work.futureReferenceCount ?? metadata?.futureReferenceCount ?? null,
    metadataCompleteness:
      work.metadataCompleteness ?? metadata?.metadataCompleteness ?? null,
    dataSources: [...sources],
    updatedAt: timestamps.at(-1) ?? null,
  } as T);
  return mergeRelatedWorkHydrationState(normalized, metadata);
}

export function localExternalWorkIndexes(
  nodes: readonly LibraryWorkIdentity[],
): LocalExternalWorkIndexes {
  const byDOI = new Map<string, string>();
  const byTitle = new Map<string, string>();
  for (const node of nodes) {
    const doi = normalizeDOI(node.doi);
    const title = normalizeExactTitle(node.title);
    if (doi && !byDOI.has(doi)) byDOI.set(doi, node.itemKey);
    if (title && !byTitle.has(title)) byTitle.set(title, node.itemKey);
  }
  return { byDOI, byTitle };
}

export function toExternalWork(
  work: RelatedWorkMetadata,
  localByDOI: Map<string, string>,
  localByTitle: Map<string, string>,
): ExternalWork {
  const key = stableExternalWorkIdentity(work);
  const resolved = normalizeRelatedWorkText(
    key
      ? mergeExternalWorkMetadata(work, cachedExternalWorkMetadata(key))
      : work,
  );
  const doi = normalizeDOI(resolved.doi);
  const title = normalizeExactTitle(resolved.title);
  const external: ExternalWork = {
    ...resolved,
    inLibraryItemKey:
      (doi ? localByDOI.get(doi) : null) ??
      (title ? localByTitle.get(title) : null) ??
      resolved.zoteroItemKey ??
      null,
  };
  registerExternalWorkMetrics(external);
  return external;
}

export function toExternalWorks(
  works: RelatedWorkMetadata[],
  libraryNodes: readonly LibraryWorkIdentity[],
): ExternalWork[] {
  const indexes = localExternalWorkIndexes(libraryNodes);
  return works.map((work) =>
    toExternalWork(work, indexes.byDOI, indexes.byTitle),
  );
}
