import { expect } from "chai";
import type { RelatedWorkMetadata } from "../src/domain/citationTypes";
import {
  dataCiteMetadataFromResponse,
  mergeDataCiteMetadata,
  needsDataCiteMetadata,
} from "../src/services/dataCiteMetadataService";

function work(
  overrides: Partial<RelatedWorkMetadata> = {},
): RelatedWorkMetadata {
  return {
    provider: "openalex",
    providerWorkID: "W123",
    doi: "10.5281/zenodo.8017773",
    title: null,
    year: null,
    authors: [],
    ...overrides,
  };
}

describe("DataCite metadata fallback", function () {
  it("parses repository DOI metadata into a compact bibliographic summary", function () {
    const metadata = dataCiteMetadataFromResponse({
      data: {
        id: "10.5281/zenodo.8017773",
        type: "dois",
        attributes: {
          doi: "10.5281/zenodo.8017773",
          titles: [{ title: "Tritium burn fraction analysis code" }],
          creators: [
            {
              name: "Delaporte-Mathurin, Remi",
              nameIdentifiers: [
                {
                  nameIdentifier: "https://orcid.org/0000-0002-1825-0097",
                  nameIdentifierScheme: "ORCID",
                },
              ],
            },
          ],
          publicationYear: 2023,
          dates: [{ date: "2023-06-08", dateType: "Issued" }],
          publisher: "Zenodo",
          container: {},
          types: {
            resourceType: "Software",
            resourceTypeGeneral: "Software",
          },
        },
      },
    });

    expect(metadata).to.deep.equal({
      doi: "10.5281/zenodo.8017773",
      title: "Tritium burn fraction analysis code",
      year: 2023,
      publicationDate: "2023-06-08",
      authors: ["Delaporte-Mathurin, Remi"],
      authorIDs: ["https://orcid.org/0000-0002-1825-0097"],
      sourceTitle: "Zenodo",
      publicationType: "Software",
    });
  });

  it("fills only missing bibliographic fields", function () {
    const metadata = dataCiteMetadataFromResponse({
      data: {
        id: "10.5281/zenodo.8017773",
        attributes: {
          doi: "10.5281/zenodo.8017773",
          titles: [{ title: "DataCite title" }],
          creators: [{ name: "DataCite Author" }],
          publicationYear: 2023,
          publisher: "Zenodo",
          types: { resourceTypeGeneral: "Software" },
        },
      },
    });
    expect(metadata).not.to.equal(null);

    const merged = mergeDataCiteMetadata(
      work({
        title: "Provider title",
        authors: [],
        year: null,
        sourceTitle: null,
      }),
      metadata!,
    );

    expect(merged.title).to.equal("Provider title");
    expect(merged.authors).to.deep.equal(["DataCite Author"]);
    expect(merged.year).to.equal(2023);
    expect(merged.sourceTitle).to.equal("Zenodo");
    expect(merged.publicationType).to.equal("Software");
  });

  it("does not merge metadata for a different DOI", function () {
    const metadata = {
      doi: "10.5281/zenodo.9999999",
      title: "Wrong work",
      year: 2023,
      publicationDate: null,
      authors: ["Wrong Author"],
      authorIDs: [],
      sourceTitle: "Zenodo",
      publicationType: "Software",
    };
    const original = work();
    expect(mergeDataCiteMetadata(original, metadata)).to.equal(original);
  });

  it("requests DataCite only for DOI records missing core identity metadata", function () {
    expect(needsDataCiteMetadata(work())).to.equal(true);
    expect(
      needsDataCiteMetadata(
        work({ title: "Complete", authors: ["Author"], year: 2023 }),
      ),
    ).to.equal(false);
    expect(needsDataCiteMetadata(work({ doi: null }))).to.equal(false);
  });
});
