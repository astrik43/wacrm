// ============================================================
// POST /api/shiprocket/webhook/[token]
//
// Shiprocket Checkout's (Fastrr) "Abandon Cart" webhook (Settings →
// Webhooks in the Shiprocket Checkout dashboard). The token is the
// account's Shopify webhook token — Shiprocket carts feed the Shopify
// cart reminders — and the secret the CRM generated for Shiprocket
// (shopify_configs.shiprocket_secret) must arrive in the
// X-Chatstrik-Secret header, added under the webhook's Headers.
// `Authorization: Bearer <secret>` is accepted too. Shiprocket signs
// nothing, so this header is the only proof the delivery is theirs.
//
// The work runs in after() so Shiprocket gets its 200 at once; a
// repeat delivery for the same cart finds its reminders already
// claimed (dedupe key per checkout) and changes nothing.
//
//   404  unknown token, or Shiprocket not switched on for it
//   401  wrong secret          400  body isn't JSON
//   503  our DB is unavailable
//
// Deliveries are written to the Shopify webhook log under the topic
// `shiprocket/abandoned_cart`.
// ============================================================

import crypto from 'crypto';
import { NextResponse, after } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  SHIPROCKET_SECRET_HEADER,
  parseShiprocketAbandonedCart,
} from '@/lib/shiprocket/abandoned-cart';
import { getShopifyConfigByToken } from '@/lib/shopify/config';
import { processExternalCheckout } from '@/lib/shopify/process';
import {
  finishWebhookEvent,
  recordWebhookEvent,
} from '@/lib/shopify/webhook-log';
import { decrypt } from '@/lib/whatsapp/encryption';

export const maxDuration = 60;

const TOPIC = 'shiprocket/abandoned_cart';

function sameSecret(given: string | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function givenSecret(request: Request): string | null {
  const header = request.headers.get(SHIPROCKET_SECRET_HEADER)?.trim();
  if (header) return header;
  const auth = request.headers.get('authorization')?.trim();
  return auth ? auth.replace(/^Bearer\s+/i, '') : null;
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
  if (!config || !config.shiprocket_secret) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let secret = '';
  try {
    secret = decrypt(config.shiprocket_secret);
  } catch (err) {
    console.error(
      '[shiprocket webhook] could not decrypt secret:',
      err instanceof Error ? err.message : err
    );
  }
  const logBase = {
    account_id: config.account_id,
    topic: TOPIC,
    shopify_webhook_id: null,
    shop_domain: null,
  };

  if (!sameSecret(givenSecret(request), secret)) {
    console.warn('[shiprocket webhook] rejected: wrong secret');
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
    const parsed = parseShiprocketAbandonedCart(
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
        .update({ shiprocket_last_webhook_at: new Date().toISOString() })
        .eq('id', config.id);
      if (touchErr) {
        console.error('[shiprocket webhook] touch failed:', touchErr.message);
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
          status: parsed.reason === 'checkout_completed' ? 'ignored' : 'processed',
          detail: parsed.reason,
        });
        return;
      }

      const result = await processExternalCheckout(
        db,
        config,
        parsed.checkout,
        null
      );
      await finishWebhookEvent(db, logId, {
        // Test mode drops deliveries for anyone but the test numbers.
        status: result.note === 'test_mode' ? 'ignored' : 'processed',
        detail: result.note ?? null,
        order_ref: result.orderRef,
        outcome: result.outcomes,
      });
    } catch (err) {
      console.error('[shiprocket webhook] processing failed:', err);
      await finishWebhookEvent(db, logId, {
        status: 'error',
        detail: err instanceof Error ? err.message : 'unknown_error',
      });
    }
  });

  return NextResponse.json({ received: true });
}
