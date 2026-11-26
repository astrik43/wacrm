'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  BATCH_SEND_ATTEMPTS,
  batchRetryDelayMs,
} from '@/lib/broadcast-retry';
import { toStoredTemplateVariables } from '@/lib/broadcast-template-variables';
import { normalizeKey } from '@/lib/contacts/dedupe';
import {
  parseRecipientParams,
  toStoredRecipientParams,
} from '@/lib/whatsapp/recipient-params';
import { Contact, MessageTemplate } from '@/types';

import {
  headerMediaUrlFor,
  fetchCustomValueIndex,
  missingButtonParam,
  resolveButtonParams,
  resolveVariables,
  type AudienceConfig,
  type ButtonVariables,
  type CustomFieldFilter,
  type VariableMapping,
} from '@/lib/broadcasts/shared';

// The pure broadcast logic lives in src/lib/broadcasts/shared so the MCP
// tools use the same copy. Re-exported so existing imports keep working.
export {
  buttonsNeedingParams,
  missingButtonParam,
  resolveButtonParams,
  resolveVariables,
} from '@/lib/broadcasts/shared';
export type {
  AudienceConfig,
  ButtonVariables,
  CustomFieldFilter,
  CustomFieldOperator,
  VariableMapping,
} from '@/lib/broadcasts/shared';

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  buttonVariables?: ButtonVariables;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without
   * it. Passed through as `messageParams.headerMediaUrl`; the builder
   * falls back to the template's stored URL only when this is empty.
   */
  headerMediaUrl?: string;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

/**
 * Meta rate-limit buffer. 10 per batch + 1 s pause matches the spec
 * and keeps us comfortably under Meta's per-phone-number messaging
 * rate so a large broadcast never trips the upstream limiter.
 *
 * Note this shape when touching `RATE_LIMITS.broadcast`: a campaign is
 * many calls to `/api/whatsapp/broadcast`, not one. A 1 000-recipient
 * send is ~100 calls over several minutes, and a bucket sized for
 * "one call per campaign" throttles most of it away (issue #472).
 */
const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;

/** `broadcast_recipients` inserts are independent of the send rate. */
const INSERT_BATCH_SIZE = 200;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BroadcastApiResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

export interface TestSendPayload {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  buttonVariables?: ButtonVariables;
  headerMediaUrl?: string;
  /** International number, country code included. */
  phone: string;
}

export type TestSendResult =
  | { ok: true; contactFound: boolean }
  | { ok: false; error: string };

/**
 * Send the broadcast's message to a single number, right now, so it can
 * be checked on a real phone before it goes to the audience. Nothing is
 * recorded: no broadcast row, no recipient rows. Variables resolve
 * against the contact with that number when there is one (so {{1}} =
 * name shows the real name), otherwise against a stand-in named "Test".
 */
export async function sendTestMessage(
  payload: TestSendPayload,
): Promise<TestSendResult> {
  const buttonVariables = payload.buttonVariables ?? {};
  const missing = missingButtonParam(payload.template, buttonVariables);
  if (missing) return { ok: false, error: `"${missing}" button needs a value` };

  const supabase = createClient();
  const key = normalizeKey(payload.phone);
  if (!key) return { ok: false, error: 'Enter a phone number' };

  const { data: found } = await supabase
    .from('contacts')
    .select('*')
    .eq('phone_normalized', key)
    .limit(1)
    .maybeSingle();
  const contact = (found as Contact | null) ?? ({
    id: '',
    name: 'Test',
    phone: payload.phone,
  } as Contact);
  const customValues = found
    ? (await fetchCustomValueIndex(supabase, [contact.id])).get(contact.id)
    : undefined;

  const body = resolveVariables(payload.variables, contact, customValues);
  const buttonParams = resolveButtonParams(
    payload.template,
    buttonVariables,
    contact,
    customValues,
  );
  const { params, messageParams } = parseRecipientParams(
    toStoredRecipientParams({
      body,
      buttonParams,
      headerMediaUrl: headerMediaUrlFor(payload.template, payload.headerMediaUrl),
    }),
  );

  const res = await fetch('/api/whatsapp/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipients: [
        { phone: payload.phone, params, ...(messageParams ? { messageParams } : {}) },
      ],
      template_name: payload.template.name,
      template_language: payload.template.language ?? 'en_US',
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    results?: BroadcastApiResult[];
  };
  if (!res.ok) return { ok: false, error: data.error || 'Test send failed' };
  const result = data.results?.[0];
  if (result?.status !== 'sent') {
    return { ok: false, error: result?.error || 'Test send failed' };
  }
  return { ok: true, contactFound: Boolean(found) };
}

export async function resolveAudience(
  supabase: ReturnType<typeof createClient>,
  accountId: string | null | undefined,
  audience: AudienceConfig,
): Promise<Contact[]> {

  let contacts: Contact[] = [];

  if (audience.type === 'all') {
    // Staff (contacts.is_staff) are never marketed to, even under "All".
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('is_staff', false);
    if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
    contacts = data ?? [];
  } else if (
    audience.type === 'tags' &&
    audience.tagIds &&
    audience.tagIds.length > 0
  ) {
    const { data: contactTags, error: tagError } = await supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', audience.tagIds);

    if (tagError)
      throw new Error(`Failed to fetch contact tags: ${tagError.message}`);

    if (contactTags && contactTags.length > 0) {
      const uniqueContactIds = [
        ...new Set(contactTags.map((ct) => ct.contact_id)),
      ];
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('is_staff', false)
        .in('id', uniqueContactIds);
      if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
      contacts = data ?? [];
    }
  } else if (audience.type === 'custom_field' && audience.customField) {
    contacts = await resolveCustomFieldAudience(supabase, audience.customField);
  } else if (audience.type === 'csv' && audience.csvContacts) {
    contacts = await upsertCsvContacts(supabase, accountId, audience.csvContacts);
  }

  // Apply exclude tags (works across all contact-derived audience
  // types). CSV contacts are synthetic so exclusion doesn't apply.
  if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
    const { data: excludeRows } = await supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', audience.excludeTagIds);
    const excludedIds = new Set((excludeRows ?? []).map((r) => r.contact_id));
    contacts = contacts.filter((c) => !excludedIds.has(c.id));
  }

  return contacts;
}

/**
 * CSV uploads arrive as raw phone/name pairs, not DB rows. Before we
 * can insert broadcast_recipients (whose contact_id FKs contacts.id),
 * we need real contacts.id UUIDs. So: look up each CSV phone in the
 * caller's contacts table; insert any that don't exist; return the
 * resolved set.
 *
 * Pre-existing implementation synthesized `csv-N` strings as
 * contact_id, which failed the UUID cast on insert — every CSV
 * broadcast silently created zero recipients.
 *
 * Matching is on the normalized number throughout, so it agrees with
 * the account-wide unique index rather than colliding with it.
 */
async function upsertCsvContacts(
  supabase: ReturnType<typeof createClient>,
  accountId: string | null | undefined,
  csvRows: { phone: string; name?: string }[],
): Promise<Contact[]> {
  if (csvRows.length === 0) return [];

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const user = session?.user;
  if (!user) {
    throw new Error('You are not signed in.');
  }
  if (!accountId) {
    throw new Error('Your profile is not linked to an account.');
  }

  // De-duplicate within the CSV on the NORMALIZED number — the same
  // key the DB's UNIQUE (account_id, phone_normalized) index uses
  // (migration 022). Keyed on the raw string instead, "+1 555-0100"
  // and "15550100" survived as two rows and the insert below died on
  // a 23505, failing the whole broadcast.
  const uniqueByKey = new Map<string, { phone: string; name?: string }>();
  for (const row of csvRows) {
    const key = normalizeKey(row.phone);
    if (key && !uniqueByKey.has(key)) uniqueByKey.set(key, row);
  }
  const keys = [...uniqueByKey.keys()];

  // Single round-trip lookup of the contacts already in this ACCOUNT.
  // Scoping to `user_id` missed rows a teammate created on a shared
  // account, so those numbers looked new and their inserts collided
  // with the account-wide unique index.
  const { data: existing, error: lookupErr } = await supabase
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .in('phone_normalized', keys);
  if (lookupErr) {
    throw new Error(`Failed to look up CSV contacts: ${lookupErr.message}`);
  }

  const byKey = new Map<string, Contact>();
  for (const c of (existing ?? []) as Contact[]) {
    const key = normalizeKey(c.phone ?? '');
    if (key) byKey.set(key, c);
  }

  // Insert only missing contacts, in one batch per 200 rows (PostgREST
  // has a default payload cap — 200 keeps individual requests small).
  const missing = keys
    .filter((k) => !byKey.has(k))
    .map((k) => uniqueByKey.get(k)!)
    .map((row) => ({
      user_id: user.id,
      account_id: accountId,
      phone: row.phone,
      name: row.name ?? null,
    }));

  const INSERT_CHUNK = 200;
  for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
    const chunk = missing.slice(i, i + INSERT_CHUNK);
    const { data: inserted, error: insertErr } = await supabase
      .from('contacts')
      .insert(chunk)
      .select();
    if (insertErr) {
      throw new Error(`Failed to create CSV contacts: ${insertErr.message}`);
    }
    for (const c of (inserted ?? []) as Contact[]) {
      const key = normalizeKey(c.phone ?? '');
      if (key) byKey.set(key, c);
    }
  }

  // Preserve input order so analytics roughly matches the CSV order.
  // A number that belongs to a staff contact is dropped.
  return keys
    .map((k) => byKey.get(k))
    .filter(
      (c): c is Contact =>
        Boolean(c) && !(c as Contact & { is_staff?: boolean }).is_staff,
    );
}

async function resolveCustomFieldAudience(
  supabase: ReturnType<typeof createClient>,
  filter: CustomFieldFilter,
): Promise<Contact[]> {
  const { fieldId, operator, value } = filter;

  // Build the WHERE clause for the operator. PostgREST supports
  // eq/neq/ilike via the query builder — use ilike with wildcards
  // for "contains" so the match is case-insensitive.
  let query = supabase
    .from('contact_custom_values')
    .select('contact_id')
    .eq('custom_field_id', fieldId);

  if (operator === 'is') query = query.eq('value', value);
  else if (operator === 'is_not') query = query.neq('value', value);
  else if (operator === 'contains') query = query.ilike('value', `%${value}%`);

  const { data: matches, error: matchErr } = await query;
  if (matchErr)
    throw new Error(`Custom-field filter failed: ${matchErr.message}`);

  const contactIds = [...new Set((matches ?? []).map((m) => m.contact_id))];
  if (contactIds.length === 0) return [];

  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('is_staff', false)
    .in('id', contactIds);
  if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
  return data ?? [];
}


export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    const supabase = createClient();

    try {
      // ── Step 0: Resolve current user ──────────────────────────────
      // broadcasts.user_id is NOT NULL + guarded by RLS
      // (auth.uid() = user_id). Without this, the INSERT below was
      // silently failing with 23502 / 42501 — the wizard would
      // no-op with no feedback.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        throw new Error('You are not signed in.');
      }
      if (!accountId) {
        throw new Error('Your profile is not linked to an account.');
      }

      const buttonVariables = payload.buttonVariables ?? {};
      const missingButton = missingButtonParam(payload.template, buttonVariables);
      if (missingButton) {
        throw new Error(`"${missingButton}" button needs a value.`);
      }
      const headerMediaUrl = headerMediaUrlFor(payload.template, payload.headerMediaUrl);

      // ── Step 1: Resolve audience contacts ─────────────────────────
      setProgress(5);
      const contacts = await resolveAudience(supabase, accountId, payload.audience);

      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      // ── Step 2: Create broadcast row ──────────────────────────────
      setProgress(10);
      const { data: broadcast, error: broadcastError } = await supabase
        .from('broadcasts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: toStoredTemplateVariables({
            variables: payload.variables,
            buttonVariables,
            headerMediaUrl: headerMediaUrl ?? '',
          }),
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
          },
          status: 'sending',
          total_recipients: contacts.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        })
        .select()
        .single();

      if (broadcastError || !broadcast) {
        throw new Error(
          `Failed to create broadcast: ${broadcastError?.message ?? 'unknown error'}`,
        );
      }

      // ── Step 3: Insert recipient rows ─────────────────────────────
      // Custom values are fetched BEFORE the insert so each row can
      // carry its resolved template params. Those params are what makes
      // the campaign resumable server-side (issue #472): the send loop
      // below runs in this browser tab, and if the tab goes away the
      // only record of what {{1}} should be for each contact is this
      // column. Resolving once here also means the resume sends exactly
      // what this pass would have.
      setProgress(20);
      const customValueIndex = await fetchCustomValueIndex(
        supabase,
        contacts.map((c) => c.id),
      );
      // Button values and the header link ride on the same row, so a
      // resume sends them too (see lib/whatsapp/recipient-params).
      const recipientRows = contacts.map((contact) => {
        const customValues = customValueIndex.get(contact.id);
        return {
          broadcast_id: broadcast.id,
          contact_id: contact.id,
          status: 'pending' as const,
          template_params: toStoredRecipientParams({
            body: resolveVariables(payload.variables, contact, customValues),
            buttonParams: resolveButtonParams(
              payload.template,
              buttonVariables,
              contact,
              customValues,
            ),
            headerMediaUrl,
          }),
        };
      });

      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        const batch = recipientRows.slice(i, i + INSERT_BATCH_SIZE);
        const { error: recipientError } = await supabase
          .from('broadcast_recipients')
          .insert(batch);
        if (recipientError) {
          // Previous impl logged and marched on — the broadcast then ran
          // with an incomplete recipient set, so webhook status updates
          // couldn't find some rows and the aggregate counts drifted.
          // Flip the broadcast to failed so the user sees the problem
          // immediately, then throw to abort the send loop.
          await supabase
            .from('broadcasts')
            .update({
              status: 'failed',
              failed_count: contacts.length,
            })
            .eq('id', broadcast.id);
          throw new Error(
            `Failed to insert recipient batch ${i / INSERT_BATCH_SIZE + 1}: ${recipientError.message}`,
          );
        }
      }

      // ── Step 4: Fetch recipients back (joined contact) ────────────
      setProgress(30);
      const { data: recipients, error: recipientsFetchError } = await supabase
        .from('broadcast_recipients')
        .select('*, contact:contacts(*)')
        .eq('broadcast_id', broadcast.id);

      if (recipientsFetchError || !recipients) {
        throw new Error('Failed to fetch broadcast recipients');
      }

      let failedCount = 0;
      const totalRecipients = recipients.length;

      for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
        const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

        const apiRecipients = batch
          .filter((r) => r.contact?.phone)
          .map((r) => {
            // Read back off the row rather than re-resolved, so this
            // pass and any later resume send identical params. A
            // media-header template whose link was left empty falls
            // back to the template's stored URL on the server.
            const { params, messageParams } = parseRecipientParams(
              r.template_params,
            );
            return {
              phone: r.contact!.phone as string,
              params,
              ...(messageParams ? { messageParams } : {}),
            };
          });

        if (apiRecipients.length === 0) continue;

        try {
          // Send the batch, waiting out a 429 rather than writing the
          // whole batch off as failed. Only 429 is replayed — see
          // batchRetryDelayMs for why nothing else can be.
          let data: { error?: string; results?: BroadcastApiResult[] } = {};
          for (let attempt = 1; ; attempt++) {
            const res = await fetch('/api/whatsapp/broadcast', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                recipients: apiRecipients,
                template_name: payload.template.name,
                template_language: payload.template.language ?? 'en_US',
              }),
            });

            data = await res.json();
            if (res.ok) break;

            const retryIn =
              attempt < BATCH_SEND_ATTEMPTS
                ? batchRetryDelayMs(res.status, res.headers.get('Retry-After'))
                : null;
            if (retryIn === null) {
              throw new Error(data.error || 'Broadcast API request failed');
            }
            await sleep(retryIn);
          }

          const resultsByPhone = new Map<string, BroadcastApiResult>();
          for (const r of (data.results ?? []) as BroadcastApiResult[]) {
            resultsByPhone.set(r.phone, r);
          }

          for (const recipient of batch) {
            const phone = recipient.contact?.phone;
            const result = phone ? resultsByPhone.get(phone) : undefined;

            if (!result) {
              failedCount++;
              await supabase
                .from('broadcast_recipients')
                .update({
                  status: 'failed',
                  error_message: 'No phone number on contact',
                })
                .eq('id', recipient.id);
              continue;
            }

            if (result.status === 'sent') {
              await supabase
                .from('broadcast_recipients')
                .update({
                  status: 'sent',
                  sent_at: new Date().toISOString(),
                  whatsapp_message_id: result.whatsapp_message_id ?? null,
                  error_message: null,
                })
                .eq('id', recipient.id);
            } else {
              failedCount++;
              await supabase
                .from('broadcast_recipients')
                .update({
                  status: 'failed',
                  error_message: result.error ?? 'Unknown error',
                })
                .eq('id', recipient.id);
            }
          }
        } catch (err) {
          for (const recipient of batch) {
            failedCount++;
            await supabase
              .from('broadcast_recipients')
              .update({
                status: 'failed',
                error_message: err instanceof Error ? err.message : 'Unknown error',
              })
              .eq('id', recipient.id);
          }
        }

        const progressPct =
          30 + Math.round(((i + batch.length) / totalRecipients) * 60);
        setProgress(progressPct);

        if (i + SEND_BATCH_SIZE < recipients.length) {
          await sleep(SEND_BATCH_DELAY_MS);
        }
      }

      // ── Step 5: Finalize status ───────────────────────────────────
      // Aggregate counts are maintained by the DB trigger (migration
      // 003); we only flip the final status here.
      setProgress(95);
      const finalStatus = failedCount === totalRecipients ? 'failed' : 'sent';
      await supabase
        .from('broadcasts')
        .update({ status: finalStatus })
        .eq('id', broadcast.id);

      setProgress(100);
      return broadcast.id;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
