import { createServer, type Server } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildClaudeSessionEnv, resolveClaudeCodeCli } from '../agent-session';
import { createBridgeHandler } from '../openai-bridge/handler';
import { opencodeGoConversationId, OPENCODE_GO_USER_AGENT } from '../opencode-go-request';
import { probeAnthropicProviderDirect } from '../provider-probe';

const scratch = vi.hoisted(() => ({ directory: `/tmp/myagents-go-request-${process.pid}-${Date.now()}` }));
vi.mock('../utils/platform', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/platform')>()),
  getHomeDirOrNull: () => scratch.directory,
}));
beforeAll(() => mkdirSync(`${scratch.directory}/.myagents`, { recursive: true }));
afterAll(() => rmSync(scratch.directory, { recursive: true, force: true }));

describe('OpenCode Go outbound identity', () => {
  let server: Server | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  });

  it('keeps an opaque identity stable per Product Session and isolates SDK subprocess env', () => {
    const one = opencodeGoConversationId('product-session-a');
    expect(one).toBe(opencodeGoConversationId('product-session-a'));
    expect(one).not.toBe(opencodeGoConversationId('product-session-b'));
    expect(one).not.toContain('product-session-a');
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'X-Trace: keep\r\nx-opencode-session: stale\r\nuser-agent: Old');
    const go = buildClaudeSessionEnv({
      providerId: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go',
      apiKey: 'fixture', authType: 'api_key', apiProtocol: 'anthropic',
    }, 'minimax-m3', { conversationId: 'product-session-a' });
    expect(go.ANTHROPIC_CUSTOM_HEADERS).toBe(`X-Trace: keep\nUser-Agent: ${OPENCODE_GO_USER_AGENT}\nx-opencode-session: ${one}`);
    expect(go.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('myagents');
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toContain('stale');
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', undefined);
    const other = buildClaudeSessionEnv({ providerId: 'other', baseUrl: 'https://other.example', apiKey: 'fixture', authType: 'api_key' });
    expect(other.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  it('sends the Go identity in an actual SDK Anthropic request', async () => {
    let capture!: (headers: { ua?: string; session?: string }) => void;
    const captured = new Promise<{ ua?: string; session?: string }>(resolve => { capture = resolve; });
    server = createServer((req, res) => {
      capture({ ua: req.headers['user-agent'], session: req.headers['x-opencode-session'] as string | undefined });
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'fixture' } }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no fixture port');
    const controller = new AbortController();
    const sdkQuery = query({
      prompt: 'Say hello',
      options: {
        model: 'minimax-m3', maxTurns: 1, tools: [], mcpServers: {}, strictMcpConfig: true,
        settingSources: [], cwd: scratch.directory, abortController: controller,
        pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
        env: buildClaudeSessionEnv({
          providerId: 'opencode-go', baseUrl: `http://127.0.0.1:${address.port}`,
          apiKey: 'fixture', authType: 'api_key', apiProtocol: 'anthropic',
        }, 'minimax-m3', { conversationId: 'product-session-a' }),
      },
    });
    const drain = (async () => { try { for await (const _ of sdkQuery) { /* request is captured by the server */ } } catch { /* fixture 401 */ } })();
    try {
      const sent = await Promise.race([
        captured,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SDK did not send a request')), 15_000)),
      ]);
      expect(sent.ua).toBe(OPENCODE_GO_USER_AGENT);
      expect(sent.session).toBe(opencodeGoConversationId('product-session-a'));
    } finally {
      controller.abort();
      await drain;
    }
  }, 20_000);

  it('sends the same headers from the direct diagnostic and both bridge formats, without passing them to another provider', async () => {
    const seen: Array<{ path?: string; ua?: string; session?: string }> = [];
    server = createServer((req, res) => {
      req.resume();
      seen.push({ path: req.url, ua: req.headers['user-agent'], session: req.headers['x-opencode-session'] as string | undefined });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture' } }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no fixture port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await probeAnthropicProviderDirect({
      providerEnv: { providerId: 'opencode-go', baseUrl, apiKey: 'fixture', authType: 'api_key' },
      model: 'minimax-m3', conversationId: 'product-session-a', getProxyForProviderUrl: () => undefined,
    });
    for (const upstreamFormat of ['responses', 'chat_completions'] as const) {
      const handler = createBridgeHandler({
        getUpstreamConfig: () => ({
          providerId: 'opencode-go', baseUrl: `${baseUrl}/v1`, apiKey: 'fixture', upstreamFormat,
          opencodeSessionId: opencodeGoConversationId('product-session-a'),
        }), logger: null,
      });
      const response = await handler(new Request('http://127.0.0.1/bridge/fixture/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }], max_tokens: 32 }),
      }));
      await response.text();
    }
    expect(seen.map(item => item.path)).toEqual(['/v1/messages', '/v1/responses', '/v1/chat/completions']);
    expect(seen.every(item => item.ua === OPENCODE_GO_USER_AGENT)).toBe(true);
    expect(seen.every(item => item.session === opencodeGoConversationId('product-session-a'))).toBe(true);
  });
});
