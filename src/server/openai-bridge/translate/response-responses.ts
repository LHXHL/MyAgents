// Non-streaming response translation: OpenAI Responses API → Anthropic

import type { AnthropicResponse, AnthropicResponseContentBlock, AnthropicStopReason } from '../types/anthropic';
import type { ResponsesResponse, ResponsesOutputItem } from '../types/openai-responses';
import { generateMessageId } from '../utils/id';
import { fromResponsesUsage, toAnthropicUsage, type UsageWarningLogger } from './usage';
import { safeParseJson } from './tools';

/** One terminal policy shared by streaming and non-streaming Responses. */
export function resolveResponsesStopReason(
  resp: Pick<ResponsesResponse, 'status' | 'error' | 'incomplete_details'>,
  hasToolUse: boolean,
): AnthropicStopReason {
  if (resp.status === 'failed') {
    throw new ResponsesApiError(resp.error?.code ?? 'api_error', resp.error?.message ?? 'Unknown upstream error');
  }
  if (resp.status === 'incomplete') {
    const reason = resp.incomplete_details?.reason ?? 'unknown';
    if (reason === 'max_output_tokens' && !hasToolUse) return 'max_tokens';
    // An incomplete tool call cannot be executed safely, even if its JSON parses.
    throw new ResponsesApiError('api_error', `Upstream response incomplete: ${reason}${hasToolUse ? ' (tool call unfinished)' : ''}`);
  }
  if (resp.status !== 'completed') {
    throw new ResponsesApiError('api_error', `Upstream response has no terminal status: ${resp.status}`);
  }
  return hasToolUse ? 'tool_use' : 'end_turn';
}

/** Translate OpenAI Responses API response → Anthropic response.
 *  Throws on `status: 'failed'` to surface upstream error. */
export function translateResponsesResponse(
  resp: ResponsesResponse,
  requestModel: string,
  usageWarning?: UsageWarningLogger,
): AnthropicResponse {
  const hasToolUse = resp.output?.some(item => item.type === 'function_call') ?? false;
  const stopReason = resolveResponsesStopReason(resp, hasToolUse);

  const content: AnthropicResponseContentBlock[] = [];

  for (const item of resp.output) {
    translateOutputItem(item, content);
  }

  // Ensure at least one content block
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  // Build usage
  const usage = fromResponsesUsage(resp.usage, usageWarning);

  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model: requestModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: toAnthropicUsage(usage),
  };
}

/** Error thrown when Responses API returns status: 'failed' */
export class ResponsesApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ResponsesApiError';
  }
}

function translateOutputItem(item: ResponsesOutputItem, content: AnthropicResponseContentBlock[]): void {
  switch (item.type) {
    case 'message':
      for (const part of item.content) {
        if (part.type === 'output_text' && part.text) {
          content.push({ type: 'text', text: part.text });
        } else if (part.type === 'refusal') {
          content.push({ type: 'text', text: `[Refusal]: ${part.refusal}` });
        }
      }
      break;

    case 'function_call':
      content.push({
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: safeParseJson(item.arguments),
      });
      break;

    case 'reasoning':
      if (item.summary && item.summary.length > 0) {
        const thinkingText = item.summary
          .map(s => s.text)
          .filter(Boolean)
          .join('\n');
        if (thinkingText) {
          content.push({
            type: 'thinking',
            thinking: thinkingText,
            signature: '',
          });
        }
      }
      break;
  }
}
