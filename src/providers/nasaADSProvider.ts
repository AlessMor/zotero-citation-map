import type {
  ProviderLookupResult,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { publicationYearOrNull } from "../domain/valueNormalization";
import { normalizeDOI, normalizeExactTitle } from "../domain/workIdentity";
import { getNASAADSAPIKey } from "../services/citationPreferences";
import { requestJSON } from "./http";
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

interface NASAADSRecord {
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

function searchURL(query: string, rows: number, start: number): string {
  const url = new URL(NASA_ADS_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("fl", NASA_ADS_FIELDS);
  url.searchParams.set("rows", String(Math.max(1, Math.min(2000, Math.floor(rows)))));
  url.searchParams.set("start", String(Math.max(0, Math.floor(start))));
  return url.toString();
}

async function requestNASAADS(
  query: string,
  rows: number,
  start: number,
  options?: ProviderRequestOptions,
) {
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
  return requestJSON<NASAADSResponse>("ads", searchURL(query, rows, start), {
    signal: options?.signal,
    headers: { Authorization: `Bearer ${token}` },
  });
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

export function collectNASAADSRecords(data: unknown): NASAADSRecord[] {
  const docs = (data as NASAADSResponse | null)?.response?.docs;
  return Array.isArray(docs) ? docs : [];
}

export function nasaADSWork(record: NASAADSRecord): RelatedWorkMetadata | null {
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

function matchRecord(
  records: NASAADSRecord[],
  identifiers: WorkIdentifiers,
  matchedBy: "doi" | "arxiv" | "title",
): NASAADSRecord | null {
  if (!records.length) return null;
  if (matchedBy === "doi") {
    const wanted = normalizeDOI(identifiers.doi);
    return (
      records.find((record) =>
        (record.doi ?? []).some((doi) => normalizeDOI(doi) === wanted),
      ) ?? records[0]
    );
  }
  if (matchedBy === "arxiv") {
    const wanted = String(identifiers.arxiv ?? "")
      .replace(/^arxiv:\s*/i, "")
      .replace(/v\d+$/i, "")
      .toLocaleLowerCase();
    return (
      records.find(
        (record) =>
          String(arxivID(record.identifier) ?? "").toLocaleLowerCase() === wanted,
      ) ?? records[0]
    );
  }
  const wanted = normalizeExactTitle(identifiers.title);
  return (
    records.find((record) => normalizeExactTitle(title(record)) === wanted) ??
    null
  );
}

function queryForIdentifiers(
  identifiers: WorkIdentifiers,
  titleOnly = false,
): { query: string; matchedBy: "doi" | "arxiv" | "title" } | null {
  if (!titleOnly && identifiers.doi) {
    return {
      query: `doi:"${escapeQueryValue(identifiers.doi)}"`,
      matchedBy: "doi",
    };
  }
  if (!titleOnly && identifiers.arxiv) {
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
  options?: ProviderRequestOptions,
  titleOnly = false,
): Promise<ProviderLookupResult> {
  const target = queryForIdentifiers(identifiers, titleOnly);
  if (!target) {
    return {
      status: "no-identifier",
      provider: "ads",
      message: "NASA ADS needs a DOI, arXiv ID, or title.",
    };
  }

  const response = await requestNASAADS(target.query, 5, 0, options);
  if (!response.ok) {
    return {
      status: failureStatusFromHTTP(response.status),
      provider: "ads",
      message: response.message || "NASA ADS request failed.",
    };
  }

  const record = matchRecord(
    collectNASAADSRecords(response.data),
    identifiers,
    target.matchedBy,
  );
  if (!record) {
    return {
      status: "not-found",
      provider: "ads",
      message: "NASA ADS did not return a matching work.",
    };
  }

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
    doi: work.doi,
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
  offset = 0,
  options?: ProviderRequestOptions,
): Promise<RelatedWorkMetadata[]> {
  const query = `${relation}(bibcode:"${escapeQueryValue(bibcode)}")`;
  const response = await requestNASAADS(query, maximum, offset, options);
  if (!response.ok) return [];
  return collectNASAADSRecords(response.data)
    .map(nasaADSWork)
    .filter((work): work is RelatedWorkMetadata => Boolean(work));
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
  lookup: (identifiers, options) => lookup(identifiers, options),
  lookupForRelations: (identifiers, options) => lookup(identifiers, options),
  searchExactTitle: (identifiers, options) => lookup(identifiers, options, true),
  fetchCitingWorks: (bibcode, maximum, offset, options) =>
    fetchRelations(bibcode, "citations", maximum, offset, options),
  fetchReferencedWorks: (bibcode, maximum, offset, options) =>
    fetchRelations(bibcode, "references", maximum, offset, options),
};
