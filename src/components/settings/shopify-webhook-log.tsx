'use client';

// ============================================================
// ShopifyWebhookLog — the debugging table in Settings → Shopify.
//
// Lists every delivery Shopify made to this workspace's webhook URL:
// when, which topic, which order, and what became of it (which
// customer updates it produced, or why it produced none). "View"
// opens the stored payload. Admin+ only: the rows and payloads
// describe customers' orders.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ShopifyEvent } from '@/lib/shopify/events';

type Translator = ReturnType<typeof useTranslations>;

const KNOWN_REASONS = [
  'no_phone',
  'template_not_found',
  'template_not_approved',
  'template_malformed',
  'mapping_invalid',
  'db_error',
  'order_cancelled',
  'order_placed',
  'checkout_completed',
  'event_disabled',
];

/** Human text for a notification's skip / failure reason code. */
export function shopifyReasonText(t: Translator, reason: string | null): string {
  if (!reason) return '';
  if (KNOWN_REASONS.includes(reason)) return t(`reasons.${reason}`);
  if (reason.startsWith('missing_variable:')) {
    return t('reasons.missing_variable', {
      slot: reason.slice('missing_variable:'.length),
    });
  }
  return reason;
}

const KNOWN_DETAILS = [
  'invalid_signature',
  'invalid_json',
  'connection_paused',
  'unsupported_topic',
  'invalid_payload',
  'missing_id',
  'db_error',
  'order_already_cancelled',
  'stale_update',
  'no_change',
  'order_cancelled',
  'checkout_completed',
  'no_phone',
  'payload_too_large_to_store',
];

interface Outcome {
  event: ShopifyEvent;
  status: 'sent' | 'scheduled' | 'skipped' | 'failed' | 'duplicate' | 'disabled';
  reason?: string;
}

interface WebhookEvent {
  id: string;
  received_at: string;
  topic: string | null;
  shopify_webhook_id: string | null;
  order_ref: string | null;
  status: 'received' | 'processed' | 'ignored' | 'rejected' | 'error';
  detail: string | null;
  outcome: Outcome[] | null;
  shop_domain?: string | null;
  payload?: unknown;
}

const STATUS_STYLE: Record<WebhookEvent['status'], string> = {
  processed:
    'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  received: 'border-border bg-muted text-muted-foreground',
  ignored: 'border-border bg-muted text-muted-foreground',
  rejected: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300',
  error: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300',
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function resultLines(t: Translator, event: WebhookEvent): string[] {
  const lines = (event.outcome ?? []).map((o) => {
    const base = `${t(`events.${o.event}.label`)}: ${t(`outcomeStatus.${o.status}`)}`;
    return o.reason ? `${base} (${shopifyReasonText(t, o.reason)})` : base;
  });
  if (event.detail) {
    lines.push(
      KNOWN_DETAILS.includes(event.detail)
        ? t(`webhookDetail.${event.detail}`)
        : event.detail
    );
  }
  return lines;
}

export function ShopifyWebhookLog() {
  const t = useTranslations('Settings.shopify');

  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WebhookEvent | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/shopify/webhook-events', {
        cache: 'no-store',
      });
      if (!res.ok) {
        toast.error(t('webhookLogLoadFailed'));
        return;
      }
      const data = (await res.json()) as { events: WebhookEvent[] };
      setEvents(data.events);
    } catch (err) {
      console.error('[ShopifyWebhookLog] load error:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openEvent(id: string) {
    setOpenId(id);
    setDetail(null);
    try {
      const res = await fetch(`/api/shopify/webhook-events/${id}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        toast.error(t('webhookLogLoadFailed'));
        setOpenId(null);
        return;
      }
      const data = (await res.json()) as { event: WebhookEvent };
      setDetail(data.event);
    } catch (err) {
      console.error('[ShopifyWebhookLog] detail error:', err);
      toast.error(t('networkError'));
      setOpenId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-foreground text-sm font-semibold">
            {t('webhookLogTitle')}
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('webhookLogDesc')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void load();
          }}
        >
          <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
          {t('refresh')}
        </Button>
      </div>

      <Card className="mt-3">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="text-primary size-5 animate-spin" />
            </div>
          ) : events.length === 0 ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-sm">
              {t('webhookLogEmpty')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('colTime')}</TableHead>
                    <TableHead>{t('colTopic')}</TableHead>
                    <TableHead>{t('colOrder')}</TableHead>
                    <TableHead>{t('colStatus')}</TableHead>
                    <TableHead>{t('colResult')}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {fmtDateTime(event.received_at)}
                      </TableCell>
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        {event.topic ?? '—'}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {event.order_ref ?? '—'}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={`text-[10px] tracking-wide uppercase ${STATUS_STYLE[event.status]}`}
                        >
                          {t(`webhookStatus.${event.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground min-w-48 text-xs whitespace-normal">
                        {resultLines(t, event).map((line, i) => (
                          <span key={i} className="block">
                            {line}
                          </span>
                        ))}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openEvent(event.id)}
                        >
                          {t('view')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={openId !== null}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
      >
        <DialogContent className="border-border bg-popover max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground font-mono text-sm">
              {detail?.topic ?? t('webhookLogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {detail
                ? `${fmtDateTime(detail.received_at)} · ${detail.order_ref ?? '—'} · ${t(`webhookStatus.${detail.status}`)}`
                : ''}
            </DialogDescription>
          </DialogHeader>

          {!detail ? (
            <div className="flex justify-center py-8">
              <Loader2 className="text-primary size-5 animate-spin" />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-foreground space-y-1 text-sm">
                {resultLines(t, detail).map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </div>
              {detail.shopify_webhook_id && (
                <p className="text-muted-foreground text-xs break-all">
                  {t('webhookIdLabel')}: {detail.shopify_webhook_id}
                </p>
              )}
              {detail.payload ? (
                <pre className="border-border bg-muted text-foreground max-h-96 overflow-auto rounded-md border p-3 text-xs">
                  {JSON.stringify(detail.payload, null, 2)}
                </pre>
              ) : (
                <p className="text-muted-foreground text-sm">{t('payloadNone')}</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
