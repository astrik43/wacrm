// ============================================================
// POST /api/flexype/webhook/[token]
//
// FlexyPe's Abandoned Checkout Recovery webhook (Settings → Webhooks
// in the FlexyPe dashboard). The token is the account's Shopify
// webhook token — FlexyPe carts feed the Shopify cart reminders — and
// the X-Flexype-Authorization header must equal the secret the CRM
// generated for FlexyPe (shopify_configs.flexype_secret). FlexyPe
// sends that secret verbatim; there is no body signature.
//
// FlexyPe wants a 200 within 10 seconds and retries a failure after
// 1, 5 and 15 minutes with the same X-Event-Id, so the work runs in
// after(); a retry finds its reminders already claimed (dedupe key per
// checkout) and changes nothing.
//
//   404  unknown token, or FlexyPe not switched on for it
//   401  wrong secret          400  body isn't JSON
//   503  our DB is unavailable (FlexyPe retries)
//
// Deliveries are written to the Shopify webhook log under the topic
// `flexype/abandoned_checkout`.
// ============================================================

import crypto from 'crypto';
import { NextResponse, after } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  isFlexypeSample,
  parseFlexypeAbandonedCheckout,
} from '@/lib/flexype/acr';
import { getShopifyConfigByToken } from '@/lib/shopify/config';
import { processFlexypeCheckout } from '@/lib/shopify/process';
import {
  finishWebhookEvent,
  recordWebhookEvent,
} from '@/lib/shopify/webhook-log';
import { decrypt } from '@/lib/whatsapp/encryption';

export const maxDuration = 60;

const TOPIC = 'flexype/abandoned_checkout';

function sameSecret(given: string | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const rawBody = await request.text();

  const db = supabaseAdmin();
  const { config, error } = await getShopifyConfigByToken(db, token);
  if (error) {
    return NextResponse.json({ error: 'Temporarily unavailable' }, { status: 503 });
  }
  if (!config || !config.flexype_secret) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let secret = '';
  try {
    secret = decrypt(config.flexype_secret);
  } catch (err) {
    console.error(
      '[flexype webhook] could not decrypt secret:',
      err instanceof Error ? err.message : err
    );
  }
  const eventId = request.headers.get('x-event-id');
  const logBase = {
    account_id: config.account_id,
    topic: TOPIC,
    shopify_webhook_id: eventId,
    shop_domain: null,
  };

  if (!sameSecret(request.headers.get('x-flexype-authorization'), secret)) {
    console.warn('[flexype webhook] rejected: wrong secret');
    after(async () => {
      await recordWebhookEvent(db, {
        ...logBase,
        status: 'rejected',
        detail: 'invalid_signature',
      });
    });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    after(async () => {
      await recordWebhookEvent(db, {
        ...logBase,
        status: 'rejected',
        detail: 'invalid_json',
      });
    });
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  after(async () => {
    const parsed = parseFlexypeAbandonedCheckout(
      payload,
      config.default_country_code
    );
    const logId = await recordWebhookEvent(db, {
      ...logBase,
      shop_domain: parsed.ok ? parsed.checkout.shopDomain : null,
      status: 'received',
      order_ref: parsed.ok
        ? (parsed.checkout.customerName ?? parsed.checkout.phone)
        : null,
      payload,
    });

    try {
      const { error: touchErr } = await db
        .from('shopify_configs')
        .update({ flexype_last_webhook_at: new Date().toISOString() })
        .eq('id', config.id);
      if (touchErr) {
        console.error('[flexype webhook] touch failed:', touchErr.message);
      }

      if (!config.is_active) {
        await finishWebhookEvent(db, logId, {
          status: 'ignored',
          detail: 'connection_paused',
        });
        return;
      }
      if (!parsed.ok) {
        await finishWebhookEvent(db, logId, {
          status: parsed.reason === 'unsupported_event' ? 'ignored' : 'processed',
          detail:
            parsed.reason === 'unsupported_event'
              ? 'unsupported_topic'
              : parsed.reason,
        });
        return;
      }

      // FlexyPe's "Test" button: proves the URL and secret work.
      if (isFlexypeSample(parsed.checkout)) {
        await finishWebhookEvent(db, logId, {
          status: 'processed',
          detail: 'test_event',
        });
        return;
      }

      const result = await processFlexypeCheckout(
        db,
        config,
        parsed.checkout,
        eventId
      );
      await finishWebhookEvent(db, logId, {
        // Test mode drops deliveries for anyone but the test numbers.
        status: result.note === 'test_mode' ? 'ignored' : 'processed',
        detail: result.note ?? null,
        order_ref: result.orderRef,
        outcome: result.outcomes,
      });
    } catch (err) {
      console.error('[flexype webhook] processing failed:', err);
      await finishWebhookEvent(db, logId, {
        status: 'error',
        detail: err instanceof Error ? err.message : 'unknown_error',
      });
    }
  });

  return NextResponse.json({ received: true });
}
