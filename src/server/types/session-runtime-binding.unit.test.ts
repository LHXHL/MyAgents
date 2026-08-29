import { describe, expect, it } from "vitest";

import {
  createDshBinding,
  createManagedCodexBinding,
} from "../../shared/integrated-runtimes/identity";
import { createSessionMetadata } from "./session";

describe("Session metadata Runtime binding birth", () => {
  it("persists a supplied DSH binding and only writes its legacy projection", () => {
    const runtimeBinding = createDshBinding("darwin-arm64");
    const metadata = createSessionMetadata("/workspace", { runtimeBinding });

    expect(metadata.runtimeBinding).toEqual(runtimeBinding);
    expect(metadata.runtime).toBe("builtin");
    expect(metadata.runtimeSource).toBeUndefined();
    expect(metadata.runtimeBindingCompatibility).toBeUndefined();
  });

  it("projects managed and External bindings for legacy readers", () => {
    const managed = createSessionMetadata("/workspace", {
      runtimeBinding: createManagedCodexBinding(),
    });
    expect(managed).toMatchObject({
      runtime: "codex",
      runtimeSource: "managed-provider",
    });

    const external = createSessionMetadata("/workspace", {
      runtimeBinding: { family: "external", id: "gemini" },
    });
    expect(external).toMatchObject({
      runtime: "gemini",
      runtimeSource: "system-cli",
    });
  });

  it("quarantines an invalid authoritative binding without legacy fallback", () => {
    const metadata = createSessionMetadata("/workspace", {
      runtime: "builtin",
      runtimeBinding: {
        family: "integrated",
        id: "dsh",
        implementationVersion: "incomplete",
      } as never,
    });
    expect(metadata.runtimeBinding).toBeUndefined();
    expect(metadata.runtimeBindingCompatibility).toMatchObject({
      state: "incompatible",
      code: "invalid-runtime-binding",
    });
  });
});
