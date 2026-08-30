import { describe, expect, it } from "vitest";

import cellsJson from "./dsh-provider-cells-v1.json";
import {
  DSH_PROVIDER_CELL_CONTRACT,
  findDshProviderCell,
  isDshProviderModelCompatible,
  parseDshProviderCellContract,
} from "./dsh-provider-cells";

describe("DSH Provider/model cell contract", () => {
  it("binds the native candidate and exact pi-ai mappings", () => {
    expect(
      findDshProviderCell("deepseek", "deepseek-v4-flash")?.profile,
    ).toMatchObject({
      source: "native-candidate",
      providerRouteId: "deepseek-official",
      maxTokens: 32_768,
    });
    expect(
      findDshProviderCell("anthropic-api", "claude-sonnet-4-6")?.profile,
    ).toMatchObject({
      source: "pi-ai-cell",
      api: "anthropic-messages",
    });
    expect(findDshProviderCell("zhipu", "glm-5.3")?.profile).toMatchObject({
      source: "pi-ai-cell",
      providerRouteId: "myagents-zhipu-anthropic-messages",
      api: "anthropic-messages",
    });
    expect(findDshProviderCell("zhipu-ai", "glm-5.3")?.profile).toMatchObject({
      source: "pi-ai-cell",
      api: "openai-completions",
    });
  });

  it("does not advertise catalog-only, OAuth, subscription, or unproved cells", () => {
    expect(
      isDshProviderModelCompatible("anthropic-sub", "claude-sonnet-4-6"),
    ).toBe(false);
    expect(isDshProviderModelCompatible("codex-sub", "gpt-5.4-codex")).toBe(
      false,
    );
    expect(isDshProviderModelCompatible("xai-sub", "grok-4.5")).toBe(false);
    expect(isDshProviderModelCompatible("catalog-openai", "gpt-5")).toBe(false);
    expect(isDshProviderModelCompatible("deepseek", "deepseek-v4-pro")).toBe(
      false,
    );
    expect(
      DSH_PROVIDER_CELL_CONTRACT.cells.some(
        (cell) => cell.profile.api === "openai-responses",
      ),
    ).toBe(false);
  });

  it("rejects identity drift and duplicate routes", () => {
    const drifted = structuredClone(cellsJson);
    drifted.runtimeProfileDigest = "0".repeat(64);
    expect(() => parseDshProviderCellContract(drifted)).toThrow(
      /committed handoff/,
    );

    const duplicate = structuredClone(cellsJson);
    duplicate.cells.push(structuredClone(duplicate.cells[0]));
    expect(() => parseDshProviderCellContract(duplicate)).toThrow(
      /must be unique/,
    );
  });

  it("rejects family-invalid wire compatibility and modality drift", () => {
    const invalidWire = structuredClone(cellsJson) as unknown as {
      cells: Array<{
        profile: {
          compatibility?: { wireCompat?: Record<string, unknown> };
          inputModalities?: string[];
        };
      }>;
    };
    const anthropic = invalidWire.cells[1]?.profile;
    if (!anthropic?.compatibility) {
      throw new Error("Missing Anthropic cell fixture");
    }
    anthropic.compatibility.wireCompat = { thinkingFormat: "deepseek" };
    expect(() => parseDshProviderCellContract(invalidWire)).toThrow(
      /thinkingFormat is invalid for anthropic-messages/,
    );

    const modalityDrift = structuredClone(cellsJson);
    const zhipuChat = modalityDrift.cells.find(
      (cell) => cell.cellId === "zhipu-ai:glm-5-3:chat-v1",
    );
    if (!zhipuChat) throw new Error("Missing Zhipu Chat cell fixture");
    zhipuChat.profile.inputModalities = ["text", "image"];
    expect(() => parseDshProviderCellContract(modalityDrift)).toThrow(
      /unsupported input modalities/,
    );
  });
});
