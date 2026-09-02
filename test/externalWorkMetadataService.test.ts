import { expect } from "chai";
import type { RelatedWorkMetadata } from "../src/domain/citationTypes";
import { externalWorkToFocusNode } from "../src/services/graphFocusService";
import {
  toExternalWork,
  toExternalWorks,
  localExternalWorkIndexes,
  type LibraryWorkIdentity,
} from "../src/services/externalWorkMetadataService";

function externalWork(
  overrides: Partial<RelatedWorkMetadata> = {},
): RelatedWorkMetadata {
  return {
    provider: "openalex",
    providerWorkID: "W123",
    doi: "10.1000/example",
    title: null,
    year: null,
    publicationDate: null,
    authors: [],
    sourceTitle: null,
    abstract: null,
    ...overrides,
  };
}

function localWork(
  overrides: Partial<LibraryWorkIdentity> = {},
): LibraryWorkIdentity {
  return {
    itemKey: "LOCAL1",
    doi: "10.1000/example",
    title: "Local Zotero title",
    authors: ["Local Author"],
    year: 2021,
    publicationDate: "2021-06-01",
    sourceTitle: "Local Journal",
    abstract: "Local abstract",
    libraryID: 1,
    ...overrides,
  };
}

describe("External work local Zotero enrichment", function () {
  it("fills missing bibliographic fields from a DOI-matched Zotero item", function () {
    const [resolved] = toExternalWorks([externalWork()], [localWork()]);

    expect(resolved.inLibraryItemKey).to.equal("LOCAL1");
    expect(resolved.zoteroItemKey).to.equal("LOCAL1");
    expect(resolved.zoteroLibraryID).to.equal(1);
    expect(resolved.title).to.equal("Local Zotero title");
    expect(resolved.authors).to.deep.equal(["Local Author"]);
    expect(resolved.year).to.equal(2021);
    expect(resolved.publicationDate).to.equal("2021-06-01");
    expect(resolved.sourceTitle).to.equal("Local Journal");
    expect(resolved.abstract).to.equal("Local abstract");
    expect(resolved.propertySources?.title).to.deep.equal(["zotero"]);
    expect(resolved.propertySources?.authors).to.deep.equal(["zotero"]);
  });

  it("retains valid provider metadata while filling only missing fields", function () {
    const [resolved] = toExternalWorks(
      [
        externalWork({
          title: "Provider title",
          authors: ["Provider Author"],
          year: 2020,
          sourceTitle: "Provider Journal",
        }),
      ],
      [localWork()],
    );

    expect(resolved.title).to.equal("Provider title");
    expect(resolved.authors).to.deep.equal(["Provider Author"]);
    expect(resolved.year).to.equal(2020);
    expect(resolved.sourceTitle).to.equal("Provider Journal");
    expect(resolved.publicationDate).to.equal("2021-06-01");
    expect(resolved.abstract).to.equal("Local abstract");
  });

  it("uses an explicit Zotero item key before DOI or title lookup", function () {
    const works = [
      localWork({ itemKey: "LOCAL1", doi: "10.1000/one", title: "One" }),
      localWork({ itemKey: "LOCAL2", doi: "10.1000/two", title: "Two" }),
    ];
    const indexes = localExternalWorkIndexes(works);
    const resolved = toExternalWork(
      externalWork({
        doi: null,
        title: null,
        inLibraryItemKey: "LOCAL2",
      }),
      indexes.byDOI,
      indexes.byTitle,
      indexes.byKey,
    );

    expect(resolved.inLibraryItemKey).to.equal("LOCAL2");
    expect(resolved.title).to.equal("Two");
  });

  it("does not title-match records whose known DOIs conflict", function () {
    const [resolved] = toExternalWorks(
      [
        externalWork({
          doi: "10.1000/external",
          title: "Same normalized title",
        }),
      ],
      [
        localWork({
          itemKey: "LOCAL-CONFLICT",
          doi: "10.1000/local",
          title: "Same normalized title",
        }),
      ],
    );

    expect(resolved.inLibraryItemKey).to.equal(null);
    expect(resolved.title).to.equal("Same normalized title");
  });

  it("gives Focus View the locally recovered title and authors", function () {
    const [resolved] = toExternalWorks([externalWork()], [localWork()]);
    const node = externalWorkToFocusNode(resolved, "reference");

    expect(node.title).to.equal("Local Zotero title");
    expect(node.authors).to.deep.equal(["Local Author"]);
  });
});
