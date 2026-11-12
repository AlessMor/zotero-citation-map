import { expect } from "chai";

describe("Citation Map startup", function () {
  it("registers the plugin instance", function () {
    expect((Zotero as any).CitationMap).to.exist;
    expect((Zotero as any).CitationMap.data.startupError).to.equal(undefined);
    expect((Zotero as any).CitationMap.data.initialized).to.equal(true);
  });
});
