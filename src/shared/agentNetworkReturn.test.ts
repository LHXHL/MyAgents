import { describe, expect, it } from "vitest";
import { parseNetworkReturnReference } from "./agentNetworkReturn";

describe("opaque network return reference", () => {
  const reference = {
    opId: "00000000-0000-0000-0000-000000000001",
    returnRouteId: "00000000-0000-0000-0000-000000000002",
  };
  it("requires a closed canonical reference without caller-supplied routing", () => {
    expect(parseNetworkReturnReference(reference)).toEqual(reference);
    expect(parseNetworkReturnReference(reference)).not.toBe(reference);
    for (const input of [
      null,
      [],
      { ...reference, targetDeviceId: reference.opId },
      { ...reference, opId: "local-session" },
      { ...reference, returnRouteId: "" },
    ]) {
      expect(parseNetworkReturnReference(input)).toBeNull();
    }
  });
});
