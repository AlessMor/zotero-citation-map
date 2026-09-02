import type { RelatedWorkMetadata } from "../domain/citationTypes";
import { normalizeDOI } from "../domain/workIdentity";
import { publicationYearOrNull } from "../domain/valueNormalization";
import type { ProviderRequestOptions } from "../providers/types";

const DATACITE_REQUEST_TIMEOUT_MS = 15000;

interface DataCiteTitle {
  title?: string;
  titleType?: string | null;
}

interface DataCiteNameIdentifier {
  nameIdentifier?: string;
  nameIdentifierScheme?: string;
}

interface DataCiteCreator {
  name?: string;
  givenName?: string | null;
  familyName?: string | null;
  nameIdentifiers?: DataCiteNameIdentifier[];
}

interface DataCiteDate {
  date?: string;
  dateType?: string;
}

interface DataCiteAttributes {
  doi?: string;
  titles?: DataCiteTitle[];
  creators?: DataCiteCreator[];
  publicationYear?: number | string | null;
  dates?: DataCiteDate[];
  publisher?: string | { name?: string } | null;
  container?: { title?: string | null } | null;
  types?: {
    resourceType?: string | null;
    resourceTypeGeneral?: string | null;
  } | null;
}

export interface DataCiteResponse {
  data?: {
    id?: string;
    type?: string;
    attributes?: DataCiteAttributes;
  } | null;
}

export interface DataCiteMetadata {
  doi: string;
  title: string | null;
  year: number | null;
  publicationDate: string | null;
  authors: string[];
  authorIDs: string[];
  sourceTitle: string | null;
  publicationType: string | null;
}

function text(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function primaryTitle(titles: DataCiteTitle[] | undefined): string | null {
  const entries = titles ?? [];
  const primary = entries.find((entry) => {
    const type = text(entry.titleType)?.toLocaleLowerCase();
    return !type || type === "title";
  });
  return text(primary?.title ?? entries[0]?.title);
}

function creatorName(creator: DataCiteCreator): string | null {
  const direct = text(creator.name);
  if (direct) return direct;
  const given = text(creator.givenName);
  const family = text(creator.familyName);
  return [given, family].filter(Boolean).join(" ").trim() || null;
}

function creatorIdentifiers(creator: DataCiteCreator): string[] {
  return (creator.nameIdentifiers ?? [])
    .map((identifier) => text(identifier.nameIdentifier))
    .filter((identifier): identifier is string => Boolean(identifier));
}

function publicationDate(dates: DataCiteDate[] | undefined): string | null {
  const entries = dates ?? [];
  for (const preferredType of ["issued", "published", "available"]) {
    const matching = entries.find(
      (entry) => text(entry.dateType)?.toLocaleLowerCase() === preferredType,
    );
    const value = text(matching?.date);
    if (value) return value;
  }
  return text(entries[0]?.date);
}

function publisherName(
  publisher: DataCiteAttributes["publisher"],
): string | null {
  if (typeof publisher === "string") return text(publisher);
  return text(publisher?.name);
}

export function dataCiteMetadataFromResponse(
  response: DataCiteResponse,
): DataCiteMetadata | null {
  const attributes = response.data?.attributes;
  const doi = normalizeDOI(attributes?.doi ?? response.data?.id);
  if (!attributes || !doi) return null;
  const authors = (attributes.creators ?? [])
    .map(creatorName)
    .filter((author): author is string => Boolean(author));
  const authorIDs = (attributes.creators ?? []).flatMap(creatorIdentifiers);
  const year = publicationYearOrNull(attributes.publicationYear);
  return {
    doi,
    title: primaryTitle(attributes.titles),
    year,
    publicationDate: publicationDate(attributes.dates),
    authors,
    authorIDs: [...new Set(authorIDs)],
    sourceTitle:
      text(attributes.container?.title) ?? publisherName(attributes.publisher),
    publicationType:
      text(attributes.types?.resourceType) ??
      text(attributes.types?.resourceTypeGeneral),
  };
}

export function needsDataCiteMetadata(work: RelatedWorkMetadata): boolean {
  return Boolean(
    normalizeDOI(work.doi) &&
    (!String(work.title ?? "").trim() ||
      work.authors.length === 0 ||
      work.year === null),
  );
}

export function mergeDataCiteMetadata<T extends RelatedWorkMetadata>(
  work: T,
  metadata: DataCiteMetadata,
): T {
  const workDOI = normalizeDOI(work.doi);
  if (!workDOI || workDOI !== metadata.doi) return work;
  const currentTitle = String(work.title ?? "").trim();
  const currentDate = String(work.publicationDate ?? "").trim();
  const currentSource = String(work.sourceTitle ?? "").trim();
  const currentType = String(work.publicationType ?? "").trim();
  return {
    ...work,
    title: currentTitle ? work.title : metadata.title,
    year: work.year ?? metadata.year,
    publicationDate: currentDate
      ? work.publicationDate
      : metadata.publicationDate,
    authors: work.authors.length ? [...work.authors] : [...metadata.authors],
    authorIDs: work.authorIDs?.length
      ? [...work.authorIDs]
      : [...metadata.authorIDs],
    sourceTitle: currentSource ? work.sourceTitle : metadata.sourceTitle,
    publicationType: currentType
      ? work.publicationType
      : metadata.publicationType,
    updatedAt: new Date().toISOString(),
  };
}

const dataCiteRequests = new Map<string, Promise<DataCiteMetadata | null>>();

export function clearDataCiteMetadataCache(): void {
  dataCiteRequests.clear();
}

async function requestDataCiteMetadata(
  doi: string,
  options?: ProviderRequestOptions,
): Promise<DataCiteMetadata | null> {
  if (options?.signal?.cancelled) return null;
  let requestCanceller: (() => void) | null = null;
  const unsubscribe = options?.signal?.subscribe(() => {
    try {
      requestCanceller?.();
    } catch {
      // The request may already have completed.
    }
  });
  try {
    const response = await Zotero.HTTP.request(
      "GET",
      `https://api.datacite.org/dois/${encodeURIComponent(doi)}`,
      {
        headers: {
          Accept: "application/vnd.api+json",
          "User-Agent":
            "Zotero-Citation-Map/0.6 (metadata fallback; public API pool)",
        },
        responseType: "text",
        timeout: DATACITE_REQUEST_TIMEOUT_MS,
        successCodes: false,
        cancellerReceiver: (cancel: () => void) => {
          requestCanceller = cancel;
          if (options?.signal?.cancelled) cancel();
        },
      },
    );
    if (options?.signal?.cancelled) return null;
    if (response.status < 200 || response.status >= 300) return null;
    const raw = String((response as any).responseText ?? "").trim();
    if (!raw) return null;
    return dataCiteMetadataFromResponse(JSON.parse(raw) as DataCiteResponse);
  } catch (error) {
    Zotero.debug(
      `Citation Map: DataCite metadata lookup failed for ${doi}: ${String(error)}`,
    );
    return null;
  } finally {
    unsubscribe?.();
  }
}

export function resolveDataCiteMetadata(
  doi: string | null | undefined,
  options?: ProviderRequestOptions,
): Promise<DataCiteMetadata | null> {
  const normalized = normalizeDOI(doi);
  if (!normalized) return Promise.resolve(null);
  const cached = dataCiteRequests.get(normalized);
  if (cached) return cached;
  const request = requestDataCiteMetadata(normalized, options);
  dataCiteRequests.set(normalized, request);
  return request;
}
