import { expect } from "chai";
import type { RelationshipViewSnapshot } from "../src/services/relationshipViewService";
import { relationshipStatusText } from "../src/services/relationshipViewService";

describe("v0.5.4 relationship performance and status", function () {
  it("distinguishes the cross-provider unique union from one provider's reported total", function () {
    const works = Array.from({ length: 708 }, () => ({}) as any);
    const snapshot: RelationshipViewSnapshot = {
      direction: "cited-by",
      works,
      reportedCount: 707,
      reportedCountProvider: "semantic-scholar",
      hasRetrievedWorks: true,
      relationshipLabel: "citation",
      providerLabel: "citations",
    };

    expect(relationshipStatusText(snapshot)).to.equal(
      "708 unique citations retrieved across providers · Semantic Scholar reports 707",
    );
  });

  it("keeps filtered unique-union wording explicit", function () {
    const works = Array.from({ length: 708 }, () => ({}) as any);
    const snapshot: RelationshipViewSnapshot = {
      direction: "cited-by",
      works,
      reportedCount: 707,
      reportedCountProvider: "semantic-scholar",
      hasRetrievedWorks: true,
      relationshipLabel: "citation",
      providerLabel: "citations",
    };

    expect(relationshipStatusText(snapshot, 12, true)).to.equal(
      "12 shown of 708 unique citations retrieved across providers · Semantic Scholar reports 707",
    );
  });
});
