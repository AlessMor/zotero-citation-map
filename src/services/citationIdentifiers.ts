import type { WorkIdentifiers } from "../domain/citationTypes";
import {
  normalizeDOI,
  normalizeExactTitle,
  normalizeISBN,
} from "../domain/workIdentity";

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
  return item
    .getCreators()
    .filter(
      (creator: _ZoteroTypes.Item.Creator) =>
        Zotero.CreatorTypes.getName(creator.creatorTypeID) !== "editor",
    )
    .map((creator: _ZoteroTypes.Item.Creator) =>
      [creator.firstName, creator.lastName].filter(Boolean).join(" ").trim(),
    )
    .filter(Boolean);
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
