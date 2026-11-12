import type {
  ProviderLookupResult,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { publicationYearOrNull } from "../domain/valueNormalization";
import {
  matchWorkIdentifiers,
  normalizeDOI,
  normalizeExactTitle,
} from "../domain/workIdentity";
import { getNASAADSAPIKey } from "../services/citationPreferences";
import { requestJSON, type HTTPResult } from "./http";
import {
  requireArray,
  requireRecord,
  requireResponseData,
  requireRelatedWorks,
} from "./responseValidation";
import type { CitationProvider, ProviderRequestOptions } from "./types";
import { failureStatusFromHTTP, numberOrNull, stringOrNull } from "./types";

const NASA_ADS_SEARCH_URL = "https://api.adsabs.harvard.edu/v1/search/query";
const NASA_ADS_FIELDS = [
  "bibcode",
  "title",
  "author",
  "year",
  "date",
  "pub",
  "abstract",
  "citation_count",
  "reference",
  "doi",
  "identifier",
  "property",
  "doctype",
].join(",");

export interface NASAADSRecord {
  bibcode?: string;
  title?: string | string[];
  author?: string[];
  year?: number | string;
  date?: string;
  pub?: string;
  abstract?: string;
  citation_count?: number;
  reference?: string[];
  doi?: string[];
  identifier?: string[];
  property?: string[];
  doctype?: string;
}

interface NASAADSResponse {
  response?: {
    numFound?: number;
    docs?: NASAADSRecord[];
  };
}

function escapeQueryValue(value: unknown): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function searchURL(
  query: string,
  rows: number,
  start: number,
  fields: string,
): string {
  const url = new URL(NASA_ADS_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("fl", fields);
  url.searchParams.set("sort", "bibcode asc");
  url.searchParams.set(
    "rows",
    String(Math.max(1, Math.min(2000, Math.floor(rows)))),
  );
  url.searchParams.set("start", String(Math.max(0, Math.floor(start))));
  return url.toString();
}

async function requestNASAADS(
  query: string,
  rows: number,
  start: number,
  fields: string,
  options: ProviderRequestOptions | undefined,
): Promise<HTTPResult<NASAADSResponse>> {
  const token = getNASAADSAPIKey();
  if (!token) {
    return {
      ok: false,
      status: 401,
      data: null as NASAADSResponse | null,
      message:
        "NASA ADS API token is not configured. Add it in Settings → Citation Map.",
    };
  }
  return requestJSON<NASAADSResponse>(
    "ads",
    searchURL(query, rows, start, fields),
    {
      signal: options?.signal,
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

function arxivID(identifiers: unknown[] | undefined): string | null {
  for (const raw of identifiers ?? []) {
    let value = String(raw ?? "").trim();
    if (!value) continue;
    value = value
      .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
      .replace(/\.pdf$/i, "")
      .replace(/^arxiv:\s*/i, "");
    const match = value.match(
      /^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i,
    );
    if (match) return match[1];
  }
  return null;
}

function title(record: NASAADSRecord): string | null {
  const value = Array.isArray(record.title) ? record.title[0] : record.title;
  return stringOrNull(value);
}

function authors(record: NASAADSRecord): string[] {
  return (record.author ?? [])
    .map((author) => String(author ?? "").trim())
    .filter(Boolean);
}

function validateNASAADSRecord(value: unknown): NASAADSRecord {
  const record = requireRecord(value, "NASA ADS record");
  if (typeof record.bibcode !== "string" || !record.bibcode.trim())
    throw new TypeError("NASA ADS record has no bibcode");
  for (const field of [
    "author",
    "doi",
    "identifier",
    "property",
    "reference",
  ]) {
    const entries = record[field];
    if (entries === undefined || entries === null) continue;
    if (
      !Array.isArray(entries) ||
      entries.some((entry: unknown) => typeof entry !== "string")
    )
      throw new TypeError(`NASA ADS ${field} must be an array of strings`);
  }
  for (const field of ["date", "pub", "abstract", "doctype"]) {
    if (
      record[field] !== undefined &&
      record[field] !== null &&
      typeof record[field] !== "string"
    )
      throw new TypeError(`NASA ADS ${field} must be a string`);
  }
  if (
    record.title !== undefined &&
    record.title !== null &&
    typeof record.title !== "string" &&
    (!Array.isArray(record.title) ||
      record.title.some((entry: unknown) => typeof entry !== "string"))
  )
    throw new TypeError("NASA ADS title must be a string or string array");
  if (
    record.year !== undefined &&
    record.year !== null &&
    typeof record.year !== "string" &&
    typeof record.year !== "number"
  )
    throw new TypeError("NASA ADS year must be a number or string");
  if (
    record.citation_count !== undefined &&
    record.citation_count !== null &&
    (typeof record.citation_count !== "number" ||
      !Number.isSafeInteger(record.citation_count) ||
      record.citation_count < 0)
  )
    throw new TypeError(
      "NASA ADS citation count must be a nonnegative integer",
    );
  return record as NASAADSRecord;
}

export function collectNASAADSRecords(data: unknown): NASAADSRecord[] {
  const root = requireRecord(data, "NASA ADS response");
  const response = requireRecord(root.response, "NASA ADS response envelope");
  if (
    typeof response.numFound !== "number" ||
    !Number.isSafeInteger(response.numFound) ||
    response.numFound < 0
  )
    throw new TypeError("NASA ADS response has no valid result count");
  const docs = requireArray(
    response.docs as unknown[] | undefined,
    "NASA ADS documents",
  );
  if (response.numFound < docs.length)
    throw new TypeError(
      "NASA ADS result count is smaller than its document list",
    );
  return docs.map(validateNASAADSRecord);
}

export function nasaADSWork(record: NASAADSRecord): RelatedWorkMetadata | null {
  validateNASAADSRecord(record);
  const bibcode = stringOrNull(record.bibcode);
  if (!bibcode) return null;
  const properties = new Set(
    (record.property ?? []).map((value) => String(value).toUpperCase()),
  );
  const openAccess =
    properties.has("OPENACCESS") || properties.has("EPRINT_OPENACCESS");
  return {
    provider: "ads",
    providerWorkID: bibcode,
    doi: normalizeDOI(record.doi?.[0]),
    pmid: null,
    arxiv: arxivID(record.identifier),
    isbn: null,
    title: title(record),
    year: publicationYearOrNull(record.year),
    publicationDate: stringOrNull(record.date),
    authors: authors(record),
    authorIDs: [],
    sourceTitle: stringOrNull(record.pub),
    abstract: stringOrNull(record.abstract),
    citationCount: numberOrNull(record.citation_count),
    referenceCount: Array.isArray(record.reference)
      ? record.reference.length
      : null,
    influentialCitationCount: null,
    isOpenAccess: openAccess ? true : null,
    openAccessStatus: openAccess ? "open" : null,
    publicationType: stringOrNull(record.doctype),
    isRetracted: null,
    dataSources: ["ads"],
  };
}

export function matchingNASAADSRecords(
  records: NASAADSRecord[],
  identifiers: WorkIdentifiers,
  matchedBy: "doi" | "arxiv" | "title",
): NASAADSRecord[] {
  if (matchedBy === "doi") {
    const wanted = normalizeDOI(identifiers.doi);
    return wanted
      ? records.filter((record) =>
          (record.doi ?? []).some((doi) => normalizeDOI(doi) === wanted),
        )
      : [];
  }
  if (matchedBy === "arxiv") {
    const wanted = arxivID([identifiers.arxiv])?.toLowerCase();
    return wanted
      ? records.filter((record) =>
          (record.identifier ?? []).some(
            (identifier) => arxivID([identifier])?.toLowerCase() === wanted,
          ),
        )
      : [];
  }
  const wanted = normalizeExactTitle(identifiers.title);
  return wanted
    ? records.filter(
        (record) =>
          normalizeExactTitle(title(record)) === wanted &&
          matchWorkIdentifiers(identifiers, nasaADSWork(record)!).decision ===
            "same-work",
      )
    : [];
}

function queryForIdentifiers(
  identifiers: WorkIdentifiers,
): { query: string; matchedBy: "doi" | "arxiv" | "title" } | null {
  if (identifiers.doi) {
    return {
      query: `doi:"${escapeQueryValue(identifiers.doi)}"`,
      matchedBy: "doi",
    };
  }
  if (identifiers.arxiv) {
    const arxiv = String(identifiers.arxiv)
      .replace(/^arxiv:\s*/i, "")
      .replace(/v\d+$/i, "");
    const escaped = escapeQueryValue(arxiv);
    return {
      query: `(identifier:"arXiv:${escaped}" OR identifier:"${escaped}")`,
      matchedBy: "arxiv",
    };
  }
  if (identifiers.title) {
    return {
      query: `title:"${escapeQueryValue(identifiers.title)}"`,
      matchedBy: "title",
    };
  }
  return null;
}

async function lookup(
  identifiers: WorkIdentifiers,
  options: ProviderRequestOptions | undefined,
  target: { query: string; matchedBy: "doi" | "arxiv" | "title" } | null,
): Promise<ProviderLookupResult> {
  if (!target) {
    return {
      status: "no-identifier",
      provider: "ads",
      message: "NASA ADS needs a DOI, arXiv ID, or title.",
    };
  }

  const response = await requestNASAADS(
    target.query,
    5,
    0,
    NASA_ADS_FIELDS,
    options,
  );
  if (!response.ok) {
    return {
      status: failureStatusFromHTTP(response.status),
      provider: "ads",
      message: response.message || "NASA ADS request failed.",
    };
  }

  const matches = matchingNASAADSRecords(
    collectNASAADSRecords(response.data),
    identifiers,
    target.matchedBy,
  );
  if (matches.length !== 1 || (response.data?.response?.numFound ?? 0) > 5) {
    return {
      status: matches.length === 0 ? "not-found" : "ambiguous-match",
      provider: "ads",
      message: "NASA ADS did not return a unique verified match.",
    };
  }
  const record = matches[0];

  const work = nasaADSWork(record);
  if (!work) {
    return {
      status: "not-found",
      provider: "ads",
      message: "NASA ADS returned a record without a bibcode.",
    };
  }

  return {
    status: "success",
    provider: "ads",
    matchedBy: target.matchedBy,
    matchConfidence: target.matchedBy === "title" ? 0.95 : 1,
    providerWorkID: work.providerWorkID,
    doi: target.matchedBy === "doi" ? normalizeDOI(identifiers.doi) : work.doi,
    title: work.title,
    year: work.year,
    publicationDate: work.publicationDate ?? null,
    authors: [...work.authors],
    sourceTitle: work.sourceTitle ?? null,
    abstract: work.abstract ?? null,
    citationCount: work.citationCount ?? null,
    citationCountProvider: "ads",
    referenceCount: work.referenceCount ?? null,
    referenceCountProvider: "ads",
    resolvedReferenceCount: 0,
    references: [],
    influentialCitationCount: null,
    isRetracted: null,
    openAccessStatus: work.openAccessStatus ?? null,
    isOpenAccess: work.isOpenAccess ?? null,
    publicationType: work.publicationType ?? null,
    sourceMetrics: null,
  };
}

async function fetchRelations(
  bibcode: string,
  relation: "citations" | "references",
  maximum: number,
  offset: number,
  options: ProviderRequestOptions | undefined,
): Promise<RelatedWorkMetadata[]> {
  const query = `${relation}(bibcode:"${escapeQueryValue(bibcode)}")`;
  if (
    !Number.isFinite(maximum) ||
    maximum < 0 ||
    !Number.isFinite(offset) ||
    offset < 0
  )
    throw new RangeError(
      "NASA ADS page size and offset must be finite nonnegative numbers",
    );
  if (maximum === 0) return [];
  const summaryFields = NASA_ADS_FIELDS.split(",")
    .filter((field) => field !== "abstract" && field !== "reference")
    .join(",");
  const response = await requestNASAADS(
    query,
    maximum,
    offset,
    summaryFields,
    options,
  );
  return requireRelatedWorks(
    collectNASAADSRecords(
      requireResponseData(response, `NASA ADS ${relation} for ${bibcode}`),
    ).map(nasaADSWork),
    "NASA ADS relationships",
  );
}

export const nasaADSProvider: CitationProvider = {
  id: "ads",
  label: "NASA ADS",
  capabilities: {
    identifiers: {
      doi: true,
      pmid: false,
      arxiv: true,
      isbn: false,
      titleSearch: true,
    },
    citationCount: true,
    referenceCount: true,
    citingWorks: true,
    referencedWorks: true,
    abstract: true,
    openAccess: true,
    retraction: false,
    sourceMetrics: false,
  },
  supports: (identifiers) => Boolean(identifiers.doi || identifiers.arxiv),
  lookup: (identifiers, options) =>
    lookup(identifiers, options, queryForIdentifiers(identifiers)),
  lookupForRelations: (identifiers, options) =>
    lookup(identifiers, options, queryForIdentifiers(identifiers)),
  searchExactTitle: (identifiers, options) =>
    lookup(
      identifiers,
      options,
      identifiers.title
        ? {
            query: `title:"${escapeQueryValue(identifiers.title)}"`,
            matchedBy: "title",
          }
        : null,
    ),
  fetchCitingWorks: (bibcode, maximum, offset, options) =>
    fetchRelations(bibcode, "citations", maximum, offset ?? 0, options),
  fetchReferencedWorks: (bibcode, maximum, offset, options) =>
    fetchRelations(bibcode, "references", maximum, offset ?? 0, options),
};
