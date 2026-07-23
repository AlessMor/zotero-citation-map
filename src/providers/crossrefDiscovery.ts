import type {
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import {
  normalizeDOI,
  normalizeExactTitle,
} from "../services/citationIdentifiers";
import { requestJSON } from "./http";
import { numberOrNull, stringOrNull } from "./types";

interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string;
}

interface CrossrefWork {
  DOI?: string;
  title?: string[];
  author?: CrossrefAuthor[];
  published?: { "date-parts"?: number[][] };
  issued?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  abstract?: string;
  "is-referenced-by-count"?: number;
  "reference-count"?: number;
}

interface CrossrefListResponse {
  message?: { items?: CrossrefWork[] };
}

function yearFromWork(work: CrossrefWork): number | null {
  const parts = work.published?.["date-parts"] ?? work.issued?.["date-parts"];
  const year = parts?.[0]?.[0];
  return Number.isFinite(year) ? Number(year) : null;
}

function authorNames(work: CrossrefWork): string[] {
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

function toRelated(work: CrossrefWork): RelatedWorkMetadata | null {
  const title = stringOrNull(work.title?.[0]);
  if (!title) return null;
  return {
    provider: "crossref",
    providerWorkID: normalizeDOI(work.DOI),
    doi: normalizeDOI(work.DOI),
    title,
    year: yearFromWork(work),
    authors: authorNames(work),
    sourceTitle: stringOrNull(work["container-title"]?.[0]),
    abstract: stripMarkup(work.abstract),
    citationCount: numberOrNull(work["is-referenced-by-count"]),
    referenceCount: numberOrNull(work["reference-count"]),
  };
}

function identity(work: RelatedWorkMetadata): string | null {
  const doi = normalizeDOI(work.doi);
  if (doi) return `doi:${doi}`;
  const title = normalizeExactTitle(work.title);
  return title ? `title:${title}:year:${work.year ?? "unknown"}` : null;
}

/** Crossref has no recommendation endpoint. This provides a provider-only
 * bibliographic-relevance fallback that works with a title-only Zotero item. */
export async function fetchCrossrefRelatedWorks(
  seeds: WorkIdentifiers[],
  maximum = 100,
): Promise<RelatedWorkMetadata[]> {
  const requested = Math.min(1000, Math.max(1, Math.floor(maximum)));
  const perSeed = Math.min(
    100,
    Math.max(20, Math.ceil(requested / Math.max(1, seeds.length))),
  );
  const merged = new Map<string, RelatedWorkMetadata>();

  for (const seed of seeds.slice(0, 10)) {
    const query = [
      seed.title,
      seed.authors.slice(0, 2).join(" "),
      seed.year === null ? "" : String(seed.year),
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!query) continue;

    const response = await requestJSON<CrossrefListResponse>(
      "crossref",
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${perSeed}&sort=relevance`,
    );
    if (!response.ok || !response.data?.message) continue;
    for (const raw of response.data.message.items ?? []) {
      const work = toRelated(raw);
      if (!work) continue;
      const key = identity(work);
      if (key && !merged.has(key)) merged.set(key, work);
    }
  }

  return [...merged.values()].slice(0, requested);
}
