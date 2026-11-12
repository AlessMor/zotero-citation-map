import { expect } from "chai";
import { repository } from "../package.json";
import { requestJSON } from "../src/providers/http";
import {
  requireArray,
  requireResponseData,
  validateMetadataCollections,
} from "../src/providers/responseValidation";
import { numberOrNull } from "../src/providers/types";
import {
  getProviderCredential,
  initializeProviderCredentials,
  saveProviderCredential,
} from "../src/services/providerCredentialService";

describe("Provider safety", function () {
  it("keeps release ownership on the upstream repository", function () {
    expect(repository.url).to.equal(
      "git+https://github.com/AlessMor/zotero-citation-map.git",
    );
  });

  it("blocks external requests without permission", async function () {
    const key = "extensions.zotero.citationmap.externalRequestsEnabled";
    const previous = Zotero.Prefs.get(key, true);
    Zotero.Prefs.set(key, false, true);
    try {
      const result = await requestJSON(
        "crossref",
        "https://api.crossref.org/works/10.0000/blocked",
        {},
      );
      expect(result.ok).to.equal(false);
      expect(result.status).to.equal(403);
    } finally {
      if (previous === undefined) Zotero.Prefs.clear(key, true);
      else Zotero.Prefs.set(key, previous, true);
    }
  });

  it("stores and migrates credentials through the real login manager", async function () {
    const previous = getProviderCredential("openAlexAPIKey");
    const legacyKey = "extensions.zotero.citationmap.openAlexAPIKey";
    try {
      await saveProviderCredential("openAlexAPIKey", "");
      Zotero.Prefs.set(legacyKey, "citation-map-migration-smoke", true);
      await initializeProviderCredentials();
      expect(getProviderCredential("openAlexAPIKey")).to.equal(
        "citation-map-migration-smoke",
      );
      expect(Zotero.Prefs.get(legacyKey, true) ?? "").to.equal("");
      await saveProviderCredential(
        "openAlexAPIKey",
        "citation-map-replacement-smoke",
      );
      await initializeProviderCredentials();
      expect(getProviderCredential("openAlexAPIKey")).to.equal(
        "citation-map-replacement-smoke",
      );
      await saveProviderCredential("openAlexAPIKey", "");
      expect(getProviderCredential("openAlexAPIKey")).to.equal("");
    } finally {
      Zotero.Prefs.clear(legacyKey, true);
      await saveProviderCredential("openAlexAPIKey", previous);
    }
  });

  it("distinguishes failures and malformed pages from empty successes", function () {
    expect(() =>
      requireResponseData(
        { ok: false, status: 429, data: null, message: "rate limited" },
        "references",
      ),
    ).to.throw("HTTP 429");
    expect(() => requireArray(undefined, "references")).to.throw(TypeError);
    expect(requireArray([], "references")).to.deep.equal([]);
    expect(() =>
      validateMetadataCollections({ authors: "invalid" }, "paper"),
    ).to.throw(TypeError);
    expect(numberOrNull(null)).to.equal(null);
    expect(numberOrNull(0)).to.equal(0);
  });
});
