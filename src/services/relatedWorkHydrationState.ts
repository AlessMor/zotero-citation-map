import type { RelatedWorkMetadata } from "../domain/citationTypes";

export type RelatedWorkFieldGroup =
  | "summary"
  | "citation-history"
  | "normalized-impact"
  | "open-access"
  | "publication-details"
  | "source-metrics"
  | "abstract"
  | "relationships";

export interface RelatedWorkHydrationState {
  hydratedFieldGroups?: RelatedWorkFieldGroup[];
  fieldGroupUpdatedAt?: Partial<Record<RelatedWorkFieldGroup, string>>;
}

export type HydratedRelatedWork = RelatedWorkMetadata &
  RelatedWorkHydrationState;

export function hydratedFieldGroups(
  work: RelatedWorkMetadata,
): ReadonlySet<RelatedWorkFieldGroup> {
  const state = work as HydratedRelatedWork;
  return new Set(state.hydratedFieldGroups ?? []);
}

export function hasHydratedFieldGroup(
  work: RelatedWorkMetadata,
  group: RelatedWorkFieldGroup,
): boolean {
  return hydratedFieldGroups(work).has(group);
}

export function stampRelatedWorkFieldGroups<T extends RelatedWorkMetadata>(
  work: T,
  groups: Iterable<RelatedWorkFieldGroup>,
  updatedAt = new Date().toISOString(),
): T {
  const current = work as HydratedRelatedWork;
  const hydrated = new Set(current.hydratedFieldGroups ?? []);
  const timestamps = { ...(current.fieldGroupUpdatedAt ?? {}) };
  for (const group of groups) {
    hydrated.add(group);
    timestamps[group] = updatedAt;
  }
  return {
    ...work,
    hydratedFieldGroups: [...hydrated],
    fieldGroupUpdatedAt: timestamps,
    updatedAt,
  } as T;
}

export function mergeRelatedWorkHydrationState<T extends RelatedWorkMetadata>(
  left: T,
  right: RelatedWorkMetadata | null,
): T {
  if (!right) return left;
  const leftState = left as HydratedRelatedWork;
  const rightState = right as HydratedRelatedWork;
  const hydrated = new Set([
    ...(leftState.hydratedFieldGroups ?? []),
    ...(rightState.hydratedFieldGroups ?? []),
  ]);
  return {
    ...left,
    hydratedFieldGroups: [...hydrated],
    fieldGroupUpdatedAt: {
      ...(leftState.fieldGroupUpdatedAt ?? {}),
      ...(rightState.fieldGroupUpdatedAt ?? {}),
    },
  } as T;
}

export function projectRelatedWorkSummary<T extends RelatedWorkMetadata>(
  work: T,
  markHydrated = true,
): T {
  const projected: RelatedWorkMetadata = {
    provider: work.provider,
    providerWorkID: work.providerWorkID,
    doi: work.doi,
    pmid: work.pmid ?? null,
    arxiv: work.arxiv ?? null,
    isbn: work.isbn ?? null,
    title: work.title,
    year: work.year,
    publicationDate: work.publicationDate ?? null,
    authors: [...work.authors],
    authorIDs: [...(work.authorIDs ?? [])],
    sourceTitle: work.sourceTitle ?? null,
    citationCount: work.citationCount ?? null,
    referenceCount: work.referenceCount ?? null,
    zoteroItemKey: work.zoteroItemKey ?? null,
    inLibraryItemKey: work.inLibraryItemKey ?? null,
    dataSources: [...(work.dataSources ?? [])],
    updatedAt: work.updatedAt ?? null,
  };
  if (!markHydrated) {
    return mergeRelatedWorkHydrationState(projected as T, work);
  }
  return stampRelatedWorkFieldGroups(projected, ["summary"]) as T;
}

export function relatedWorkNeedsSummary(work: RelatedWorkMetadata): boolean {
  if (hasHydratedFieldGroup(work, "summary")) return false;
  return (
    !String(work.title ?? "").trim() ||
    work.year === null ||
    work.authors.length === 0 ||
    !String(work.sourceTitle ?? "").trim() ||
    work.citationCount == null ||
    work.referenceCount == null
  );
}
