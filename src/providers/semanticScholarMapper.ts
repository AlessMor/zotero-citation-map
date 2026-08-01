import type { RelatedWorkMetadata } from "../domain/citationTypes";
import { publicationYearOrNull } from "../domain/valueNormalization";
import { normalizeDOI } from "../domain/workIdentity";
import {
  stampRelatedWorkFieldGroups,
  type RelatedWorkFieldGroup,
} from "../services/relatedWorkHydrationState";
import { numberOrNull, stringOrNull } from "./types";

export interface SemanticScholarAuthor {
  authorId?: string;
  name?: string;
}

export interface SemanticScholarPaper {
  paperId?: string;
  externalIds?: { DOI?: string; PubMed?: string; ArXiv?: string };
  title?: string;
  abstract?: string;
  year?: number;
  publicationDate?: string;
  authors?: SemanticScholarAuthor[];
  venue?: string;
  publicationVenue?: { name?: string };
  citationCount?: number;
  referenceCount?: number;
  influentialCitationCount?: number;
  isOpenAccess?: boolean;
  openAccessPdf?: { url?: string } | null;
  publicationTypes?: string[];
  matchScore?: number;
}

export function semanticScholarAuthors(paper: SemanticScholarPaper): string[] {
  return (paper.authors ?? [])
    .map((author) => String(author.name ?? "").trim())
    .filter(Boolean);
}

export function semanticScholarWork(
  paper: SemanticScholarPaper,
): RelatedWorkMetadata | null {
  const providerWorkID = stringOrNull(paper.paperId);
  const title = stringOrNull(paper.title);
  if (!providerWorkID || !title) return null;
  const groups: RelatedWorkFieldGroup[] = ["summary"];
  if (paper.abstract !== undefined) groups.push("abstract");
  if (paper.influentialCitationCount !== undefined) {
    groups.push("normalized-impact");
  }
  if (paper.isOpenAccess !== undefined) groups.push("open-access");
  if (paper.publicationTypes !== undefined) {
    groups.push("publication-details");
  }
  return stampRelatedWorkFieldGroups(
    {
      provider: "semantic-scholar",
      providerWorkID,
      doi: normalizeDOI(paper.externalIds?.DOI),
      pmid: stringOrNull(paper.externalIds?.PubMed),
      arxiv: stringOrNull(paper.externalIds?.ArXiv),
      isbn: null,
      title,
      year: publicationYearOrNull(paper.year),
      publicationDate: stringOrNull(paper.publicationDate),
      authors: semanticScholarAuthors(paper),
      authorIDs: (paper.authors ?? [])
        .map((author) => String(author.authorId ?? "").trim())
        .filter(Boolean),
      sourceTitle: stringOrNull(paper.publicationVenue?.name ?? paper.venue),
      abstract: stringOrNull(paper.abstract),
      citationCount: numberOrNull(paper.citationCount),
      referenceCount: numberOrNull(paper.referenceCount),
      influentialCitationCount: numberOrNull(paper.influentialCitationCount),
      isOpenAccess:
        typeof paper.isOpenAccess === "boolean" ? paper.isOpenAccess : null,
      openAccessStatus: paper.isOpenAccess ? "open" : null,
      publicationType: stringOrNull(paper.publicationTypes?.join(", ")),
      isRetracted: null,
      dataSources: ["semantic-scholar"],
    },
    groups,
  );
}

export function collectSemanticScholarPapers(
  data: unknown,
): SemanticScholarPaper[] {
  const found: SemanticScholarPaper[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.paperId === "string" && record.title) {
      found.push(record as SemanticScholarPaper);
      return;
    }
    visit(record.citedPaper);
    visit(record.citingPaper);
    visit(record.recommendedPapers);
    visit(record.data);
  };
  visit(data);
  return found;
}
