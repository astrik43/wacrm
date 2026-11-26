// ============================================================
// /api/mcp — remote MCP server (Streamable HTTP, stateless).
//
// Auth is the same bearer API key as /api/v1 (requireApiKey); the
// key's scopes decide which tools exist for the request. Connect:
//
//   claude mcp add --transport http wacrm https://<host>/api/mcp \
//     --header "Authorization: Bearer wacrm_live_…"
//
// Stateless: a fresh server + transport per request, so it works on
// any instance behind a load balancer with no session affinity.
// ============================================================

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { requireApiKey } from '@/lib/auth/api-context';
import { toApiErrorResponse } from '@/lib/api/v1/respond';
import { createMcpServer } from '@/lib/mcp/server';

export const dynamic = 'force-dynamic';
// send_broadcast / resume_broadcast fan out up to 1000 sends after the
// response; without this the platform may cut them off mid-send.
export const maxDuration = 300;

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireApiKey(request);
  } catch (err) {
    return toApiErrorResponse(err);
  }

  const server = createMcpServer({
    supabase: ctx.supabase,
    accountId: ctx.accountId,
    keyId: ctx.keyId,
    scopes: ctx.scopes,
    createdBy: ctx.createdBy,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

// Stateless server: there is no session to resume or close.
function notAllowed() {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. POST JSON-RPC to this endpoint.' },
      id: null,
    }),
    { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } }
  );
}
export const GET = notAllowed;
export const DELETE = notAllowed;
