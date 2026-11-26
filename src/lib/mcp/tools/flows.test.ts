import { describe, expect, it } from 'vitest';

import { redactPayload } from '@/lib/flows/redact';

import { McpToolError } from '../errors';
import { runTool } from '../executor';
import { FakeDb, newId } from './fake-db';
import { flowsTools } from './flows';

const A = newId();
const B = newId();
const USER = newId();

function setup() {
  const db = new FakeDb();
  const mine = newId();
  const theirs = newId();
  const runMine = newId();
  const runTheirs = newId();
  db.seed('flows', [
    { id: mine, account_id: A, name: 'Mine', status: 'draft', trigger_type: 'keyword', trigger_config: { keywords: ['hi'], match_type: 'contains' }, entry_node_id: 'start', created_at: '2026-01-01T00:00:00Z' },
    { id: theirs, account_id: B, name: 'Theirs', status: 'draft', trigger_type: 'keyword', trigger_config: {}, entry_node_id: null, created_at: '2026-01-02T00:00:00Z' },
  ]);
  db.seed('flow_nodes', [
    { flow_id: mine, node_key: 'start', node_type: 'start', config: { next_node_key: 'end' }, position_x: 0, position_y: 0 },
    { flow_id: mine, node_key: 'end', node_type: 'end', config: {}, position_x: 0, position_y: 0 },
  ]);
  db.seed('flow_runs', [
    { id: runMine, account_id: A, flow_id: mine, contact_id: newId(), status: 'active', current_node_key: 'start', vars: { phone: '+15551234567', city: 'x' }, started_at: '2026-02-01T00:00:00Z' },
    { id: runTheirs, account_id: B, flow_id: theirs, contact_id: newId(), status: 'active', vars: {}, started_at: '2026-02-02T00:00:00Z' },
  ]);
  db.seed('flow_run_events', [
    { flow_run_id: runMine, event_type: 'reply_received', node_key: 'start', payload: { text: 'my number is 5551234567', reply_id: 'yes', meta_message_id: 'wamid.abc' }, created_at: '2026-02-01T00:00:01Z' },
    { flow_run_id: runTheirs, event_type: 'started', node_key: null, payload: {}, created_at: '2026-02-02T00:00:01Z' },
  ]);
  return { db, mine, theirs, runMine, runTheirs };
}

function run(db: FakeDb, name: string, args: Record<string, unknown>, scopes = ['flows:read', 'flows:write']) {
  const tool = flowsTools.find((t) => t.name === name)!;
  return runTool(
    tool,
    { supabase: db.client(), accountId: A, keyId: 'k', scopes, createdBy: USER },
    args
  ) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function err(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof McpToolError) return e;
    throw e;
  }
  return null;
}

describe('flows registry', () => {
  it('uses read scopes for reads and write scopes otherwise', () => {
    for (const t of flowsTools) {
      expect(t.scope).toMatch(t.tier === 'read' ? /:read$/ : /:write$/);
    }
  });
});

describe('flow reading', () => {
  it('lists only account flows and the template gallery', async () => {
    const { db, mine } = setup();
    const res = await run(db, 'list_flows', {});
    expect(res.items.map((f: { id: string }) => f.id)).toEqual([mine]);
    const t = await run(db, 'list_flow_templates', {});
    expect(t.items.map((x: { slug: string }) => x.slug)).toContain('welcome_menu');
  });

  it('gets nodes and derived edges', async () => {
    const { db, mine } = setup();
    const res = await run(db, 'get_flow', { flow_id: mine });
    expect(res.nodes).toHaveLength(2);
    expect(res.edges).toEqual([expect.objectContaining({ source: 'start', target: 'end' })]);
  });

  it("returns not_found for another account's flow", async () => {
    const { db, theirs, runTheirs } = setup();
    for (const [name, args] of [
      ['get_flow', { flow_id: theirs }],
      ['update_flow_nodes', { flow_id: theirs, nodes: [] }],
      ['activate_flow', { flow_id: theirs }],
      ['deactivate_flow', { flow_id: theirs }],
      ['delete_flow', { flow_id: theirs, confirm: true }],
      ['list_flow_runs', { flow_id: theirs }],
      ['get_flow_run_events', { run_id: runTheirs }],
    ] as const) {
      expect((await err(run(db, name, args)))?.code).toBe('not_found');
    }
    expect(db.rows('flows')).toHaveLength(2);
  });
});

describe('flow runs', () => {
  it('lists runs without vars values or phone numbers', async () => {
    const { db, runMine } = setup();
    const res = await run(db, 'list_flow_runs', {});
    expect(res.items).toHaveLength(1);
    expect(res.items[0].id).toBe(runMine);
    expect(res.items[0].var_keys.sort()).toEqual(['city', 'phone']);
    expect(JSON.stringify(res)).not.toContain('5551234567');
    expect(res.items[0].vars).toBeUndefined();
  });

  it('redacts event payloads but keeps ids for debugging', async () => {
    const { db, runMine } = setup();
    const res = await run(db, 'get_flow_run_events', { run_id: runMine });
    expect(res.events).toHaveLength(1);
    expect(res.events[0].payload.reply_id).toBe('yes');
    expect(res.events[0].payload.meta_message_id).toBe('wamid.abc');
    expect(JSON.stringify(res)).not.toContain('5551234567');
  });

  it('redactPayload masks phone-like strings nested anywhere', () => {
    expect(redactPayload({ a: { b: ['call +91 98765 43210'] }, n: 3 })).toEqual({
      a: { b: ['[redacted]'] },
      n: 3,
    });
  });
});

describe('flow writes', () => {
  it('creates a draft from a template; unknown slug is not_found; dry run saves nothing', async () => {
    const { db } = setup();
    expect((await err(run(db, 'create_flow_from_template', { template_slug: 'nope' })))?.code).toBe('not_found');
    await run(db, 'create_flow_from_template', { template_slug: 'welcome_menu', dry_run: true });
    expect(db.rows('flows')).toHaveLength(2);
    const res = await run(db, 'create_flow_from_template', { template_slug: 'welcome_menu', name: 'Support' });
    expect(res.flow).toMatchObject({ name: 'Support', status: 'draft' });
    const created = db.rows('flows').find((f) => f.name === 'Support')!;
    expect(created.account_id).toBe(A);
    expect(db.rows('flow_nodes').filter((n) => n.flow_id === created.id).length).toBeGreaterThan(2);
  });

  it('replaces nodes on a draft (issues are warnings) and dry run validates only', async () => {
    const { db, mine } = setup();
    const nodes = [{ node_key: 'start', node_type: 'start', config: { next_node_key: 'ghost' } }];
    const dry = await run(db, 'update_flow_nodes', { flow_id: mine, nodes, dry_run: true });
    expect(dry.valid).toBe(false);
    expect(db.rows('flow_nodes')).toHaveLength(2);
    const res = await run(db, 'update_flow_nodes', { flow_id: mine, nodes });
    expect(res.validation_issues.length).toBeGreaterThan(0);
    expect(db.rows('flow_nodes')).toHaveLength(1);
  });

  it('rejects an invalid graph on an ACTIVE flow and duplicate keys', async () => {
    const { db, mine } = setup();
    db.rows('flows')[0].status = 'active';
    const nodes = [{ node_key: 'start', node_type: 'start', config: { next_node_key: 'ghost' } }];
    expect((await err(run(db, 'update_flow_nodes', { flow_id: mine, nodes })))?.code).toBe('invalid_input');
    expect(db.rows('flow_nodes')).toHaveLength(2);
    const dup = [
      { node_key: 'a', node_type: 'end', config: {} },
      { node_key: 'a', node_type: 'end', config: {} },
    ];
    expect((await err(run(db, 'update_flow_nodes', { flow_id: mine, nodes: dup })))?.code).toBe('invalid_input');
  });

  it('refuses to activate an invalid flow; activates a valid one; deactivates', async () => {
    const { db, mine } = setup();
    db.rows('flow_nodes')[0].config = { next_node_key: 'ghost' };
    const bad = await err(run(db, 'activate_flow', { flow_id: mine }));
    expect(bad?.code).toBe('invalid_input');
    expect(db.rows('flows')[0].status).toBe('draft');

    await run(db, 'create_flow_from_template', { template_slug: 'welcome_menu', name: 'OK' });
    const ok = db.rows('flows').find((f) => f.name === 'OK')!;
    await run(db, 'activate_flow', { flow_id: ok.id, dry_run: true });
    expect(ok.status).toBe('draft');
    await run(db, 'activate_flow', { flow_id: ok.id });
    expect(ok.status).toBe('active');
    await run(db, 'deactivate_flow', { flow_id: ok.id, archive: true });
    expect(ok.status).toBe('archived');
  });

  it('delete needs confirm and honours dry run', async () => {
    const { db, mine } = setup();
    expect((await err(run(db, 'delete_flow', { flow_id: mine })))?.code).toBe('confirm_required');
    await run(db, 'delete_flow', { flow_id: mine, dry_run: true });
    expect(db.rows('flows')).toHaveLength(2);
    await run(db, 'delete_flow', { flow_id: mine, confirm: true });
    expect(db.rows('flows')).toHaveLength(1);
  });

  it('requires the write scope', async () => {
    const { db, mine } = setup();
    expect((await err(run(db, 'activate_flow', { flow_id: mine }, ['flows:read'])))?.code).toBe('missing_scope');
  });
});
