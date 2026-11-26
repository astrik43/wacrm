import { describe, expect, it } from 'vitest';

import { McpToolError } from '../errors';
import { runTool } from '../executor';
import { FakeDb, newId } from './fake-db';
import { pipelineTools } from './pipeline';

const A = newId();
const B = newId();
const USER = newId();

function setup() {
  const db = new FakeDb();
  const pipeA = newId();
  const pipeB = newId();
  const [s1, s2, s3] = [newId(), newId(), newId()];
  const sB = newId();
  const contactA = newId();
  const contactB = newId();
  db.seed('pipelines', [
    { id: pipeA, account_id: A, name: 'Sales', created_at: '2026-01-01T00:00:00Z' },
    { id: pipeB, account_id: B, name: 'Other', created_at: '2026-01-01T00:00:00Z' },
  ]);
  db.seed('pipeline_stages', [
    { id: s1, pipeline_id: pipeA, name: 'New', position: 0, color: '#111111' },
    { id: s2, pipeline_id: pipeA, name: 'Won', position: 1, color: '#222222' },
    { id: s3, pipeline_id: pipeA, name: 'Extra', position: 2, color: '#333333' },
    { id: sB, pipeline_id: pipeB, name: 'B1', position: 0, color: '#444444' },
  ]);
  db.seed('contacts', [
    { id: contactA, account_id: A },
    { id: contactB, account_id: B },
  ]);
  db.seed('accounts', [{ id: A, default_currency: 'INR' }]);
  return { db, pipeA, pipeB, s1, s2, s3, sB, contactA, contactB };
}

function run(db: FakeDb, name: string, args: Record<string, unknown>, scopes = ['deals:read', 'deals:write']) {
  const tool = pipelineTools.find((t) => t.name === name)!;
  return runTool(
    tool,
    { supabase: db.client(), accountId: A, keyId: 'k', scopes, createdBy: USER },
    args
  ) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof McpToolError) return e.code;
    throw e;
  }
  return 'no_error';
}

describe('pipeline tool registry', () => {
  it('uses read scopes for reads and write scopes otherwise', () => {
    for (const t of pipelineTools) {
      expect(t.scope).toMatch(t.tier === 'read' ? /:read$/ : /:write$/);
    }
  });
});

describe('pipelines & stages', () => {
  it('lists only the account pipelines with ordered stages', async () => {
    const { db, pipeA } = setup();
    const res = await run(db, 'list_pipelines', {});
    expect(res.items).toHaveLength(1);
    expect(res.items[0].id).toBe(pipeA);
    expect(res.items[0].stages.map((s: { name: string }) => s.name)).toEqual(['New', 'Won', 'Extra']);
  });

  it('creates a stage at a position and shifts the rest; dry run changes nothing', async () => {
    const { db, pipeA } = setup();
    const dry = await run(db, 'create_stage', { pipeline_id: pipeA, name: 'Mid', position: 1, dry_run: true });
    expect(dry.dry_run).toBe(true);
    expect(db.rows('pipeline_stages')).toHaveLength(4);
    await run(db, 'create_stage', { pipeline_id: pipeA, name: 'Mid', position: 1 });
    const res = await run(db, 'list_pipelines', {});
    expect(res.items[0].stages.map((s: { name: string }) => s.name)).toEqual(['New', 'Mid', 'Won', 'Extra']);
  });

  it("refuses another account's pipeline and stage", async () => {
    const { db, pipeB, sB } = setup();
    expect(await code(run(db, 'create_stage', { pipeline_id: pipeB, name: 'x' }))).toBe('not_found');
    expect(await code(run(db, 'rename_stage', { stage_id: sB, name: 'x' }))).toBe('not_found');
    expect(await code(run(db, 'list_deals', { pipeline_id: pipeB }))).toBe('not_found');
  });

  it('reorders only with the complete stage list', async () => {
    const { db, pipeA, s1, s2, s3 } = setup();
    expect(await code(run(db, 'reorder_stages', { pipeline_id: pipeA, stage_ids: [s1, s2] }))).toBe('invalid_input');
    await run(db, 'reorder_stages', { pipeline_id: pipeA, stage_ids: [s3, s1, s2] });
    const res = await run(db, 'list_pipelines', {});
    expect(res.items[0].stages.map((s: { id: string }) => s.id)).toEqual([s3, s1, s2]);
  });

  it('delete_stage needs confirm, refuses with deals unless a target is given, then moves them', async () => {
    const { db, s1, s2, s3, sB, pipeA, contactA } = setup();
    expect(await code(run(db, 'delete_stage', { stage_id: s3 }))).toBe('confirm_required');
    const deal = await run(db, 'create_deal', { pipeline_id: pipeA, contact_id: contactA, title: 'D', stage_id: s3 });
    expect(await code(run(db, 'delete_stage', { stage_id: s3, confirm: true }))).toBe('conflict');
    expect(await code(run(db, 'delete_stage', { stage_id: s3, move_deals_to_stage_id: sB, confirm: true }))).toBe('not_found');
    expect(await code(run(db, 'delete_stage', { stage_id: s3, move_deals_to_stage_id: s3, confirm: true }))).toBe('invalid_input');
    const dry = await run(db, 'delete_stage', { stage_id: s3, move_deals_to_stage_id: s1, dry_run: true });
    expect(dry.deals_moved).toBe(1);
    expect(db.rows('pipeline_stages')).toHaveLength(4);
    await run(db, 'delete_stage', { stage_id: s3, move_deals_to_stage_id: s2, confirm: true });
    expect(db.rows('pipeline_stages').find((s) => s.id === s3)).toBeUndefined();
    expect(db.rows('deals').find((d) => d.id === deal.deal.id)?.stage_id).toBe(s2);
  });
});

describe('deals', () => {
  it('creates in the first stage with the account currency', async () => {
    const { db, pipeA, s1, contactA } = setup();
    const res = await run(db, 'create_deal', { pipeline_id: pipeA, contact_id: contactA, title: 'Big', value: 50 });
    expect(res.deal.stage_id).toBe(s1);
    expect(res.deal.currency).toBe('INR');
    expect(db.rows('deals')[0].account_id).toBe(A);
    expect(db.rows('deals')[0].user_id).toBe(USER);
  });

  it('dry run creates nothing and hides tenancy columns', async () => {
    const { db, pipeA, contactA } = setup();
    const res = await run(db, 'create_deal', { pipeline_id: pipeA, contact_id: contactA, title: 'Big', dry_run: true });
    expect(res.dry_run).toBe(true);
    expect(res.would_create.user_id).toBeUndefined();
    expect(db.rows('deals')).toHaveLength(0);
  });

  it("rejects another account's contact, assignee and deal", async () => {
    const { db, pipeA, contactB, contactA, s1 } = setup();
    expect(await code(run(db, 'create_deal', { pipeline_id: pipeA, contact_id: contactB, title: 'x' }))).toBe('not_found');
    expect(await code(run(db, 'create_deal', { pipeline_id: pipeA, contact_id: contactA, title: 'x', assigned_to: newId() }))).toBe('not_found');
    db.seed('deals', [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', account_id: B, pipeline_id: pipeA, stage_id: s1, title: 'theirs', status: 'open' }]);
    const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    expect(await code(run(db, 'get_deal', { deal_id: id }))).toBe('not_found');
    expect(await code(run(db, 'mark_deal_won', { deal_id: id }))).toBe('not_found');
    expect(await code(run(db, 'delete_deal', { deal_id: id, confirm: true }))).toBe('not_found');
    expect(db.rows('deals')).toHaveLength(1);
  });

  it('moves between stages of the same pipeline only', async () => {
    const { db, pipeA, contactA, s2, sB } = setup();
    const { deal } = await run(db, 'create_deal', { pipeline_id: pipeA, contact_id: contactA, title: 'D' });
    expect(await code(run(db, 'move_deal_stage', { deal_id: deal.id, stage_id: sB }))).toBe('not_found');
    const moved = await run(db, 'move_deal_stage', { deal_id: deal.id, stage_id: s2 });
    expect(moved.deal.stage_id).toBe(s2);
  });

  it('marks won / lost (with reason) and reopens', async () => {
    const { db, pipeA, contactA } = setup();
    const { deal } = await run(db, 'create_deal', { pipeline_id: pipeA, contact_id: contactA, title: 'D' });
    expect((await run(db, 'mark_deal_won', { deal_id: deal.id })).deal.status).toBe('won');
    await run(db, 'mark_deal_lost', { deal_id: deal.id, reason: 'too pricey' });
    expect(db.rows('deals')[0].status).toBe('lost');
    expect(String(db.rows('deals')[0].notes)).toContain('too pricey');
    const dry = await run(db, 'reopen_deal', { deal_id: deal.id, dry_run: true });
    expect(dry.would_update.status).toBe('open');
    expect(db.rows('deals')[0].status).toBe('lost');
    await run(db, 'reopen_deal', { deal_id: deal.id });
    expect(db.rows('deals')[0].status).toBe('open');
  });

  it('lists with filters and update requires a field', async () => {
    const { db, pipeA, contactA, s1, s2 } = setup();
    await run(db, 'create_deal', { pipeline_id: pipeA, contact_id: contactA, title: 'a', value: 10, stage_id: s1 });
    const { deal } = await run(db, 'create_deal', { pipeline_id: pipeA, contact_id: contactA, title: 'b', value: 500, stage_id: s2 });
    const byStage = await run(db, 'list_deals', { stage_id: s2 });
    expect(byStage.items.map((d: { id: string }) => d.id)).toEqual([deal.id]);
    const big = await run(db, 'list_deals', { min_value: 100 });
    expect(big.items).toHaveLength(1);
    expect(big.next_cursor).toBeNull();
    expect(await code(run(db, 'update_deal', { deal_id: deal.id }))).toBe('invalid_input');
    const upd = await run(db, 'update_deal', { deal_id: deal.id, title: 'c', currency: 'usd' });
    expect(upd.deal.title).toBe('c');
    expect(upd.deal.currency).toBe('USD');
  });

  it('delete_deal is destructive and honours dry run', async () => {
    const { db, pipeA, contactA } = setup();
    const { deal } = await run(db, 'create_deal', { pipeline_id: pipeA, contact_id: contactA, title: 'D' });
    expect(await code(run(db, 'delete_deal', { deal_id: deal.id }))).toBe('confirm_required');
    await run(db, 'delete_deal', { deal_id: deal.id, dry_run: true });
    expect(db.rows('deals')).toHaveLength(1);
    await run(db, 'delete_deal', { deal_id: deal.id, confirm: true });
    expect(db.rows('deals')).toHaveLength(0);
  });

  it('requires the write scope', async () => {
    const { db, pipeA, contactA } = setup();
    expect(
      await code(run(db, 'create_deal', { pipeline_id: pipeA, contact_id: contactA, title: 'x' }, ['deals:read']))
    ).toBe('missing_scope');
  });
});
