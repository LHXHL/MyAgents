import type { ModelEntity } from './config-types';
import type { ModelProtocol } from './tokendance';

export const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go';
export const OPENCODE_GO_MODEL_LIST_URL = `${OPENCODE_GO_BASE_URL}/v1/models`;

// OpenCode Go Endpoints table, checked 2026-09-29: https://opencode.ai/docs/go/#endpoints
// The /models response has IDs but no endpoint/protocol field. Keep this table
// explicit; neither a model name nor its owning vendor establishes a route.
const rows: Array<[string, string, string, ModelProtocol]> = [
  ['grok-4.7', 'Grok 4.7', 'grok', 'openai:responses'],
  ['grok-4.6', 'Grok 4.6', 'grok', 'openai:responses'],
  ['gpt-6-luna', 'GPT 6 Luna', 'gpt', 'openai:responses'],
  ['gpt-5.6-luna', 'GPT 5.6 Luna', 'gpt', 'openai:responses'],
  ['glm-5.3-flash', 'GLM-5.3-Flash', 'glm', 'openai:chat-completions'],
  ['glm-5.3', 'GLM-5.3', 'glm', 'openai:chat-completions'],
  ['glm-5.2', 'GLM-5.2', 'glm', 'openai:chat-completions'],
  ['kimi-k3', 'Kimi K3', 'kimi', 'openai:chat-completions'],
  ['kimi-k2.7-code', 'Kimi K2.7 Code', 'kimi', 'openai:chat-completions'],
  ['kimi-k2.6', 'Kimi K2.6', 'kimi', 'openai:chat-completions'],
  ['longcat-2.0', 'LongCat-2.0', 'longcat', 'openai:chat-completions'],
  ['longcat-2.5-preview-free', 'LongCat 2.5 Preview Free', 'longcat', 'openai:chat-completions'],
  ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'deepseek', 'openai:chat-completions'],
  ['deepseek-v4-pro', 'DeepSeek V4 Pro', 'deepseek', 'openai:chat-completions'],
  ['deepseek-v4-flash', 'DeepSeek V4 Flash', 'deepseek', 'openai:chat-completions'],
  ['deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision Exp', 'deepseek', 'openai:chat-completions'],
  ['mimo-v2.6-flash', 'MiMo-V2.6-Flash', 'mimo', 'openai:chat-completions'],
  ['mimo-v2.6-pro', 'MiMo-V2.6-Pro', 'mimo', 'openai:chat-completions'],
  ['mimo-v2.5', 'MiMo-V2.5', 'mimo', 'openai:chat-completions'],
  ['mimo-v2.5-pro', 'MiMo-V2.5-Pro', 'mimo', 'openai:chat-completions'],
  ['minimax-m3', 'MiniMax M3', 'minimax', 'anthropic:messages'],
  ['minimax-m2.7', 'MiniMax M2.7', 'minimax', 'anthropic:messages'],
  ['muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor', 'muse', 'openai:responses'],
  ['muse-spark-1.2-contributor', 'Muse Spark 1.2 Contributor', 'muse', 'openai:responses'],
  ['qwen3.8-max', 'Qwen3.8 Max', 'qwen', 'anthropic:messages'],
  ['qwen3.8-flash', 'Qwen3.8 Flash', 'qwen', 'anthropic:messages'],
  ['qwen3.7-plus', 'Qwen3.7 Plus', 'qwen', 'anthropic:messages'],
  ['hy4-preview', 'Hy4 preview', 'hy', 'openai:chat-completions'],
  ['hy3', 'Hy3', 'hy', 'openai:chat-completions'],
  ['space-bunny-free', 'Space Bunny Free', 'space-bunny', 'openai:chat-completions'],
];

export const OPENCODE_GO_MODELS: ModelEntity[] = rows.map(
  ([model, modelName, modelSeries, protocol]) => ({
    model,
    modelName,
    modelSeries,
    supportedProtocols: [protocol],
    source: 'preset',
  }),
);

const officialProtocols = new Map(rows.map(([id, , , protocol]) => [id, protocol]));
export function getOpenCodeGoOfficialProtocol(modelId: string): ModelProtocol | undefined {
  return officialProtocols.get(modelId);
}
