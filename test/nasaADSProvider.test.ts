import { expect } from "chai";
import type { WorkIdentifiers } from "../src/domain/citationTypes";
import {
  collectNASAADSRecords,
  matchingNASAADSRecords,
  nasaADSWork,
  nasaADSProvider,
  type NASAADSRecord,
} from "../src/providers/nasaADSProvider";

const identifiers: WorkIdentifiers = {
  doi: "10.1000/wanted",
  pmid: null,
  arxiv: "2401.12345v2",
  isbn: null,
  title: "A distinctive astronomy paper for matching",
  normalizedTitle: "a distinctive astronomy paper for matching",
  year: 2024,
  authors: ["Smith, Alice"],
  sourceTitle: null,
};

const record: NASAADSRecord = {
  bibcode: "2024ApJ...900....1S",
  title: ["A distinctive astronomy paper for matching"],
  doi: ["10.1000/wanted"],
  identifier: ["arXiv:2401.12345"],
  author: ["Smith, Alice"],
  year: "2024",
  citation_count: 0,
  reference: [],
};

describe("NASA ADS provider safety", function () {
  it("requires verified DOI and arXiv matches", function () {
    expect(matchingNASAADSRecords([record], identifiers, "doi")).to.have.length(
      1,
    );
    expect(
      matchingNASAADSRecords(
        [{ ...record, doi: ["10.1000/other"] }],
        identifiers,
        "doi",
      ),
    ).to.deep.equal([]);
    expect(
      matchingNASAADSRecords([record], identifiers, "arxiv"),
    ).to.have.length(1);
    expect(
      matchingNASAADSRecords(
        [{ ...record, identifier: ["arXiv:2402.99999"] }],
        identifiers,
        "arxiv",
      ),
    ).to.deep.equal([]);
    expect(
      matchingNASAADSRecords(
        [record, { ...record, bibcode: "2024ApJ...900....2S" }],
        identifiers,
        "doi",
      ),
    ).to.have.length(2);
  });

  it("rejects contradictory exact-title matches", function () {
    const titleIdentifiers = { ...identifiers, doi: null, arxiv: null };
    expect(
      matchingNASAADSRecords([record], titleIdentifiers, "title"),
    ).to.have.length(1);
    expect(
      matchingNASAADSRecords(
        [{ ...record, year: "1990" }],
        titleIdentifiers,
        "title",
      ),
    ).to.deep.equal([]);
    expect(
      matchingNASAADSRecords(
        [{ ...record, author: ["Jones, Bob"] }],
        titleIdentifiers,
        "title",
      ),
    ).to.deep.equal([]);
  });

  it("validates response envelopes and metadata before caching", function () {
    expect(
      collectNASAADSRecords({ response: { numFound: 1, docs: [record] } }),
    ).to.deep.equal([record]);
    expect(() => collectNASAADSRecords({})).to.throw(TypeError);
    expect(() =>
      collectNASAADSRecords({
        response: { numFound: 1, docs: [{ ...record, author: "invalid" }] },
      }),
    ).to.throw(TypeError);
    expect(nasaADSWork(record)?.citationCount).to.equal(0);
    expect(nasaADSWork(record)?.referenceCount).to.equal(0);
  });

  it("does not represent missing credentials as an empty bibliography", async function () {
    let failure: unknown;
    try {
      await nasaADSProvider.fetchReferencedWorks!(
        record.bibcode!,
        200,
        0,
        undefined,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
  });
});
