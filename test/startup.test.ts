import { expect } from "chai";

describe("Citation Map startup", function () {
  it("registers the plugin instance", function () {
    expect((Zotero as any).CitationMap).to.exist;
  });
});
