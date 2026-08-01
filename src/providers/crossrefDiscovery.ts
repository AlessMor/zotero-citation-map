import type {
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { normalizeDOI, normalizeExactTitle } from "../domain/workIdentity";
import { requestJSON } from "./http";
import { crossrefWorkMetadata, type CrossrefWork } from "./crossrefMapper";

interface CrossrefListResponse {
  message?: { items?: CrossrefWork[] };
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
      {},
    );
    if (!response.ok || !response.data?.message) continue;
    for (const raw of response.data.message.items ?? []) {
      const work = crossrefWorkMetadata(raw);
      if (!work) continue;
      const key = identity(work);
      if (key && !merged.has(key)) merged.set(key, work);
    }
  }

  return [...merged.values()].slice(0, requested);
}
