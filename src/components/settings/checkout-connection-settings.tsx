'use client';

// ============================================================
// CheckoutConnectionSettings — Settings → FlexyPe / Shiprocket
//
// A third-party checkout that replaces Shopify's own sends its
// abandoned carts here, into the cart reminders configured under
// Settings → Shopify. Each provider has its own page: connect it to
// get a webhook URL and a secret to paste into the provider, see when
// it last delivered, rotate the secret or disconnect. Both can be on
// at once, so a store can switch checkouts without reconfiguring.
//
// The connection lives on the Shopify config row (same webhook token,
// same testing mode), so Shopify has to be connected first. Admin
// only — the section is hidden from other roles.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { SettingsPanelHead } from './settings-panel-head';

export type CheckoutProvider = 'flexype' | 'shiprocket';

const PROVIDER_NAME: Record<CheckoutProvider, string> = {
  flexype: 'FlexyPe',
  shiprocket: 'Shiprocket',
};

const STEPS: Record<CheckoutProvider, readonly string[]> = {
  flexype: ['step1', 'step2', 'step3', 'step4'],
  shiprocket: ['step1', 'step2', 'step3', 'step4', 'step5'],
};

interface CheckoutConnection {
  enabled: boolean;
  last_webhook_at: string | null;
  webhook_path: string | null;
  secret: string | null;
}

type ConfigResponse = {
  config: ({ id: string } & Record<CheckoutProvider, CheckoutConnection>) | null;
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function CheckoutConnectionSettings({
  provider,
  onOpenShopify,
}: {
  provider: CheckoutProvider;
  onOpenShopify: () => void;
}) {
  const { canEditSettings } = useAuth();
  const t = useTranslations('Settings.checkouts');
  const name = PROVIDER_NAME[provider];

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [shopifyConnected, setShopifyConnected] = useState(false);
  const [connection, setConnection] = useState<CheckoutConnection | null>(null);

  const apply = useCallback(
    (data: ConfigResponse) => {
      setShopifyConnected(Boolean(data.config));
      setConnection(data.config?.[provider] ?? null);
    },
    [provider]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/shopify/config', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as ConfigResponse;
        if (!cancelled) apply(data);
      })
      .catch((err) => {
        console.error('[CheckoutConnectionSettings] load error:', err);
        if (!cancelled) toast.error(t('loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apply]);

  async function save(next: 'generate' | null) {
    setSaving(true);
    try {
      const res = await fetch('/api/shopify/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [provider]: next }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      apply(payload as ConfigResponse);
      toast.success(next ? t('onToast', { name }) : t('offToast', { name }));
    } catch (err) {
      console.error('[CheckoutConnectionSettings] save error:', err);
      toast.error(t('networkError'));
    } finally {
      setSaving(false);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('copySuccess'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  const head = (
    <SettingsPanelHead
      title={t(`${provider}.title`)}
      description={t(`${provider}.desc`)}
    />
  );

  if (loading) {
    return (
      <section className="space-y-6">
        {head}
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-primary size-6 animate-spin" />
        </div>
      </section>
    );
  }

  if (!shopifyConnected) {
    return (
      <section className="animate-in fade-in-50 space-y-6 duration-200">
        {head}
        <Card>
          <CardContent className="space-y-3 p-4">
            <p className="text-muted-foreground text-sm">
              {t('needShopify', { name })}
            </p>
            <Button variant="outline" onClick={onOpenShopify}>
              {t('openShopify')}
            </Button>
          </CardContent>
        </Card>
      </section>
    );
  }

  const enabled = connection?.enabled ?? false;
  const webhookUrl =
    connection?.webhook_path && typeof window !== 'undefined'
      ? `${window.location.origin}${connection.webhook_path}`
      : null;
  const rows = [
    { id: `${provider}-url`, label: t('urlLabel'), value: webhookUrl ?? '' },
    // Shiprocket takes the secret as a custom header; spell out its name
    // (the server's SHIPROCKET_SECRET_HEADER — header names are
    // case-insensitive).
    ...(provider === 'shiprocket'
      ? [
          {
            id: `${provider}-header`,
            label: t('headerLabel'),
            value: 'X-Chatstrik-Secret',
          },
        ]
      : []),
    {
      id: `${provider}-secret`,
      label: t('secretLabel'),
      value: connection?.secret ?? '',
    },
  ];

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      {head}

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-foreground text-sm font-medium">{name}</span>
            <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
              {enabled ? t('on') : t('off')}
            </Badge>
            {enabled && (
              <span className="text-muted-foreground text-xs">
                {connection?.last_webhook_at
                  ? t('lastEvent', { date: fmtDateTime(connection.last_webhook_at) })
                  : t('noEventsYet')}
              </span>
            )}
          </div>

          {!canEditSettings ? (
            <p className="text-muted-foreground text-sm">{t('adminOnly')}</p>
          ) : (
            <>
              {enabled && webhookUrl && (
                <div className="space-y-3">
                  {rows.map((row) => (
                    <div key={row.id} className="space-y-1.5">
                      <Label htmlFor={row.id} className="text-muted-foreground">
                        {row.label}
                      </Label>
                      <div className="flex gap-2">
                        <Input
                          id={row.id}
                          readOnly
                          value={row.value}
                          className="font-mono text-xs"
                          onFocus={(e) => e.currentTarget.select()}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          disabled={!row.value}
                          onClick={() => copy(row.value)}
                        >
                          <Copy className="size-4" />
                          {t('copy')}
                        </Button>
                      </div>
                    </div>
                  ))}
                  <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-xs">
                    {STEPS[provider].map((step) => (
                      <li key={step}>{t(`${provider}.${step}`)}</li>
                    ))}
                  </ol>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {enabled ? (
                  <>
                    <Button
                      variant="outline"
                      disabled={saving}
                      onClick={() => save('generate')}
                    >
                      {t('regenerate')}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={saving}
                      onClick={() => save(null)}
                    >
                      {t('turnOff', { name })}
                    </Button>
                  </>
                ) : (
                  <Button disabled={saving} onClick={() => save('generate')}>
                    {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                    {t('turnOn', { name })}
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <p className="text-muted-foreground text-sm">{t('remindersNote')}</p>
          <Button variant="outline" onClick={onOpenShopify}>
            {t('remindersLink')}
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}
