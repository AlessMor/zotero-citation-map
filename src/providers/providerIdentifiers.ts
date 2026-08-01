import type {
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { normalizeDOI } from "../domain/workIdentity";

function prefixedIdentifier(prefix: string, value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized ? `${prefix}:${normalized}` : null;
}

export function shortOpenAlexID(value: unknown): string | null {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^https?:\/\/openalex\.org\//i, "");
  return normalized || null;
}

export function semanticScholarIdentifierForWork(
  work: RelatedWorkMetadata,
): string | null {
  if (work.provider === "semantic-scholar") {
    const providerWorkID = String(work.providerWorkID ?? "").trim();
    if (providerWorkID) return providerWorkID;
  }
  const doi = normalizeDOI(work.doi);
  return (
    (doi ? `DOI:${doi}` : null) ??
    prefixedIdentifier("PMID", work.pmid) ??
    prefixedIdentifier("ARXIV", work.arxiv) ??
    prefixedIdentifier("ISBN", work.isbn)
  );
}

export function openAlexIdentifierForWork(
  work: RelatedWorkMetadata,
): string | null {
  if (work.provider === "openalex") {
    const providerWorkID = shortOpenAlexID(work.providerWorkID);
    if (providerWorkID) return providerWorkID;
  }
  const doi = normalizeDOI(work.doi);
  return doi ? `DOI:${doi}` : null;
}

export function semanticScholarIdentifierForIdentifiers(
  identifiers: WorkIdentifiers,
): string | null {
  const doi = normalizeDOI(identifiers.doi);
  return (
    (doi ? `DOI:${doi}` : null) ??
    prefixedIdentifier("PMID", identifiers.pmid) ??
    prefixedIdentifier("ARXIV", identifiers.arxiv) ??
    prefixedIdentifier("ISBN", identifiers.isbn)
  );
}

export function openAlexIdentifierForIdentifiers(
  identifiers: WorkIdentifiers,
): string | null {
  const doi = normalizeDOI(identifiers.doi);
  return doi ? `DOI:${doi}` : null;
}
