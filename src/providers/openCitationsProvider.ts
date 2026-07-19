import type {
  ProviderLookupResult,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { normalizeDOI } from "../services/citationIdentifiers";
import { requestJSON } from "./http";
import type { CitationProvider } from "./types";
import { failureStatusFromHTTP, numberOrNull, stringOrNull } from "./types";

const BACKGROUND_REFERENCE_LIMIT = 200;
const MAX_RELATION_RESULTS = 200;

interface OCMetadata {
  doi?: string;
  title?: string;
  author?: string;
  year?: string;
  source_title?: string;
  citation_count?: string | number;
  reference_count?: string | number;
}
interface OCLink {
  citing?: string;
  cited?: string;
  creation?: string;
  author_sc?: string;
  timespan?: string;
}

function relatedFromLink(
  link: OCLink,
  direction: "citations" | "references",
): RelatedWorkMetadata | null {
  const doi = normalizeDOI(
    direction === "citations" ? link.citing : link.cited,
  );
  if (!doi) return null;
  return {
    provider: "opencitations",
    providerWorkID: doi,
    doi,
    title: null,
    year: link.creation
      ? Number(String(link.creation).slice(0, 4)) || null
      : null,
    authors: [],
  };
}

async function fetchLinks(
  doi: string,
  direction: "citations" | "references",
  maximum: number,
  offset = 0,
): Promise<RelatedWorkMetadata[]> {
  const response = await requestJSON<OCLink[]>(
    "opencitations",
    `https://opencitations.net/index/coci/api/v1/${direction}/${encodeURIComponent(doi)}`,
  );
  if (!response.ok || !Array.isArray(response.data)) return [];
  return response.data
    .slice(offset, offset + Math.min(MAX_RELATION_RESULTS, maximum))
    .map((link) => relatedFromLink(link, direction))
    .filter((work): work is RelatedWorkMetadata => Boolean(work));
}

export const openCitationsProvider: CitationProvider = {
  id: "opencitations",
  label: "OpenCitations",
  capabilities: {
    identifiers: {
      doi: true,
      pmid: false,
      arxiv: false,
      isbn: false,
      titleSearch: false,
    },
    citationCount: true,
    referenceCount: true,
    citingWorks: true,
    referencedWorks: true,
    abstract: false,
    openAccess: false,
    retraction: false,
    sourceMetrics: false,
  },
  supports: (identifiers) => Boolean(identifiers.doi),
  lookup: async (
    identifiers: WorkIdentifiers,
  ): Promise<ProviderLookupResult> => {
    if (!identifiers.doi) {
      return {
        status: "no-identifier",
        provider: "opencitations",
        message: "OpenCitations needs a DOI.",
      };
    }
    const response = await requestJSON<OCMetadata[]>(
      "opencitations",
      `https://opencitations.net/index/coci/api/v1/metadata/${encodeURIComponent(identifiers.doi)}`,
    );
    const metadata = Array.isArray(response.data) ? response.data[0] : null;
    if (!response.ok || !metadata) {
      return {
        status: failureStatusFromHTTP(response.status),
        provider: "opencitations",
        message: response.message || "OpenCitations did not return a work.",
      };
    }
    const references = await fetchLinks(
      identifiers.doi,
      "references",
      BACKGROUND_REFERENCE_LIMIT,
    );
    const year = Number(metadata.year);
    return {
      status: "success",
      provider: "opencitations",
      matchedBy: "doi",
      matchConfidence: 1,
      providerWorkID: identifiers.doi,
      doi: identifiers.doi,
      title: stringOrNull(metadata.title),
      year: Number.isFinite(year) ? year : null,
      authors: metadata.author
        ? metadata.author
            .split(";")
            .map((author) => author.trim())
            .filter(Boolean)
        : [],
      sourceTitle: stringOrNull(metadata.source_title),
      abstract: null,
      citationCount: numberOrNull(metadata.citation_count),
      citationCountProvider: "opencitations",
      referenceCount:
        numberOrNull(metadata.reference_count) ?? references.length,
      referenceCountProvider: "opencitations",
      resolvedReferenceCount: references.length,
      references,
      sourceMetrics: null,
    };
  },
  fetchCitingWorks: (doi, maximum, offset) =>
    fetchLinks(doi, "citations", maximum, offset),
  fetchReferencedWorks: (doi, maximum, offset) =>
    fetchLinks(doi, "references", maximum, offset),
};
