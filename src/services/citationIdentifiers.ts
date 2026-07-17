import type { WorkIdentifiers } from "../domain/citationTypes";

function getField(item: Zotero.Item, field: string): string {
  try {
    return String(item.getField(field) ?? "").trim();
  } catch {
    return "";
  }
}

export function normalizeDOI(value: unknown): string | null {
  const text = String(value ?? "")
    .trim()
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[\s.,;]+$/g, "");

  const match = text.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return match ? match[0].toLowerCase() : null;
}

export function normalizePMID(value: unknown): string | null {
  const match = String(value ?? "").match(/(?:pmid:\s*)?(\d{1,10})/i);
  return match ? match[1] : null;
}

export function normalizeArxiv(value: unknown): string | null {
  const text = String(value ?? "")
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/^arxiv:\s*/i, "")
    .replace(/\.pdf$/i, "")
    .replace(/v\d+$/i, "")
    .trim();

  const match = text.match(/(?:[a-z-]+\/\d{7}|\d{4}\.\d{4,5})/i);
  return match ? match[0] : null;
}

export function normalizeISBN(value: unknown): string | null {
  const cleaned = String(value ?? "")
    .replace(/^isbn:\s*/i, "")
    .replace(/[\s-]/g, "")
    .toUpperCase();

  if (/^\d{13}$/.test(cleaned) || /^\d{9}[\dX]$/.test(cleaned)) {
    return cleaned;
  }

  return null;
}

function extractYear(value: unknown): number | null {
  const match = String(value ?? "").match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? Number(match[0]) : null;
}

function extractAuthors(item: Zotero.Item): string[] {
  try {
    return (item.getCreators?.() ?? [])
      .map((creator: any) => {
        if (creator.name) {
          return String(creator.name).trim();
        }

        return [creator.firstName, creator.lastName]
          .map((part) => String(part ?? "").trim())
          .filter(Boolean)
          .join(" ");
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function extractDOI(
  item: Zotero.Item,
  extra: string,
  url: string,
): string | null {
  return (
    normalizeDOI(getField(item, "DOI")) ??
    normalizeDOI(extra) ??
    normalizeDOI(url)
  );
}

function extractPMID(extra: string, url: string): string | null {
  const extraMatch = extra.match(/^pmid:\s*(\d{1,10})\s*$/im);
  if (extraMatch) {
    return extraMatch[1];
  }

  const urlMatch = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{1,10})/i);
  return urlMatch ? urlMatch[1] : null;
}

function extractArxiv(
  item: Zotero.Item,
  extra: string,
  url: string,
  doi: string | null,
): string | null {
  const archiveID = normalizeArxiv(getField(item, "archiveID"));
  if (archiveID) {
    return archiveID;
  }

  const extraMatch = extra.match(/^arxiv:\s*(\S+)\s*$/im);
  if (extraMatch) {
    return normalizeArxiv(extraMatch[1]);
  }

  const urlID = normalizeArxiv(url);
  if (urlID) {
    return urlID;
  }

  const arxivDOI = doi?.match(/^10\.48550\/arxiv\.(.+)$/i);
  return arxivDOI ? normalizeArxiv(arxivDOI[1]) : null;
}

export function extractWorkIdentifiers(item: Zotero.Item): WorkIdentifiers {
  const extra = getField(item, "extra");
  const url = getField(item, "url");
  const doi = extractDOI(item, extra, url);

  return {
    doi,
    pmid: extractPMID(extra, url),
    arxiv: extractArxiv(item, extra, url, doi),
    isbn: normalizeISBN(getField(item, "ISBN")),
    title:
      String(item.getDisplayTitle?.() ?? "").trim() ||
      getField(item, "title") ||
      `Untitled item ${item.id}`,
    year: extractYear(getField(item, "date")),
    authors: extractAuthors(item),
  };
}
