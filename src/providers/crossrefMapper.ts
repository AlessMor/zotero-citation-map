import type { RelatedWorkMetadata } from "../domain/citationTypes";
import { publicationYearOrNull } from "../domain/valueNormalization";
import { normalizeDOI } from "../domain/workIdentity";
import { publicationDateFromParts } from "./publicationDate";
import { numberOrNull, stringOrNull } from "./types";

export interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string;
}

export interface CrossrefReference {
  DOI?: string;
  doi?: string;
  "article-title"?: string;
  author?: string;
  year?: string;
  "journal-title"?: string;
}

export interface CrossrefWork {
  DOI?: string;
  title?: string[];
  author?: CrossrefAuthor[];
  published?: { "date-parts"?: number[][] };
  issued?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  abstract?: string;
  type?: string;
  "is-referenced-by-count"?: number;
  "reference-count"?: number;
  reference?: CrossrefReference[];
  license?: Array<{ URL?: string; "delay-in-days"?: number }>;
  "update-to"?: Array<{ type?: string; DOI?: string; label?: string }>;
  relation?: Record<string, Array<{ id?: string; "id-type"?: string }>>;
}

function crossrefYear(work: CrossrefWork): number | null {
  const parts = work.published?.["date-parts"] ?? work.issued?.["date-parts"];
  return publicationYearOrNull(parts?.[0]?.[0]);
}

function crossrefAuthors(work: CrossrefWork): string[] {
  return (work.author ?? [])
    .map((author) =>
      String(
        author.name ?? [author.given, author.family].filter(Boolean).join(" "),
      ).trim(),
    )
    .filter(Boolean);
}

function stripMarkup(value: unknown): string | null {
  const text = String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function relationIsRetraction(work: CrossrefWork): boolean {
  if (
    (work["update-to"] ?? []).some((entry) =>
      /retract/i.test(`${entry.type ?? ""} ${entry.label ?? ""}`),
    )
  ) {
    return true;
  }
  return Object.keys(work.relation ?? {}).some((key) => /retract/i.test(key));
}

export function crossrefReferenceMetadata(
  reference: CrossrefReference,
): RelatedWorkMetadata {
  return {
    provider: "crossref",
    providerWorkID: normalizeDOI(reference.DOI ?? reference.doi),
    doi: normalizeDOI(reference.DOI ?? reference.doi),
    title: stringOrNull(reference["article-title"]),
    year: publicationYearOrNull(reference.year),
    authors: reference.author ? [reference.author] : [],
    sourceTitle: stringOrNull(reference["journal-title"]),
    dataSources: ["crossref"],
  };
}

export function crossrefWorkMetadata(
  work: CrossrefWork,
): RelatedWorkMetadata | null {
  const title = stringOrNull(work.title?.[0]);
  if (!title) return null;
  return {
    provider: "crossref",
    providerWorkID: normalizeDOI(work.DOI),
    doi: normalizeDOI(work.DOI),
    title,
    year: crossrefYear(work),
    publicationDate: publicationDateFromParts(work),
    authors: crossrefAuthors(work),
    sourceTitle: stringOrNull(work["container-title"]?.[0]),
    abstract: stripMarkup(work.abstract),
    citationCount: numberOrNull(work["is-referenced-by-count"]),
    referenceCount: numberOrNull(work["reference-count"]),
    isRetracted: relationIsRetraction(work),
    isOpenAccess: (work.license ?? []).some(
      (license) =>
        license["delay-in-days"] === 0 ||
        /creativecommons|open/i.test(String(license.URL ?? "")),
    ),
    dataSources: ["crossref"],
  };
}

export function collectCrossrefWorks(data: unknown): CrossrefWork[] {
  const found: CrossrefWork[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.title)) {
      found.push(record as CrossrefWork);
      return;
    }
    visit(record.message);
    visit(record.items);
  };
  visit(data);
  return found;
}
