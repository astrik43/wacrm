// ============================================================
// POST /api/shopify/webhook/[token]
//
// Receives the webhooks a merchant adds by hand in Shopify admin
// (Settings → Notifications → Webhooks). There is no session and no
// API key: the unguessable `token` selects the account, and the
// HMAC over the raw body — keyed by that account's signing secret —
// proves the request came from Shopify.
//
// Shopify gives a delivery five seconds, and removes a webhook that
// keeps failing, so we acknowledge as soon as the request is
// authenticated and do the sending in after(). Status codes before
// the ack are chosen for Shopify's retry behaviour:
//   404  unknown token            401  bad signature
//   400  body isn't JSON          503  our DB is unavailable (retry)
//
// Every delivery that reaches a connected store is written to the
// webhook log (Settings → Shopify), including the ones rejected here,
// so a merchant can see what Shopify sent and what became of it.
// ============================================================

import { NextResponse, after } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { getShopifyConfigByToken } from '@/lib/shopify/config';
import { isShopifyTopic } from '@/lib/shopify/events';
import { processShopifyWebhook } from '@/lib/shopify/process';
import { verifyShopifyWebhookSignature } from '@/lib/shopify/signature';
import {
  finishWebhookEvent,
  orderRefOf,
  recordWebhookEvent,
} from '@/lib/shopify/webhook-log';
import { decrypt } from '@/lib/whatsapp/encryption';

// Sending runs inside after(); give it the same budget as the
// WhatsApp webhook.
export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  // Raw bytes, not text(): the HMAC is over exactly what Shopify sent.
  const rawBody = Buffer.from(await request.arrayBuffer());

  const db = supabaseAdmin();
  const { config, error } = await getShopifyConfigByToken(db, token);
  if (error) {
    return NextResponse.json({ error: 'Temporarily unavailable' }, { status: 503 });
  }
  if (!config) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let secret = '';
  try {
    secret = decrypt(config.webhook_secret);
  } catch (err) {
    console.error(
      '[shopify webhook] could not decrypt signing secret:',
      err instanceof Error ? err.message : err
    );
  }
  const signature = request.headers.get('x-shopify-hmac-sha256');
  const topic = request.headers.get('x-shopify-topic');
  const webhookId = request.headers.get('x-shopify-webhook-id');
  const shopDomain = request.headers.get('x-shopify-shop-domain');
  const logBase = {
    account_id: config.account_id,
    topic,
    shopify_webhook_id: webhookId,
    shop_domain: shopDomain,
  };

  if (!verifyShopifyWebhookSignature(rawBody, signature, secret)) {
    console.warn('[shopify webhook] rejected: invalid signature');
    // No payload: an unsigned body hasn't shown it came from Shopify.
    after(async () => {
      await recordWebhookEvent(db, {
        ...logBase,
        status: 'rejected',
        detail: 'invalid_signature',
      });
    });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
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
    const logId = await recordWebhookEvent(db, {
      ...logBase,
      status: 'received',
      order_ref: orderRefOf(payload),
      payload,
    });

    try {
      const { error: touchErr } = await db
        .from('shopify_configs')
        .update({
          last_webhook_at: new Date().toISOString(),
          ...(shopDomain && shopDomain !== config.shop_domain
            ? { shop_domain: shopDomain }
            : {}),
        })
        .eq('id', config.id);
      if (touchErr) {
        console.error('[shopify webhook] touch failed:', touchErr.message);
      }

      // A topic we don't handle, or a paused connection, is still a
      // successful delivery as far as Shopify is concerned.
      if (!config.is_active) {
        await finishWebhookEvent(db, logId, {
          status: 'ignored',
          detail: 'connection_paused',
        });
        return;
      }
      if (!isShopifyTopic(topic)) {
        await finishWebhookEvent(db, logId, {
          status: 'ignored',
          detail: 'unsupported_topic',
        });
        return;
      }

      const result = await processShopifyWebhook(
        db,
        config,
        topic,
        payload,
        webhookId
      );
      await finishWebhookEvent(db, logId, {
        // Test mode drops deliveries for anyone but the test numbers.
        status: result.note === 'test_mode' ? 'ignored' : 'processed',
        detail: result.note ?? null,
        order_ref: result.orderRef,
        outcome: result.outcomes,
      });
    } catch (err) {
      console.error('[shopify webhook] processing failed:', err);
      await finishWebhookEvent(db, logId, {
        status: 'error',
        detail: err instanceof Error ? err.message : 'unknown_error',
      });
    }
  });

  return NextResponse.json({ status: 'received' });
}
