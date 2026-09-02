import type {
  CitationProviderID,
  RelatedWorkMetadata,
  RelatedWorkPropertyName,
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
  byKey: Map<string, LibraryWorkIdentity>;
  byDOI: Map<string, LibraryWorkIdentity>;
  byTitle: Map<string, LibraryWorkIdentity>;
}

/**
 * Local bibliographic metadata available while external relationship records
 * are projected into the UI. The additional fields are optional so existing
 * identity-only callers remain valid, while graph nodes and ZoteroPaper values
 * can supply richer local fallbacks without another Zotero lookup.
 */
export interface LibraryWorkIdentity {
  itemKey: string;
  doi: string | null;
  title: string;
  authors?: readonly string[];
  year?: number | null;
  publicationDate?: string | null;
  sourceTitle?: string | null;
  abstract?: string | null;
  libraryID?: number | null;
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
  const byKey = new Map<string, LibraryWorkIdentity>();
  const byDOI = new Map<string, LibraryWorkIdentity>();
  const byTitle = new Map<string, LibraryWorkIdentity>();
  for (const node of nodes) {
    const key = String(node.itemKey ?? "")
      .trim()
      .toLocaleUpperCase();
    const doi = normalizeDOI(node.doi);
    const title = normalizeExactTitle(node.title);
    if (key && !byKey.has(key)) byKey.set(key, node);
    if (doi && !byDOI.has(doi)) byDOI.set(doi, node);
    if (title && !byTitle.has(title)) byTitle.set(title, node);
  }
  return { byKey, byDOI, byTitle };
}

function localWorkForExternal(
  work: RelatedWorkMetadata,
  localByDOI: Map<string, LibraryWorkIdentity>,
  localByTitle: Map<string, LibraryWorkIdentity>,
  localByKey?: Map<string, LibraryWorkIdentity>,
): LibraryWorkIdentity | null {
  const explicitKey = String(work.inLibraryItemKey ?? work.zoteroItemKey ?? "")
    .trim()
    .toLocaleUpperCase();
  if (explicitKey && localByKey) {
    const explicit = localByKey.get(explicitKey);
    if (explicit) return explicit;
  }

  const doi = normalizeDOI(work.doi);
  if (doi) {
    const doiMatch = localByDOI.get(doi);
    if (doiMatch) return doiMatch;
  }

  const title = normalizeExactTitle(work.title);
  if (!title) return null;
  const titleMatch = localByTitle.get(title) ?? null;
  if (!titleMatch) return null;

  // A title fallback may bridge a record whose DOI is missing locally, but it
  // must never join two records that already have conflicting DOI identities.
  const localDOI = normalizeDOI(titleMatch.doi);
  if (doi && localDOI && doi !== localDOI) return null;
  return titleMatch;
}

function nonEmptyText(value: string | null | undefined): string | null {
  const normalized = normalizeScholarlyText(value);
  return normalized || null;
}

function mergeLocalZoteroMetadata<T extends RelatedWorkMetadata>(
  work: T,
  local: LibraryWorkIdentity,
): T {
  const workDOI = normalizeDOI(work.doi);
  const localDOI = normalizeDOI(local.doi);
  const workTitle = usableExternalTitle(work.title, workDOI);
  const localTitle = usableExternalTitle(local.title, localDOI);
  const workAuthors = work.authors
    .map((author) => author.trim())
    .filter(Boolean);
  const localAuthors = (local.authors ?? [])
    .map((author) => String(author ?? "").trim())
    .filter(Boolean);
  const workPublicationDate = String(work.publicationDate ?? "").trim();
  const localPublicationDate = String(local.publicationDate ?? "").trim();
  const workSourceTitle = nonEmptyText(work.sourceTitle);
  const localSourceTitle = nonEmptyText(local.sourceTitle);
  const workAbstract = nonEmptyText(work.abstract);
  const localAbstract = nonEmptyText(local.abstract);

  const localFields: RelatedWorkPropertyName[] = [];
  if (!workDOI && localDOI) localFields.push("doi");
  if (!workTitle && localTitle) localFields.push("title");
  if (!workAuthors.length && localAuthors.length) localFields.push("authors");
  if (work.year == null && local.year != null) localFields.push("year");
  if (!workPublicationDate && localPublicationDate) {
    localFields.push("publicationDate");
  }
  if (!workSourceTitle && localSourceTitle) localFields.push("sourceTitle");
  if (!workAbstract && localAbstract) localFields.push("abstract");

  const propertySources = { ...(work.propertySources ?? {}) };
  for (const property of localFields) propertySources[property] = ["zotero"];

  return normalizeRelatedWorkText({
    ...work,
    doi: workDOI ?? localDOI,
    title: workTitle ?? localTitle ?? work.title,
    authors: workAuthors.length ? workAuthors : localAuthors,
    year: work.year ?? local.year ?? null,
    publicationDate:
      workPublicationDate ||
      localPublicationDate ||
      work.publicationDate ||
      null,
    sourceTitle: workSourceTitle ?? localSourceTitle,
    abstract: workAbstract ?? localAbstract,
    zoteroItemKey: work.zoteroItemKey ?? local.itemKey,
    inLibraryItemKey: local.itemKey,
    zoteroLibraryID: work.zoteroLibraryID ?? local.libraryID ?? null,
    propertySources,
  } as T);
}

export function toExternalWork(
  work: RelatedWorkMetadata,
  localByDOI: Map<string, LibraryWorkIdentity>,
  localByTitle: Map<string, LibraryWorkIdentity>,
  localByKey?: Map<string, LibraryWorkIdentity>,
): ExternalWork {
  const key = stableExternalWorkIdentity(work);
  const resolved = normalizeRelatedWorkText(
    key
      ? mergeExternalWorkMetadata(work, cachedExternalWorkMetadata(key))
      : work,
  );
  const local = localWorkForExternal(
    resolved,
    localByDOI,
    localByTitle,
    localByKey,
  );
  const enriched = local ? mergeLocalZoteroMetadata(resolved, local) : resolved;
  const external: ExternalWork = {
    ...enriched,
    inLibraryItemKey:
      local?.itemKey ??
      enriched.inLibraryItemKey ??
      enriched.zoteroItemKey ??
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
    toExternalWork(work, indexes.byDOI, indexes.byTitle, indexes.byKey),
  );
}
