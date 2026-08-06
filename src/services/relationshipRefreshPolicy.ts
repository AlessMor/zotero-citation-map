import type { CitationProviderID } from "../domain/citationTypes";

export type RelationshipRefreshMode = "automatic" | "manual";
export type RelationshipProviderStrategy = "native-first" | "aggregate";

export interface RelationshipRefreshPolicy {
  mode: RelationshipRefreshMode;
  membershipLimit: number;
  metadataLimit: number;
  metadataBatchSize: number;
  providerStrategy: RelationshipProviderStrategy;
  providerLimit: number;
  maxAgeMs: number;
}

export const RELATIONSHIP_CACHE_MAX_AGE_MS = 30 * 86400000;
export const AUTOMATIC_RELATIONSHIP_MEMBERSHIP_LIMIT = 50;
export const AUTOMATIC_RELATIONSHIP_METADATA_LIMIT = 25;
export const AUTOMATIC_RELATIONSHIP_METADATA_BATCH_SIZE = 10;
export const MANUAL_RELATIONSHIP_METADATA_LIMIT = 50;
export const MANUAL_RELATIONSHIP_METADATA_BATCH_SIZE = 50;
export const LARGE_RELATIONSHIP_SET_THRESHOLD = 300;

export function relationshipRefreshPolicy(
  mode: RelationshipRefreshMode,
  overrides: Partial<RelationshipRefreshPolicy> = {},
): RelationshipRefreshPolicy {
  const base: RelationshipRefreshPolicy =
    mode === "automatic"
      ? {
          mode,
          membershipLimit: AUTOMATIC_RELATIONSHIP_MEMBERSHIP_LIMIT,
          metadataLimit: AUTOMATIC_RELATIONSHIP_METADATA_LIMIT,
          metadataBatchSize: AUTOMATIC_RELATIONSHIP_METADATA_BATCH_SIZE,
          providerStrategy: "aggregate",
          providerLimit: Number.POSITIVE_INFINITY,
          maxAgeMs: RELATIONSHIP_CACHE_MAX_AGE_MS,
        }
      : {
          mode,
          membershipLimit: Number.POSITIVE_INFINITY,
          // Relationship membership is useful immediately. Do not make a
          // manual refresh wait for every optional neighbour field when a
          // paper has hundreds or thousands of relationships.
          metadataLimit: MANUAL_RELATIONSHIP_METADATA_LIMIT,
          metadataBatchSize: MANUAL_RELATIONSHIP_METADATA_BATCH_SIZE,
          providerStrategy: "aggregate",
          providerLimit: Number.POSITIVE_INFINITY,
          maxAgeMs: RELATIONSHIP_CACHE_MAX_AGE_MS,
        };
  return { ...base, ...overrides, mode };
}

/**
 * Relationship size must not silently reduce the provider set selected in
 * Settings. Large lists are made responsive through bounded concurrency,
 * cooperative processing, and one final commit instead.
 */
export function relationshipProviderPolicyForSize(
  mode: RelationshipRefreshMode,
  reportedCount: number | null | undefined,
  overrides: {
    providerStrategy?: RelationshipProviderStrategy;
    providerLimit?: number;
  } = {},
): Pick<RelationshipRefreshPolicy, "providerStrategy" | "providerLimit"> {
  void mode;
  void reportedCount;
  void overrides;
  return {
    providerStrategy: "aggregate",
    providerLimit: Number.POSITIVE_INFINITY,
  };
}

export function relationshipForegroundMetadataLimit(
  mode: RelationshipRefreshMode,
  relationshipCount: number,
  configuredLimit: number,
): number {
  if (
    mode === "manual" &&
    relationshipCount >= LARGE_RELATIONSHIP_SET_THRESHOLD
  ) {
    return 0;
  }
  return Number.isFinite(configuredLimit)
    ? Math.max(0, Math.floor(configuredLimit))
    : Math.max(0, relationshipCount);
}

export interface AutomaticFocusSeedRefreshPlan {
  /** A newly introduced seed always verifies its current membership. */
  forceRefresh: false;
  /** Delay long enough for the seed graph and progress popup to paint first. */
  startDelayMs: number;
  membershipLimit: number;
  /** Optional summaries are deferred to the cooperative background queue. */
  foregroundMetadataLimit: 0;
  showBackgroundProgress: true;
}

export function automaticFocusSeedRefreshPlan(): AutomaticFocusSeedRefreshPlan {
  const policy = relationshipRefreshPolicy("automatic");
  return {
    forceRefresh: false,
    startDelayMs: 80,
    membershipLimit: policy.membershipLimit,
    foregroundMetadataLimit: 0,
    showBackgroundProgress: true,
  };
}

export function relationshipSnapshotIsFresh(
  fetchedAt: string | null | undefined,
  maxAgeMs = RELATIONSHIP_CACHE_MAX_AGE_MS,
  now = Date.now(),
): boolean {
  if (!fetchedAt) return false;
  const timestamp = Date.parse(fetchedAt);
  return Number.isFinite(timestamp) && now - timestamp < maxAgeMs;
}

export function relationshipRefreshRequiresFollowUp(
  active: Pick<RelationshipRefreshPolicy, "mode" | "membershipLimit">,
  requested: Pick<RelationshipRefreshPolicy, "mode" | "membershipLimit">,
  refreshMembership: boolean,
): boolean {
  return (
    refreshMembership &&
    ((requested.mode === "manual" && active.mode !== "manual") ||
      requested.membershipLimit > active.membershipLimit)
  );
}

export function orderRelationshipProviders(
  available: readonly CitationProviderID[],
  preferred: readonly (CitationProviderID | null | undefined)[],
  strategy: RelationshipProviderStrategy,
  maximum: number,
): CitationProviderID[] {
  if (strategy === "aggregate") {
    return Number.isFinite(maximum)
      ? [...available].slice(0, Math.max(0, maximum))
      : [...available];
  }
  const availableSet = new Set(available);
  const ordered: CitationProviderID[] = [];
  for (const provider of preferred) {
    if (
      !provider ||
      !availableSet.has(provider) ||
      ordered.includes(provider)
    ) {
      continue;
    }
    ordered.push(provider);
  }
  for (const provider of available) {
    if (!ordered.includes(provider)) ordered.push(provider);
  }
  return Number.isFinite(maximum)
    ? ordered.slice(0, Math.max(0, maximum))
    : ordered;
}

/**
 * Keep a stable display/progress order without excluding any enabled
 * provider. Aggregate refreshes consume the complete available list.
 */
export function preferredRelationshipProviders(
  direction: "references" | "cited-by",
  available: readonly CitationProviderID[],
  nodeProvider: CitationProviderID | null | undefined,
  countProvider: CitationProviderID | null | undefined,
  hasDOI: boolean,
): Array<CitationProviderID | null | undefined> {
  void direction;
  void hasDOI;
  return [nodeProvider, countProvider, ...available];
}
