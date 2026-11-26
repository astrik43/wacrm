// ============================================================
// One-off test delivery to a webhook endpoint.
//
// Same signing, SSRF guard, no-redirect and timeout rules as
// deliver.ts, but it never touches the endpoint's failure counter or
// last_delivery_at (a test must not auto-disable a live endpoint).
// ============================================================

import { randomUUID } from 'node:crypto';

import { decrypt } from '@/lib/whatsapp/encryption';
import { buildSignatureHeader } from '@/lib/webhooks/sign';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import { DELIVERY_TIMEOUT_MS } from '@/lib/webhooks/deliver';

export const TEST_WEBHOOK_EVENT = 'webhook.test';

export interface TestDeliveryResult {
  delivered: boolean;
  http_status: number | null;
  error: string | null;
}

/** Build the signed JSON body for a test delivery (exported for tests). */
export function buildTestPayload(accountId: string): string {
  return JSON.stringify({
    id: randomUUID(),
    event: TEST_WEBHOOK_EVENT,
    occurred_at: new Date().toISOString(),
    account_id: accountId,
    data: { message: 'This is a test delivery from wacrm.' },
  });
}

export async function deliverTestWebhook(
  accountId: string,
  endpoint: { id: string; url: string; secret: string }
): Promise<TestDeliveryResult> {
  if (!(await isDeliverableUrl(endpoint.url))) {
    return {
      delivered: false,
      http_status: null,
      error: 'Endpoint URL does not resolve to a public address.',
    };
  }

  let secret: string;
  try {
    secret = decrypt(endpoint.secret);
  } catch {
    return {
      delivered: false,
      http_status: null,
      error: 'Signing secret could not be decrypted (check ENCRYPTION_KEY).',
    };
  }

  const payload = buildTestPayload(accountId);
  const tsSeconds = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wacrm-Event': TEST_WEBHOOK_EVENT,
        'X-Wacrm-Webhook-Id': endpoint.id,
        'X-Wacrm-Signature': buildSignatureHeader(payload, secret, tsSeconds),
      },
      body: payload,
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    return {
      delivered: res.ok,
      http_status: res.status,
      error: res.ok ? null : `Endpoint responded ${res.status}.`,
    };
  } catch (err) {
    return {
      delivered: false,
      http_status: null,
      error: err instanceof Error ? err.message : 'Request failed.',
    };
  }
}
