import type {
  ProviderLookupResult,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { normalizeDOI } from "../services/citationIdentifiers";
import { requestJSON } from "./http";
import type { CitationProvider } from "./types";
import { failureStatusFromHTTP, numberOrNull, stringOrNull } from "./types";

interface InspireReference {
  reference?: {
    dois?: string[];
    arxiv_eprint?: string;
    label?: string;
    publication_info?: { year?: number };
  };
  raw_refs?: Array<{ source?: string }>;
}
interface InspireRecord {
  id?: string | number;
  metadata?: {
    titles?: Array<{ title?: string }>;
    abstracts?: Array<{ value?: string }>;
    document_type?: string[];
    citation_count?: number;
    citation_count_without_self_citations?: number;
    reference_count?: number;
    references?: InspireReference[];
    dois?: Array<{ value?: string }>;
    arxiv_eprints?: Array<{ value?: string }>;
    authors?: Array<{ full_name?: string }>;
    publication_info?: Array<{ year?: number; journal_title?: string }>;
    earliest_date?: string;
  };
}
interface InspireResponse {
  hits?: { hits?: InspireRecord[] };
}

function queryFor(identifiers: WorkIdentifiers): string | null {
  if (identifiers.doi) return `doi:${identifiers.doi}`;
  if (identifiers.arxiv) return `arxiv:${identifiers.arxiv}`;
  return null;
}

function relationFromReference(
  reference: InspireReference,
): RelatedWorkMetadata | null {
  const doi = normalizeDOI(reference.reference?.dois?.[0]);
  const raw =
    reference.raw_refs?.[0]?.source ?? reference.reference?.label ?? null;
  if (!doi && !raw) return null;
  return {
    provider: "inspire",
    providerWorkID: doi ?? reference.reference?.arxiv_eprint ?? null,
    doi,
    arxiv: reference.reference?.arxiv_eprint ?? null,
    title: raw,
    year: reference.reference?.publication_info?.year ?? null,
    authors: [],
  };
}

export const inspireProvider: CitationProvider = {
  id: "inspire",
  label: "INSPIRE-HEP",
  capabilities: {
    identifiers: {
      doi: true,
      pmid: false,
      arxiv: true,
      isbn: false,
      titleSearch: false,
    },
    citationCount: true,
    referenceCount: true,
    citingWorks: false,
    referencedWorks: true,
    abstract: true,
    openAccess: false,
    retraction: false,
    sourceMetrics: false,
  },
  supports: (identifiers) => Boolean(queryFor(identifiers)),
  lookup: async (identifiers): Promise<ProviderLookupResult> => {
    const query = queryFor(identifiers);
    if (!query) {
      return {
        status: "no-identifier",
        provider: "inspire",
        message: "INSPIRE-HEP needs a DOI or arXiv ID.",
      };
    }
    const response = await requestJSON<InspireResponse>(
      "inspire",
      `https://inspirehep.net/api/literature?q=${encodeURIComponent(query)}&size=2`,
    );
    const hit = response.data?.hits?.hits?.[0];
    if (!response.ok || !hit?.metadata) {
      return {
        status: failureStatusFromHTTP(response.status),
        provider: "inspire",
        message: response.message || "INSPIRE-HEP did not return a work.",
      };
    }
    const metadata = hit.metadata;
    const references = (metadata.references ?? [])
      .map(relationFromReference)
      .filter((work): work is RelatedWorkMetadata => Boolean(work));
    const dateYear = Number(String(metadata.earliest_date ?? "").slice(0, 4));
    return {
      status: "success",
      provider: "inspire",
      matchedBy: identifiers.doi ? "doi" : "arxiv",
      matchConfidence: 1,
      providerWorkID: String(hit.id ?? "") || null,
      doi: normalizeDOI(metadata.dois?.[0]?.value ?? identifiers.doi),
      title: stringOrNull(metadata.titles?.[0]?.title),
      year:
        metadata.publication_info?.[0]?.year ??
        (Number.isFinite(dateYear) ? dateYear : null),
      authors: (metadata.authors ?? [])
        .map((author) => String(author.full_name ?? "").trim())
        .filter(Boolean),
      sourceTitle: stringOrNull(metadata.publication_info?.[0]?.journal_title),
      abstract: stringOrNull(metadata.abstracts?.[0]?.value),
      citationCount: numberOrNull(metadata.citation_count),
      citationCountProvider: "inspire",
      referenceCount:
        numberOrNull(metadata.reference_count) ?? references.length,
      referenceCountProvider: "inspire",
      resolvedReferenceCount: references.length,
      references,
      influentialCitationCount: null,
      publicationType: stringOrNull(metadata.document_type?.join(", ")),
      sourceMetrics: null,
    };
  },
};
