import type {
  CitationProviderID,
  RelatedWorkMetadata,
} from "../domain/citationTypes";

export type CitationDataSourceID =
  CitationProviderID | "zotero" | "citation-map" | "manual";

const PROVIDER_LABELS: Record<CitationDataSourceID, string> = {
  crossref: "Crossref",
  "semantic-scholar": "Semantic Scholar",
  opencitations: "OpenCitations",
  inspire: "INSPIRE-HEP",
  openalex: "OpenAlex",
  zotero: "Zotero",
  "citation-map": "Citation Map",
  manual: "Manual",
};

export function citationDataSourceLabel(
  provider: CitationDataSourceID,
): string {
  return PROVIDER_LABELS[provider];
}

export function externalWorkURL(
  work: Pick<RelatedWorkMetadata, "provider" | "providerWorkID" | "doi">,
): string | null {
  const doi = work.doi?.trim();
  if (doi) return `https://doi.org/${encodeURIComponent(doi)}`;

  const providerWorkID = work.providerWorkID?.trim();
  if (!providerWorkID) return null;

  switch (work.provider) {
    case "semantic-scholar":
      return `https://www.semanticscholar.org/paper/${encodeURIComponent(providerWorkID)}`;
    case "openalex":
      return providerWorkID.startsWith("http")
        ? providerWorkID
        : `https://openalex.org/${encodeURIComponent(providerWorkID)}`;
    case "inspire":
      return `https://inspirehep.net/literature/${encodeURIComponent(providerWorkID)}`;
    case "crossref":
    case "opencitations":
      return providerWorkID.includes("/")
        ? `https://doi.org/${encodeURIComponent(providerWorkID)}`
        : null;
    case "manual":
    case "zotero":
      return null;
  }
}
