/**
 * Tracks which hydrated relationship lists depend on each external-work
 * identity. The index is populated lazily, only for relationship lists opened
 * in the current session, so metadata updates can invalidate the minimum
 * amount of cached UI data without adding startup work.
 */
export class RelationshipMetadataDependencyIndex {
  private readonly identitiesByRelationship = new Map<string, Set<string>>();
  private readonly relationshipsByIdentity = new Map<string, Set<string>>();

  register(relationshipKey: string, identityKeys: Iterable<string>): void {
    this.unregister(relationshipKey);
    const identities = new Set<string>();
    for (const rawIdentity of identityKeys) {
      const identity = rawIdentity.trim();
      if (!identity) continue;
      identities.add(identity);
      const relationshipKeys =
        this.relationshipsByIdentity.get(identity) ?? new Set<string>();
      relationshipKeys.add(relationshipKey);
      this.relationshipsByIdentity.set(identity, relationshipKeys);
    }
    if (identities.size) {
      this.identitiesByRelationship.set(relationshipKey, identities);
    }
  }

  unregister(relationshipKey: string): void {
    const identities = this.identitiesByRelationship.get(relationshipKey);
    if (!identities) return;
    for (const identity of identities) {
      const relationshipKeys = this.relationshipsByIdentity.get(identity);
      if (!relationshipKeys) continue;
      relationshipKeys.delete(relationshipKey);
      if (relationshipKeys.size === 0) {
        this.relationshipsByIdentity.delete(identity);
      }
    }
    this.identitiesByRelationship.delete(relationshipKey);
  }

  affectedRelationships(identityKeys: Iterable<string>): Set<string> {
    const affected = new Set<string>();
    for (const rawIdentity of identityKeys) {
      const identity = rawIdentity.trim();
      if (!identity) continue;
      for (const relationshipKey of this.relationshipsByIdentity.get(
        identity,
      ) ?? []) {
        affected.add(relationshipKey);
      }
    }
    return affected;
  }

  clear(): void {
    this.identitiesByRelationship.clear();
    this.relationshipsByIdentity.clear();
  }
}
