import type { RelatedWorkMetadata, WorkIdentifiers } from "./citationTypes";
import type { CitationGraphNode } from "./graphTypes";

export type WorkMatchDecision =
  "same-work" | "different-work" | "possible-version" | "ambiguous";

export interface WorkMatchResult {
  decision: WorkMatchDecision;
  reason: string;
  sharedAliases: string[];
  conflictingNamespaces: string[];
  identityConflict: boolean;
}

interface WorkIdentityEvidence {
  provider: RelatedWorkMetadata["provider"];
  includesLocal: boolean;
  providerWorkID: string | null;
  doi: string | null;
  pmid: string | null;
  arxiv: string | null;
  isbn: string | null;
  title: string;
  year: number | null;
  authors: string[];
  localAlias: string | null;
}

interface IdentifierComparison {
  sharedAliases: string[];
  conflictingNamespaces: string[];
}

export function normalizeDOI(value: unknown): string | null {
  const text = String(value ?? "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim()
    .toLocaleLowerCase();
  const match = text.match(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/i);
  return match ? match[0].replace(/[.,;]+$/, "").toLocaleLowerCase() : null;
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

export function normalizeProviderWorkID(
  provider: RelatedWorkMetadata["provider"],
  value: unknown,
): string | null {
  let normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (provider === "openalex") {
    normalized = normalized.replace(/^https?:\/\/openalex\.org\//i, "");
  } else if (provider === "semantic-scholar") {
    normalized = normalized.replace(
      /^https?:\/\/(?:www\.)?semanticscholar\.org\/paper\//i,
      "",
    );
  }
  return normalizeIdentifier(normalized);
}

export function normalizeISBN(value: unknown): string | null {
  const compact = String(value ?? "")
    .replace(/[^0-9Xx]/g, "")
    .toLocaleUpperCase();
  return compact.length === 10 || compact.length === 13 ? compact : null;
}

export function normalizedAuthorSurname(value: string): string {
  const normalized = normalizeExactTitle(value);
  return normalized.split(" ").at(-1) ?? normalized;
}

function normalizedAuthors(authors: readonly string[]): string[] {
  return authors.map(normalizedAuthorSurname).filter(Boolean);
}

function scopedLocalAlias(work: RelatedWorkMetadata): string | null {
  const libraryID = Number(work.zoteroLibraryID);
  const itemKey = String(work.inLibraryItemKey ?? work.zoteroItemKey ?? "")
    .trim()
    .toLocaleUpperCase();
  if (!Number.isInteger(libraryID) || libraryID <= 0 || !itemKey) return null;
  return `zotero:${libraryID}:${itemKey}`;
}

export function stableWorkAliases(work: RelatedWorkMetadata): string[] {
  const aliases: string[] = [];
  const doi = normalizeDOI(work.doi);
  if (doi) aliases.push(`doi:${doi}`);
  const pmid = normalizeIdentifier(work.pmid);
  if (pmid) aliases.push(`pmid:${pmid}`);
  const arxiv = normalizeIdentifier(work.arxiv);
  if (arxiv) aliases.push(`arxiv:${arxiv}`);
  const isbn = normalizeISBN(work.isbn);
  if (isbn) aliases.push(`isbn:${isbn}`);
  const providerWorkID = normalizeProviderWorkID(
    work.provider,
    work.providerWorkID,
  );
  if (
    providerWorkID &&
    work.provider !== "manual" &&
    work.provider !== "zotero"
  ) {
    aliases.push(`${work.provider}:${providerWorkID}`);
  }
  return [...new Set(aliases)];
}

export function stableExternalWorkIdentity(
  work: RelatedWorkMetadata,
): string | null {
  return stableWorkAliases(work)[0] ?? null;
}

export function relationshipStableAliases(work: RelatedWorkMetadata): string[] {
  const localAlias = scopedLocalAlias(work);
  return [...(localAlias ? [localAlias] : []), ...stableWorkAliases(work)];
}

export function bibliographicWorkAliases(work: RelatedWorkMetadata): string[] {
  const title = normalizeExactTitle(work.title);
  if (!title) return [];
  const authors = normalizedAuthors(work.authors);
  const first = authors[0];
  const second = authors[1];
  const aliases: string[] = [];
  if (first && work.year !== null) {
    aliases.push(`title-author-year:${title}:${first}:${work.year}`);
  }
  if (first && second) {
    aliases.push(`title-authors:${title}:${first}:${second}`);
  }
  if (first) aliases.push(`title-author:${title}:${first}`);
  return aliases;
}

export function workLookupAliases(work: RelatedWorkMetadata): string[] {
  return [
    ...new Set([
      ...relationshipStableAliases(work),
      ...bibliographicWorkAliases(work),
    ]),
  ];
}

export interface RelatedWorkLookupIndex<
  T extends RelatedWorkMetadata = RelatedWorkMetadata,
> {
  readonly byAlias: ReadonlyMap<string, readonly T[]>;
}

/**
 * Index relationship records by the same stable and bibliographic aliases used
 * by the canonical matcher. This avoids repeatedly scanning large reference
 * lists when rendering relationship views.
 */
export function createRelatedWorkLookupIndex<T extends RelatedWorkMetadata>(
  works: readonly T[],
): RelatedWorkLookupIndex<T> {
  const byAlias = new Map<string, T[]>();
  for (const work of works) {
    for (const alias of workLookupAliases(work)) {
      const candidates = byAlias.get(alias) ?? [];
      candidates.push(work);
      byAlias.set(alias, candidates);
    }
  }
  return { byAlias };
}

export function findMatchingRelatedWork<T extends RelatedWorkMetadata>(
  index: RelatedWorkLookupIndex<T>,
  work: RelatedWorkMetadata,
): T | null {
  const candidates = new Set<T>();
  for (const alias of workLookupAliases(work)) {
    for (const candidate of index.byAlias.get(alias) ?? []) {
      candidates.add(candidate);
    }
  }
  for (const candidate of candidates) {
    if (matchRelatedWorks(candidate, work).decision === "same-work") {
      return candidate;
    }
  }
  return null;
}

export function graphNodeLookupAliases(node: CitationGraphNode): string[] {
  return workLookupAliases({
    provider: node.provider ?? (node.itemID > 0 ? "zotero" : "manual"),
    providerWorkID: node.providerWorkID,
    doi: node.doi,
    title: node.title,
    year: node.year,
    authors: node.authors,
  });
}

export function externalWorkLookupIdentity(work: RelatedWorkMetadata): string {
  const stable = stableExternalWorkIdentity(work);
  if (stable) return stable;
  const bibliographic = bibliographicWorkAliases(work)[0];
  if (bibliographic) return `candidate:${bibliographic}`;
  const title = normalizeExactTitle(work.title) || "untitled";
  const authors = normalizedAuthors(work.authors).slice(0, 2).join("|");
  return (
    `candidate:${work.provider}:${title}:year:${work.year ?? "unknown"}:` +
    `authors:${authors || "unknown"}`
  );
}

export function relationshipCandidateIdentity(
  work: RelatedWorkMetadata,
): string {
  return scopedLocalAlias(work) ?? externalWorkLookupIdentity(work);
}

function evidenceFromWork(work: RelatedWorkMetadata): WorkIdentityEvidence {
  return {
    provider: work.provider,
    includesLocal: work.provider === "zotero",
    providerWorkID: normalizeProviderWorkID(work.provider, work.providerWorkID),
    doi: normalizeDOI(work.doi),
    pmid: normalizeIdentifier(work.pmid),
    arxiv: normalizeIdentifier(work.arxiv),
    isbn: normalizeISBN(work.isbn),
    title: normalizeExactTitle(work.title),
    year: work.year,
    authors: normalizedAuthors(work.authors),
    localAlias: scopedLocalAlias(work),
  };
}

function evidenceFromIdentifiers(
  identifiers: WorkIdentifiers,
): WorkIdentityEvidence {
  return {
    provider: "zotero",
    includesLocal: true,
    providerWorkID: null,
    doi: normalizeDOI(identifiers.doi),
    pmid: normalizeIdentifier(identifiers.pmid),
    arxiv: normalizeIdentifier(identifiers.arxiv),
    isbn: normalizeISBN(identifiers.isbn),
    title: normalizeExactTitle(identifiers.title),
    year: identifiers.year,
    authors: normalizedAuthors(identifiers.authors),
    localAlias: null,
  };
}

function evidenceFromGraphNode(node: CitationGraphNode): WorkIdentityEvidence {
  return {
    provider: node.provider ?? (node.itemID > 0 ? "zotero" : "manual"),
    includesLocal: node.itemID > 0,
    providerWorkID: normalizeProviderWorkID(
      node.provider ?? (node.itemID > 0 ? "zotero" : "manual"),
      node.providerWorkID,
    ),
    doi: normalizeDOI(node.doi),
    pmid: null,
    arxiv: null,
    isbn: null,
    title: normalizeExactTitle(node.title),
    year: node.year,
    authors: normalizedAuthors(node.authors),
    localAlias: null,
  };
}

function compareIdentifierNamespace(
  namespace: string,
  left: string | null,
  right: string | null,
  comparison: IdentifierComparison,
): void {
  if (!left || !right) return;
  if (left === right) {
    comparison.sharedAliases.push(`${namespace}:${left}`);
    return;
  }
  comparison.conflictingNamespaces.push(namespace);
}

function compareIdentifiers(
  left: WorkIdentityEvidence,
  right: WorkIdentityEvidence,
): IdentifierComparison {
  const comparison: IdentifierComparison = {
    sharedAliases: [],
    conflictingNamespaces: [],
  };
  compareIdentifierNamespace("doi", left.doi, right.doi, comparison);
  compareIdentifierNamespace("pmid", left.pmid, right.pmid, comparison);
  compareIdentifierNamespace("arxiv", left.arxiv, right.arxiv, comparison);
  compareIdentifierNamespace("isbn", left.isbn, right.isbn, comparison);
  if (left.provider === right.provider) {
    compareIdentifierNamespace(
      `provider:${left.provider}`,
      left.providerWorkID,
      right.providerWorkID,
      comparison,
    );
  }
  compareIdentifierNamespace(
    "zotero",
    left.localAlias,
    right.localAlias,
    comparison,
  );
  return comparison;
}

function authorsOverlap(
  left: WorkIdentityEvidence,
  right: WorkIdentityEvidence,
): boolean {
  if (!left.authors.length || !right.authors.length) return false;
  const leftAuthors = new Set(left.authors);
  return right.authors.some((author) => leftAuthors.has(author));
}

function severeLocalContradiction(
  left: WorkIdentityEvidence,
  right: WorkIdentityEvidence,
): boolean {
  const includesLocal = left.includesLocal || right.includesLocal;
  if (!includesLocal || !left.title || !right.title) return false;
  return left.title !== right.title && !authorsOverlap(left, right);
}

function titleIsDistinctive(title: string): boolean {
  return title.length >= 20 || title.split(" ").length >= 4;
}

function matchEvidence(
  left: WorkIdentityEvidence,
  right: WorkIdentityEvidence,
): WorkMatchResult {
  const identifiers = compareIdentifiers(left, right);
  if (identifiers.conflictingNamespaces.length > 0) {
    return {
      decision: "different-work",
      reason: `Conflicting stable identifiers: ${identifiers.conflictingNamespaces.join(", ")}.`,
      ...identifiers,
      identityConflict: true,
    };
  }
  if (identifiers.sharedAliases.length > 0) {
    const contradiction = severeLocalContradiction(left, right);
    return {
      decision: contradiction ? "ambiguous" : "same-work",
      reason: contradiction
        ? "A shared stable identifier contradicts the local title and authors."
        : "The records share a stable identifier.",
      ...identifiers,
      identityConflict: contradiction,
    };
  }

  const titleMatches = Boolean(left.title && left.title === right.title);
  const firstAuthorMatches = Boolean(
    left.authors[0] && left.authors[0] === right.authors[0],
  );
  const secondAuthorMatches = Boolean(
    left.authors[1] && left.authors[1] === right.authors[1],
  );
  const bothYearsKnown = left.year !== null && right.year !== null;
  const yearsCompatible =
    bothYearsKnown &&
    Math.abs((left.year as number) - (right.year as number)) <= 1;
  const yearsConflict =
    bothYearsKnown &&
    Math.abs((left.year as number) - (right.year as number)) > 1;
  const strongBibliographicMatch =
    titleMatches &&
    firstAuthorMatches &&
    (yearsCompatible || secondAuthorMatches) &&
    (titleIsDistinctive(left.title) ||
      (secondAuthorMatches && yearsCompatible));

  if (strongBibliographicMatch) {
    return {
      decision: "same-work",
      reason: "The records share a strong exact bibliographic fingerprint.",
      ...identifiers,
      identityConflict: false,
    };
  }
  if (titleMatches && firstAuthorMatches && yearsConflict) {
    return {
      decision: "possible-version",
      reason: "The title and first author match but publication years differ.",
      ...identifiers,
      identityConflict: false,
    };
  }
  return {
    decision: "ambiguous",
    reason:
      "The available bibliographic evidence is insufficient for an automatic merge.",
    ...identifiers,
    identityConflict: false,
  };
}

export function matchRelatedWorks(
  left: RelatedWorkMetadata,
  right: RelatedWorkMetadata,
): WorkMatchResult {
  return matchEvidence(evidenceFromWork(left), evidenceFromWork(right));
}

export function matchWorkIdentifiers(
  identifiers: WorkIdentifiers,
  candidate: RelatedWorkMetadata,
): WorkMatchResult {
  return matchEvidence(
    evidenceFromIdentifiers(identifiers),
    evidenceFromWork(candidate),
  );
}

export function matchRelatedWorkToGraphNode(
  work: RelatedWorkMetadata,
  node: CitationGraphNode,
): WorkMatchResult {
  return matchEvidence(evidenceFromWork(work), evidenceFromGraphNode(node));
}
