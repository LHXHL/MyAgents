import { describe, expect, it } from "vitest";

import compatibilityJson from "../../../contracts/myagents-dsh/myagents-dsh-compatibility-v1.json";
import {
  DSH_COMPATIBILITY,
  getDshApiFamilyCompatibility,
  parseDshCompatibilityManifest,
} from "./dsh-compatibility";

describe("DSH compatibility manifest", () => {
  it("binds the exact lock and all three official pi-ai families", () => {
    expect(DSH_COMPATIBILITY.apiFamilies.map((family) => family.id)).toEqual([
      "anthropic-messages",
      "openai-completions",
      "openai-responses",
    ]);
    expect(getDshApiFamilyCompatibility("openai-responses")).toMatchObject({
      compatibilityProfileVersion: 1,
      credentialMode: "request-scoped-api-key",
      routeAdmission: "host-declared-api-family",
      modelCapabilities: "host-profile",
      webBackend: "route-dependent",
    });
  });

  it("rejects artifact identity drift", () => {
    const changed = structuredClone(compatibilityJson);
    changed.runtime.profileDigest = "0".repeat(64);
    expect(() => parseDshCompatibilityManifest(changed)).toThrow(
      /profile digest/,
    );
  });

  it("rejects missing family evidence and required limitations", () => {
    const missingEvidence = structuredClone(compatibilityJson);
    missingEvidence.apiFamilies[0].deterministicEvidence = ["stream"];
    expect(() => parseDshCompatibilityManifest(missingEvidence)).toThrow(
      /Incomplete deterministic evidence/,
    );

    const missingLimitation = structuredClone(compatibilityJson);
    missingLimitation.limitations = missingLimitation.limitations.filter(
      (entry) => entry.id !== "native-cloud-and-oauth-auth-unadvertised",
    );
    expect(() => parseDshCompatibilityManifest(missingLimitation)).toThrow(
      /native-cloud-and-oauth-auth-unadvertised is missing/,
    );
  });
});
