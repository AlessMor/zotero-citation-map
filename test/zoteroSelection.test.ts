import { expect } from "chai";
import {
  collectionIDFromCandidate,
  firstSelectedLibraryID,
  paneValues,
  readContextValue,
  selectedCollectionIDs,
  selectedLibraryIDsFromPane,
} from "../src/services/zoteroSelectionService";

describe("Zotero 10 selection compatibility", function () {
  it("reads MenuManager context fields that throw in Zotero 10", function () {
    const context = {
      collectionTreeRows: [{ id: 4 }],
      get collectionTreeRow(): never {
        throw new Error("Use collectionTreeRows");
      },
    };
    expect(readContextValue(context, "collectionTreeRows")).to.deep.equal([
      { id: 4 },
    ]);
    expect(readContextValue(context, "collectionTreeRow")).to.equal(null);
  });

  it("never calls Zotero 9 singular pane getters when the plural API exists", function () {
    let singularCalls = 0;
    const pane = {
      getSelectedLibraryIDs: () => [3, 8],
      getSelectedLibraryID: () => {
        singularCalls += 1;
        throw new Error("Use getSelectedLibraryIDs");
      },
    };
    expect(selectedLibraryIDsFromPane(pane)).to.deep.equal([3, 8]);
    expect(singularCalls).to.equal(0);
  });

  it("does not fall back to a throwing singular getter when the plural list is empty", function () {
    let singularCalls = 0;
    const pane = {
      getSelectedLibraryIDs: () => [],
      getSelectedLibraryID: () => {
        singularCalls += 1;
        throw new Error("Use getSelectedLibraryIDs");
      },
      getSelectedItems: () => [{ libraryID: 2 }],
    };
    expect(selectedLibraryIDsFromPane(pane)).to.deep.equal([2]);
    expect(singularCalls).to.equal(0);
  });

  it("uses Zotero 9 singular library and collection getters", function () {
    const pane = {
      getSelectedLibraryID: () => 6,
      getSelectedCollection: () => ({ id: 11, isCollection: () => true }),
    };
    expect(selectedLibraryIDsFromPane(pane)).to.deep.equal([6]);
    expect(firstSelectedLibraryID(pane, 1)).to.equal(6);
    expect(selectedCollectionIDs(pane)).to.deep.equal([11]);
  });

  it("reads collection IDs from Zotero 10 menu context rows", function () {
    const context = {
      collectionTreeRows: [
        { isCollection: () => false, libraryID: 1 },
        { isCollection: () => true, ref: { id: 21 } },
        { isCollection: () => true, id: 22 },
        { isCollection: () => true, id: 21 },
      ],
      get collectionTreeRow(): never {
        throw new Error("Use collectionTreeRows");
      },
    };
    const pane = {
      getSelectedCollections: () => [{ id: 99, isCollection: () => true }],
      getSelectedCollection: () => {
        throw new Error("Use getSelectedCollections");
      },
    };
    expect(selectedCollectionIDs(pane, context)).to.deep.equal([21, 22]);
  });

  it("skips library roots and other non-collection rows", function () {
    expect(
      collectionIDFromCandidate({ isCollection: () => false, id: 1 }),
    ).to.equal(null);
    expect(
      collectionIDFromCandidate({
        isCollection: () => true,
        ref: { collectionID: 15 },
      }),
    ).to.equal(15);
  });

  it("returns the fallback library ID when nothing is selected", function () {
    expect(firstSelectedLibraryID({}, 1)).to.equal(1);
    expect(paneValues({}, "getSelectedLibraryIDs", "getSelectedLibraryID")).to
      .be.empty;
  });
});
