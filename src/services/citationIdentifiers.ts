import type {
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";

export function normalizeDOI(value: unknown): string | null {
  const text = String(value ?? "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim()
    .toLowerCase();
  const match = text.match(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/i);
  return match ? match[0].replace(/[.,;]+$/, "").toLowerCase() : null;
}

function normalizePMID(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const match = text.match(/(?:pmid\s*[:=]?\s*)?(\d{5,10})/i);
  return match ? match[1] : null;
}

function normalizeArxiv(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const match = text.match(
    /(?:arxiv\s*[:=]?\s*|arxiv\.org\/(?:abs|pdf)\/)?([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i,
  );
  return match ? match[1].toLowerCase() : null;
}

function normalizeISBN(value: unknown): string | null {
  const compact = String(value ?? "")
    .replace(/[^0-9Xx]/g, "")
    .toUpperCase();
  return compact.length === 10 || compact.length === 13 ? compact : null;
}

export function normalizeExactTitle(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeIdentifier(value: unknown): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLocaleLowerCase();
  return normalized || null;
}

export function relatedWorkStableAliases(work: RelatedWorkMetadata): string[] {
  const aliases: string[] = [];
  const localKey = normalizeIdentifier(
    work.inLibraryItemKey ?? work.zoteroItemKey,
  );
  if (localKey) aliases.push(`zotero:${localKey.toLocaleUpperCase()}`);
  const doi = normalizeDOI(work.doi);
  if (doi) aliases.push(`doi:${doi}`);
  const pmid = normalizeIdentifier(work.pmid);
  if (pmid) aliases.push(`pmid:${pmid}`);
  const arxiv = normalizeIdentifier(work.arxiv);
  if (arxiv) aliases.push(`arxiv:${arxiv}`);
  const isbn = normalizeIdentifier(work.isbn);
  if (isbn) aliases.push(`isbn:${isbn.replace(/[-\s]/g, "")}`);
  const providerWorkID = normalizeIdentifier(work.providerWorkID);
  if (providerWorkID) aliases.push(`${work.provider}:${providerWorkID}`);
  return aliases;
}

export function relatedWorkMetadataAliases(
  work: RelatedWorkMetadata,
): string[] {
  const aliases = relatedWorkStableAliases(work);
  const title = normalizeExactTitle(work.title);
  if (title) aliases.push(`title:${title}:year:${work.year ?? "unknown"}`);
  return aliases;
}

export function externalWorkCacheIdentity(
  work: RelatedWorkMetadata,
): string | null {
  const doi = normalizeDOI(work.doi);
  if (doi) return `doi:${doi}`;
  const providerWorkID = String(work.providerWorkID ?? "").trim();
  if (providerWorkID) return `${work.provider}:${providerWorkID}`;
  const title = normalizeExactTitle(work.title);
  return title ? `title:${title}` : null;
}

function getExtraLines(item: Zotero.Item): string[] {
  return String(item.getField("extra") ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function firstExtraValue(lines: string[], labels: RegExp[]): string | null {
  for (const line of lines) {
    for (const label of labels) {
      const match = line.match(label);
      if (match?.[1]) return match[1].trim();
    }
  }
  return null;
}

function extractYear(item: Zotero.Item): number | null {
  const raw = String(item.getField("date") ?? "");
  const match = raw.match(/(?:^|\D)(1[5-9]\d{2}|20\d{2}|21\d{2})(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

function extractAuthors(item: Zotero.Item): string[] {
  try {
    return item
      .getCreators()
      .filter((creator: any) => creator.creatorType !== "editor")
      .map((creator: any) =>
        String(
          creator.name ??
            [creator.firstName, creator.lastName].filter(Boolean).join(" "),
        ).trim(),
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function extractWorkIdentifiers(item: Zotero.Item): WorkIdentifiers {
  const extra = getExtraLines(item);
  const title = String(item.getField("title") ?? "").trim();
  const doi =
    normalizeDOI(item.getField("DOI")) ??
    normalizeDOI(item.getField("url")) ??
    normalizeDOI(firstExtraValue(extra, [/^DOI\s*:\s*(.+)$/i]));
  const pmid = normalizePMID(
    firstExtraValue(extra, [/^PMID\s*:\s*(.+)$/i, /^PubMed ID\s*:\s*(.+)$/i]),
  );
  const arxiv =
    normalizeArxiv(
      firstExtraValue(extra, [/^arXiv\s*:\s*(.+)$/i, /^arXiv ID\s*:\s*(.+)$/i]),
    ) ?? normalizeArxiv(item.getField("archiveLocation"));
  const isbn =
    normalizeISBN(item.getField("ISBN")) ??
    normalizeISBN(firstExtraValue(extra, [/^ISBN\s*:\s*(.+)$/i]));
  return {
    doi,
    pmid,
    arxiv,
    isbn,
    title,
    normalizedTitle: normalizeExactTitle(title),
    year: extractYear(item),
    authors: extractAuthors(item),
    sourceTitle:
      String(
        item.getField("publicationTitle") ||
          item.getField("proceedingsTitle") ||
          "",
      ).trim() || null,
  };
}

function surname(value: string): string {
  return normalizeExactTitle(value).split(" ").at(-1) ?? "";
}

export function metadataIsNonContradictory(
  requested: WorkIdentifiers,
  candidate: { year: number | null; authors: string[] },
): boolean {
  if (
    requested.year !== null &&
    candidate.year !== null &&
    Math.abs(requested.year - candidate.year) > 2
  ) {
    return false;
  }
  if (requested.authors.length > 0 && candidate.authors.length > 0) {
    const requestedSurnames = new Set(
      requested.authors.map(surname).filter(Boolean),
    );
    const overlaps = candidate.authors.some((author) =>
      requestedSurnames.has(surname(author)),
    );
    if (!overlaps) return false;
  }
  return true;
}
