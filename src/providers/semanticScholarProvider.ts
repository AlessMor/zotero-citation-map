import type {
  IdentifierKind,
  ProviderLookupResult,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { normalizeDOI } from "../services/citationIdentifiers";
import { requestJSON } from "./http";
import type { CitationProvider } from "./types";
import { failureStatusFromHTTP, numberOrNull, stringOrNull } from "./types";

interface SemanticScholarPaper {
  paperId?: string;
  title?: string | null;
  year?: number | null;
  citationCount?: number | null;
  influentialCitationCount?: number | null;
  referenceCount?: number | null;
  isOpenAccess?: boolean | null;
  publicationTypes?: string[] | null;
  authors?: Array<{ name?: string | null }>;
  externalIds?: {
    DOI?: string | null;
    ArXiv?: string | null;
    PubMed?: string | null;
  } | null;
  references?: SemanticScholarPaper[] | null;
}

function getLookupIdentifier(identifiers: WorkIdentifiers): {
  kind: IdentifierKind;
  value: string;
  apiValue: string;
} | null {
  if (identifiers.doi) {
    return {
      kind: "doi",
      value: identifiers.doi,
      apiValue: `DOI:${identifiers.doi}`,
    };
  }
  if (identifiers.arxiv) {
    return {
      kind: "arxiv",
      value: identifiers.arxiv,
      apiValue: `ARXIV:${identifiers.arxiv}`,
    };
  }
  if (identifiers.pmid) {
    return {
      kind: "pmid",
      value: identifiers.pmid,
      apiValue: `PMID:${identifiers.pmid}`,
    };
  }
  return null;
}

function getAuthors(paper: SemanticScholarPaper): string[] {
  return (paper.authors ?? [])
    .map((author) => stringOrNull(author.name))
    .filter((name): name is string => Boolean(name));
}

function getDOI(paper: SemanticScholarPaper): string | null {
  return normalizeDOI(paper.externalIds?.DOI);
}

function mapReferences(
  references: SemanticScholarPaper[] | null | undefined,
): RelatedWorkMetadata[] {
  return (references ?? [])
    .filter((paper) => Boolean(paper?.paperId || paper?.title))
    .map((paper) => ({
      providerWorkID: stringOrNull(paper.paperId),
      doi: getDOI(paper),
      title: stringOrNull(paper.title),
      year: numberOrNull(paper.year),
      authors: getAuthors(paper),
    }));
}

export const semanticScholarProvider: CitationProvider = {
  id: "semantic-scholar",
  label: "Semantic Scholar",

  supports(identifiers) {
    return Boolean(identifiers.doi || identifiers.arxiv || identifiers.pmid);
  },

  async lookup(identifiers: WorkIdentifiers): Promise<ProviderLookupResult> {
    const lookup = getLookupIdentifier(identifiers);

    if (!lookup) {
      return {
        status: "no-identifier",
        provider: "semantic-scholar",
        message: "Semantic Scholar requires a DOI, PMID, or arXiv ID.",
      };
    }

    const fields = [
      "title",
      "year",
      "authors",
      "externalIds",
      "citationCount",
      "influentialCitationCount",
      "referenceCount",
      "isOpenAccess",
      "publicationTypes",
      "references.paperId",
      "references.title",
      "references.year",
      "references.authors",
      "references.externalIds",
    ].join(",");

    const url =
      "https://api.semanticscholar.org/graph/v1/paper/" +
      `${encodeURIComponent(lookup.apiValue)}?fields=${encodeURIComponent(fields)}`;

    const response = await requestJSON<SemanticScholarPaper>(
      "semantic-scholar",
      url,
    );

    if (!response.ok || !response.data) {
      return {
        status: failureStatusFromHTTP(response.status),
        provider: "semantic-scholar",
        message: response.message,
      };
    }

    const paper = response.data;
    const references = mapReferences(paper.references);

    return {
      status: "success",
      provider: "semantic-scholar",
      matchedBy: lookup.kind,
      providerWorkID: stringOrNull(paper.paperId),
      doi: getDOI(paper),
      title: stringOrNull(paper.title),
      year: numberOrNull(paper.year),
      authors: getAuthors(paper),
      citationCount: numberOrNull(paper.citationCount),
      citationCountProvider: "semantic-scholar",
      referenceCount: numberOrNull(paper.referenceCount),
      referenceCountProvider: "semantic-scholar",
      resolvedReferenceCount: references.length,
      references,
      influentialCitationCount: numberOrNull(paper.influentialCitationCount),
      isOpenAccess:
        typeof paper.isOpenAccess === "boolean" ? paper.isOpenAccess : null,
      openAccessStatus:
        typeof paper.isOpenAccess === "boolean"
          ? paper.isOpenAccess
            ? "open"
            : "closed"
          : null,
      publicationType: stringOrNull(paper.publicationTypes?.[0]),
    };
  },
};
