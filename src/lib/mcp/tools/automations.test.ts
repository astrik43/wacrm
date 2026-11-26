import { describe, expect, it } from 'vitest';

import { McpToolError } from '../errors';
import { runTool } from '../executor';
import { automationsTools } from './automations';
import { FakeDb, newId } from './fake-db';

const A = newId();
const B = newId();
const USER = newId();

function setup() {
  const db = new FakeDb();
  const tagA = newId();
  const tagB = newId();
  const mine = newId();
  const theirs = newId();
  db.seed('tags', [
    { id: tagA, account_id: A },
    { id: tagB, account_id: B },
  ]);
  db.seed('automations', [
    { id: mine, account_id: A, name: 'Mine', trigger_type: 'new_contact_created', trigger_config: {}, is_active: false, created_at: '2026-01-01T00:00:00Z' },
    { id: theirs, account_id: B, name: 'Theirs', trigger_type: 'new_contact_created', trigger_config: {}, is_active: false, created_at: '2026-01-02T00:00:00Z' },
  ]);
  db.seed('automation_steps', [
    { id: newId(), automation_id: mine, parent_step_id: null, branch: null, step_type: 'send_message', step_config: { text: 'hi' }, position: 0 },
  ]);
  return { db, tagA, tagB, mine, theirs };
}

function run(db: FakeDb, name: string, args: Record<string, unknown>, scopes = ['automations:read', 'automations:write']) {
  const tool = automationsTools.find((t) => t.name === name)!;
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

describe('automations registry', () => {
  it('uses read scopes for reads and write scopes otherwise', () => {
    for (const t of automationsTools) {
      expect(t.scope).toMatch(t.tier === 'read' ? /:read$/ : /:write$/);
    }
  });
});

describe('reading', () => {
  it('lists only the account automations with a step summary', async () => {
    const { db, mine } = setup();
    const res = await run(db, 'list_automations', {});
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ id: mine, step_count: 1, step_types: ['send_message'] });
  });

  it("returns not_found for another account's automation everywhere", async () => {
    const { db, theirs } = setup();
    for (const [name, args] of [
      ['get_automation', { automation_id: theirs }],
      ['get_automation_logs', { automation_id: theirs }],
      ['set_automation_enabled', { automation_id: theirs, enabled: false }],
      ['duplicate_automation', { automation_id: theirs }],
      ['update_automation', { automation_id: theirs, name: 'x' }],
      ['delete_automation', { automation_id: theirs, confirm: true }],
    ] as const) {
      expect((await err(run(db, name, args)))?.code).toBe('not_found');
    }
    expect(db.rows('automations')).toHaveLength(2);
  });

  it('gets the step tree', async () => {
    const { db, mine } = setup();
    const res = await run(db, 'get_automation', { automation_id: mine });
    expect(res.steps[0].step_type).toBe('send_message');
  });

  it('lists logs filtered by the account', async () => {
    const { db, mine } = setup();
    db.seed('automation_logs', [
      { id: newId(), account_id: A, automation_id: mine, status: 'failed', created_at: '2026-02-01T00:00:00Z' },
      { id: newId(), account_id: B, automation_id: mine, status: 'failed', created_at: '2026-02-02T00:00:00Z' },
    ]);
    const res = await run(db, 'get_automation_logs', { automation_id: mine });
    expect(res.items).toHaveLength(1);
  });
});

describe('pending executions', () => {
  it('cancels a pending run of the account only', async () => {
    const { db, mine } = setup();
    const ok = newId();
    const other = newId();
    db.seed('automation_pending_executions', [
      { id: ok, account_id: A, automation_id: mine, status: 'pending', context: {}, run_at: '2026-03-01T00:00:00Z', created_at: '2026-03-01T00:00:00Z' },
      { id: other, account_id: B, automation_id: mine, status: 'pending', context: {}, run_at: '2026-03-01T00:00:00Z', created_at: '2026-03-01T00:00:00Z' },
    ]);
    const list = await run(db, 'list_pending_automation_executions', {});
    expect(list.items.map((i: { id: string }) => i.id)).toEqual([ok]);
    expect((await err(run(db, 'cancel_pending_execution', { execution_id: other })))?.code).toBe('not_found');
    await run(db, 'cancel_pending_execution', { execution_id: ok, dry_run: true });
    expect(db.rows('automation_pending_executions')[0].status).toBe('pending');
    await run(db, 'cancel_pending_execution', { execution_id: ok });
    expect(db.rows('automation_pending_executions')[0].status).toBe('failed');
    expect((await err(run(db, 'cancel_pending_execution', { execution_id: ok })))?.code).toBe('conflict');
  });
});

describe('create / update validation', () => {
  it('rejects an enabled automation with field-level errors', async () => {
    const { db } = setup();
    const e = await err(
      run(db, 'create_automation', {
        name: 'Bad',
        trigger_type: 'keyword_match',
        trigger_config: { keywords: [] },
        steps: [{ step_type: 'add_tag', step_config: {} }],
        enabled: true,
      })
    );
    expect(e?.code).toBe('invalid_input');
    expect(e?.field).toBe('trigger.keywords');
    expect(e?.message).toContain('steps[0].tag_id');
    expect(db.rows('automations')).toHaveLength(2);
  });

  it('refuses a tag from another account', async () => {
    const { db, tagB } = setup();
    const e = await err(
      run(db, 'create_automation', {
        name: 'X',
        trigger_type: 'new_contact_created',
        steps: [{ step_type: 'add_tag', step_config: { tag_id: tagB } }],
        enabled: true,
      })
    );
    expect(e?.code).toBe('invalid_input');
    expect(e?.field).toBe('steps[0].tag_id');
  });

  it('dry run returns the normalised definition and saves nothing', async () => {
    const { db, tagA } = setup();
    const res = await run(db, 'create_automation', {
      name: 'Welcome',
      trigger_type: 'new_contact_created',
      steps: [
        { step_type: 'add_tag', step_config: { tag_id: tagA } },
        {
          step_type: 'condition',
          step_config: { subject: 'tag_presence', operand: tagA },
          branches: { yes: [{ step_type: 'close_conversation', step_config: {} }] },
        },
      ],
      enabled: true,
      dry_run: true,
    });
    expect(res.dry_run).toBe(true);
    expect(res.valid).toBe(true);
    expect(res.definition.steps[1].branches).toEqual({
      yes: [{ step_type: 'close_conversation', step_config: {} }],
      no: [],
    });
    expect(db.rows('automations')).toHaveLength(2);
  });

  it('saves a valid automation with its nested steps', async () => {
    const { db, tagA } = setup();
    const res = await run(db, 'create_automation', {
      name: 'Welcome',
      trigger_type: 'tag_added',
      trigger_config: { tag_id: tagA },
      steps: [
        { step_type: 'wait', step_config: { amount: 1, unit: 'hours' } },
        {
          step_type: 'condition',
          step_config: { subject: 'message_content', operand: 'x' },
          branches: { no: [{ step_type: 'close_conversation', step_config: {} }] },
        },
      ],
      enabled: true,
    });
    expect(res.automation.is_active).toBe(true);
    const created = db.rows('automations').find((a) => a.name === 'Welcome')!;
    expect(created.account_id).toBe(A);
    const steps = db.rows('automation_steps').filter((s) => s.automation_id === created.id);
    expect(steps).toHaveLength(3);
    const child = steps.find((s) => s.step_type === 'close_conversation')!;
    expect(child.branch).toBe('no');
    expect(child.parent_step_id).toBe(steps.find((s) => s.step_type === 'condition')!.id);
  });

  it('lets a disabled draft be incomplete and reports warnings', async () => {
    const { db } = setup();
    const res = await run(db, 'create_automation', { name: 'Draft', trigger_type: 'new_contact_created' });
    expect(res.automation.is_active).toBe(false);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('rejects unknown step types and branches on non-conditions', async () => {
    const { db } = setup();
    const e = await err(
      run(db, 'create_automation', {
        name: 'X',
        trigger_type: 'new_contact_created',
        steps: [
          { step_type: 'launch_rocket', step_config: {} },
          { step_type: 'close_conversation', step_config: {}, branches: { yes: [{ step_type: 'close_conversation', step_config: {} }] } },
        ],
        enabled: true,
      })
    );
    expect(e?.code).toBe('invalid_input');
    expect(e?.message).toContain('unknown step type');
    expect(e?.message).toContain('only condition steps');
  });

  it('update replaces steps, validates against active state, and honours dry run', async () => {
    const { db, mine } = setup();
    db.rows('automations')[0].is_active = true;
    const bad = await err(
      run(db, 'update_automation', { automation_id: mine, steps: [{ step_type: 'send_message', step_config: { text: '' } }] })
    );
    expect(bad?.code).toBe('invalid_input');
    const dry = await run(db, 'update_automation', {
      automation_id: mine,
      name: 'Renamed',
      steps: [{ step_type: 'send_message', step_config: { text: 'new' } }],
      dry_run: true,
    });
    expect(dry.definition.name).toBe('Renamed');
    expect(db.rows('automations')[0].name).toBe('Mine');
    await run(db, 'update_automation', {
      automation_id: mine,
      name: 'Renamed',
      steps: [{ step_type: 'send_message', step_config: { text: 'new' } }],
    });
    expect(db.rows('automations')[0].name).toBe('Renamed');
    expect(db.rows('automation_steps')).toHaveLength(1);
    expect((db.rows('automation_steps')[0].step_config as { text: string }).text).toBe('new');
  });
});

describe('enable, duplicate, delete', () => {
  it('refuses to enable a broken automation and enables a valid one', async () => {
    const { db, mine } = setup();
    db.rows('automation_steps')[0].step_config = { text: '' };
    expect((await err(run(db, 'set_automation_enabled', { automation_id: mine, enabled: true })))?.code).toBe('invalid_input');
    db.rows('automation_steps')[0].step_config = { text: 'ok' };
    await run(db, 'set_automation_enabled', { automation_id: mine, enabled: true, dry_run: true });
    expect(db.rows('automations')[0].is_active).toBe(false);
    await run(db, 'set_automation_enabled', { automation_id: mine, enabled: true });
    expect(db.rows('automations')[0].is_active).toBe(true);
  });

  it('duplicates as a disabled copy with its steps', async () => {
    const { db, mine } = setup();
    const res = await run(db, 'duplicate_automation', { automation_id: mine });
    expect(res.automation.name).toBe('Mine (Copy)');
    expect(res.automation.is_active).toBe(false);
    expect(db.rows('automation_steps')).toHaveLength(2);
  });

  it('delete needs confirm and honours dry run', async () => {
    const { db, mine } = setup();
    expect((await err(run(db, 'delete_automation', { automation_id: mine })))?.code).toBe('confirm_required');
    await run(db, 'delete_automation', { automation_id: mine, dry_run: true });
    expect(db.rows('automations')).toHaveLength(2);
    await run(db, 'delete_automation', { automation_id: mine, confirm: true });
    expect(db.rows('automations')).toHaveLength(1);
  });

  it('requires the write scope', async () => {
    const { db, mine } = setup();
    expect(
      (await err(run(db, 'set_automation_enabled', { automation_id: mine, enabled: false }, ['automations:read'])))?.code
    ).toBe('missing_scope');
  });
});
