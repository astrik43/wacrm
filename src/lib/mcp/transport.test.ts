import { describe, expect, it } from 'vitest';

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createMcpServer } from './server';

// The wire path /api/mcp uses: one stateless server + transport per request.
async function rpc(body: unknown) {
  const server = createMcpServer({
    supabase: {} as SupabaseClient,
    accountId: 'acc-1',
    keyId: 'key-1',
    scopes: [],
    createdBy: null,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const res = await transport.handleRequest(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, json: await res.json() };
}

describe('/api/mcp wire path', () => {
  it('answers initialize over plain JSON', async () => {
    const { status, json } = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    });
    expect(status).toBe(200);
    expect(json.result.serverInfo).toMatchObject({ name: 'wacrm', version: '2.0.0' });
  });

  it('lists whoami for a key with no scopes, and calls it', async () => {
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).toEqual(['whoami']);
  });
});
