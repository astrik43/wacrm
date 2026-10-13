'use client';

// ============================================================
// ShopifySettings — Settings → Shopify
//
// Top to bottom:
//   1. Connection — paste Shopify's webhook signing secret, copy the
//      webhook URL, and see which webhooks to add in Shopify.
//   2. Shopify app — credentials for product pictures and order tags.
//   3. Order updates and cart reminders — one row per update with its
//      switch and template; a COD or prepaid template shows as a
//      sub-row under its update.
//   4. Activity — what was sent, scheduled, skipped or failed, and why.
//
// Any member can read; admin+ changes things (gated here by
// <RequireRole> / canEditSettings and on the server by requireRole +
// RLS). The signing secret is write-only: once saved it is never
// shown again, only replaced.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, RefreshCw, ShoppingBag } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import {
  SHOPIFY_TOPICS,
  isCartEvent,
  type ShopifyEvent,
  type ShopifyVariant,
} from '@/lib/shopify/events';
import { SettingsPanelHead } from './settings-panel-head';
import { ShopifyWebhookLog, shopifyReasonText } from './shopify-webhook-log';
import {
  ShopifyEventDialog,
  type ShopifyEventSetting,
} from './shopify-event-dialog';

interface ShopifyConfig {
  id: string;
  shop_domain: string | null;
  default_country_code: string | null;
  is_active: boolean;
  last_webhook_at: string | null;
  /** Null for non-admins. */
  webhook_path: string | null;
  has_api_credentials: boolean;
  /** Whether the app may tag orders; null = not known yet. */
  can_tag_orders: boolean | null;
  /** Null for non-admins. */
  api_client_id: string | null;
}

interface ShopifyNotification {
  id: string;
  event: ShopifyEvent;
  order_name: string | null;
  shopify_order_id: string | null;
  status: 'pending' | 'scheduled' | 'sent' | 'skipped' | 'failed' | 'cancelled';
  reason: string | null;
  send_at: string | null;
  created_at: string;
}

// A claim that never reached sent/skipped/failed means the process
// died mid-send; after this long we stop calling it "sending".
const PENDING_STALE_MS = 5 * 60 * 1000;

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function fmtDelay(
  t: ReturnType<typeof useTranslations>,
  minutes: number
): string {
  if (minutes % 1440 === 0) return t('delayDays', { count: minutes / 1440 });
  if (minutes % 60 === 0) return t('delayHours', { count: minutes / 60 });
  return t('delayMinutes', { count: minutes });
}

const STATUS_STYLE: Record<string, string> = {
  sent: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  skipped: 'border-border bg-muted text-muted-foreground',
  failed: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300',
  pending: 'border-border bg-muted text-muted-foreground',
  scheduled: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300',
  cancelled: 'border-border bg-muted text-muted-foreground',
  unknown: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300',
};

export function ShopifySettings() {
  const { canEditSettings } = useAuth();
  const t = useTranslations('Settings.shopify');

  const [config, setConfig] = useState<ShopifyConfig | null>(null);
  const [events, setEvents] = useState<ShopifyEventSetting[]>([]);
  const [activity, setActivity] = useState<ShopifyNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [secret, setSecret] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [apiClientId, setApiClientId] = useState('');
  const [apiClientSecret, setApiClientSecret] = useState('');
  const [shopDomain, setShopDomain] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [editing, setEditing] = useState<{
    event: ShopifyEvent;
    variant: ShopifyVariant;
  } | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [overdue, setOverdue] = useState(0);

  const load = useCallback(async () => {
    try {
      const [configRes, eventsRes, activityRes] = await Promise.all([
        fetch('/api/shopify/config', { cache: 'no-store' }),
        fetch('/api/shopify/events', { cache: 'no-store' }),
        fetch('/api/shopify/notifications', { cache: 'no-store' }),
      ]);
      if (!configRes.ok || !eventsRes.ok || !activityRes.ok) {
        toast.error(t('loadFailed'));
        return;
      }
      const configData = (await configRes.json()) as {
        config: ShopifyConfig | null;
      };
      const eventsData = (await eventsRes.json()) as {
        events: ShopifyEventSetting[];
      };
      const activityData = (await activityRes.json()) as {
        notifications: ShopifyNotification[];
        overdue?: number;
      };
      setConfig(configData.config);
      setCountryCode(configData.config?.default_country_code ?? '');
      setApiClientId(configData.config?.api_client_id ?? '');
      setEvents(eventsData.events);
      setActivity(activityData.notifications);
      setOverdue(activityData.overdue ?? 0);
    } catch (err) {
      console.error('[ShopifySettings] load error:', err);
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

  async function putConfig(body: Record<string, unknown>): Promise<boolean> {
    setSaving(true);
    try {
      const res = await fetch('/api/shopify/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('saveFailed'));
        return false;
      }
      setConfig(payload.config as ShopifyConfig);
      setCountryCode((payload.config as ShopifyConfig).default_country_code ?? '');
      setApiClientId((payload.config as ShopifyConfig).api_client_id ?? '');
      setSecret('');
      setApiClientSecret('');
      return true;
    } catch (err) {
      console.error('[ShopifySettings] save error:', err);
      toast.error(t('networkError'));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveConnection() {
    const trimmedSecret = secret.trim();
    if (!config && !trimmedSecret) {
      toast.error(t('secretRequired'));
      return;
    }
    const ok = await putConfig({
      ...(trimmedSecret ? { webhook_secret: trimmedSecret } : {}),
      default_country_code: countryCode.trim() || null,
    });
    if (ok) toast.success(t('saved'));
  }

  async function handleSaveApi() {
    if (!apiClientId.trim() || !apiClientSecret.trim()) {
      toast.error(t('apiRequired'));
      return;
    }
    const ok = await putConfig({
      api_client_id: apiClientId.trim(),
      api_client_secret: apiClientSecret.trim(),
      ...(shopDomain.trim() ? { shop_domain: shopDomain.trim() } : {}),
    });
    if (ok) toast.success(t('apiSaved'));
  }

  async function handleRemoveApi() {
    const ok = await putConfig({ api_client_id: null });
    if (ok) toast.success(t('apiRemoved'));
  }

  async function handleDisconnect() {
    setSaving(true);
    try {
      const res = await fetch('/api/shopify/config', { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      setConfig(null);
      setConfirmDisconnect(false);
      toast.success(t('disconnected'));
    } catch (err) {
      console.error('[ShopifySettings] disconnect error:', err);
      toast.error(t('networkError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(setting: ShopifyEventSetting, next: boolean) {
    // Switching on needs a template and a complete mapping — open the
    // dialog instead of letting the server reject it.
    if (next && !setting.template_name) {
      setEditing({ event: setting.event, variant: setting.variant });
      return;
    }
    setToggling(`${setting.event}:${setting.variant}`);
    try {
      const res = await fetch('/api/shopify/events', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...setting, is_enabled: next }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      setEvents((prev) =>
        prev.map((e) =>
          e.event === setting.event && e.variant === setting.variant
            ? { ...e, is_enabled: next }
            : e
        )
      );
    } catch (err) {
      console.error('[ShopifySettings] toggle error:', err);
      toast.error(t('networkError'));
    } finally {
      setToggling(null);
    }
  }

  async function copyWebhookUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('copySuccess'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  // One row per update; a COD / prepaid template that has been set up
  // shows as its own sub-row.
  const visibleRows = events.filter(
    (e) => e.variant === 'all' || e.template_name
  );
  const groups = [
    {
      key: 'orders',
      title: t('eventsTitle'),
      desc: t('eventsDesc'),
      rows: visibleRows.filter((e) => !isCartEvent(e.event)),
    },
    {
      key: 'carts',
      title: t('cartTitle'),
      desc: t('cartDesc'),
      rows: visibleRows.filter((e) => isCartEvent(e.event)),
    },
  ];

  const webhookUrl =
    config?.webhook_path && typeof window !== 'undefined'
      ? `${window.location.origin}${config.webhook_path}`
      : null;

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {/* ---- Connection ------------------------------------------ */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ShoppingBag className="text-muted-foreground size-4" />
            <span className="text-foreground text-sm font-medium">
              {config?.shop_domain ?? t('connectTitle')}
            </span>
            <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
              {!config
                ? t('statusNotConnected')
                : config.is_active
                  ? t('statusConnected')
                  : t('statusPaused')}
            </Badge>
            {config && (
              <span className="text-muted-foreground text-xs">
                {config.last_webhook_at
                  ? t('lastEvent', { date: fmtDateTime(config.last_webhook_at) })
                  : t('noEventsYet')}
              </span>
            )}
          </div>

          {!canEditSettings ? (
            <p className="text-muted-foreground text-sm">{t('adminOnly')}</p>
          ) : (
            <>
              {webhookUrl && (
                <div className="space-y-1.5">
                  <Label className="text-muted-foreground">
                    {t('webhookUrlLabel')}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="shopify-webhook-url"
                      readOnly
                      value={webhookUrl}
                      className="font-mono text-xs"
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => copyWebhookUrl(webhookUrl)}
                    >
                      <Copy className="size-4" />
                      {t('copy')}
                    </Button>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {t('webhookUrlHint')}
                  </p>
                  <ul className="text-foreground flex flex-wrap gap-1.5 pt-1">
                    {SHOPIFY_TOPICS.map((topic) => (
                      <li key={topic}>
                        <Badge className="border-border bg-muted text-muted-foreground text-[11px]">
                          {t(`topics.${topic.replace('/', '_')}`)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="shopify-secret" className="text-muted-foreground">
                    {t('secretLabel')}
                  </Label>
                  <Input
                    id="shopify-secret"
                    type="password"
                    autoComplete="off"
                    value={secret}
                    placeholder={
                      config ? t('secretSavedPlaceholder') : t('secretPlaceholder')
                    }
                    onChange={(e) => setSecret(e.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">{t('secretHint')}</p>
                </div>
                <div className="space-y-1.5">
                  <Label
                    htmlFor="shopify-country-code"
                    className="text-muted-foreground"
                  >
                    {t('countryCodeLabel')}
                  </Label>
                  <Input
                    id="shopify-country-code"
                    inputMode="numeric"
                    maxLength={4}
                    value={countryCode}
                    placeholder="91"
                    onChange={(e) =>
                      setCountryCode(e.target.value.replace(/[^\d]/g, ''))
                    }
                  />
                  <p className="text-muted-foreground text-xs">
                    {t('countryCodeHint')}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={handleSaveConnection} disabled={saving}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                  {config ? t('save') : t('connectButton')}
                </Button>
                {config && (
                  <>
                    <Button
                      variant="outline"
                      disabled={saving}
                      onClick={() => putConfig({ is_active: !config.is_active })}
                    >
                      {config.is_active ? t('pause') : t('resume')}
                    </Button>
                    {confirmDisconnect ? (
                      <Button
                        variant="outline"
                        disabled={saving}
                        onClick={handleDisconnect}
                        className="border-red-500/40 bg-red-500/10 text-red-600 hover:bg-red-500/20 dark:text-red-300"
                      >
                        {t('disconnectConfirm')}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        disabled={saving}
                        onClick={() => setConfirmDisconnect(true)}
                      >
                        {t('disconnect')}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ---- Product images -------------------------------------- */}
      {config && canEditSettings && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-foreground text-sm font-semibold">
                  {t('productImagesTitle')}
                </h3>
                <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                  {config.has_api_credentials
                    ? t('apiConnected')
                    : t('apiNotConnected')}
                </Badge>
              </div>
              <p className="text-muted-foreground mt-1 text-sm">
                {t('productImagesDesc')}
              </p>
              {config.has_api_credentials && config.can_tag_orders !== null && (
                <p className="text-muted-foreground mt-1 text-sm">
                  {config.can_tag_orders ? t('tagOrdersOn') : t('tagOrdersOff')}
                </p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label
                  htmlFor="shopify-api-client-id"
                  className="text-muted-foreground"
                >
                  {t('clientIdLabel')}
                </Label>
                <Input
                  id="shopify-api-client-id"
                  autoComplete="off"
                  value={apiClientId}
                  onChange={(e) => setApiClientId(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label
                  htmlFor="shopify-api-client-secret"
                  className="text-muted-foreground"
                >
                  {t('clientSecretLabel')}
                </Label>
                <Input
                  id="shopify-api-client-secret"
                  type="password"
                  autoComplete="off"
                  value={apiClientSecret}
                  placeholder={
                    config.has_api_credentials
                      ? t('secretSavedPlaceholder')
                      : undefined
                  }
                  onChange={(e) => setApiClientSecret(e.target.value)}
                />
              </div>
              {!config.shop_domain && (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label
                    htmlFor="shopify-shop-domain"
                    className="text-muted-foreground"
                  >
                    {t('shopDomainLabel')}
                  </Label>
                  <Input
                    id="shopify-shop-domain"
                    autoComplete="off"
                    value={shopDomain}
                    placeholder="your-store.myshopify.com"
                    onChange={(e) => setShopDomain(e.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">
                    {t('shopDomainHint')}
                  </p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={handleSaveApi} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('apiSave')}
              </Button>
              {config.has_api_credentials && (
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={handleRemoveApi}
                >
                  {t('apiRemove')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---- Order updates / cart reminders ---------------------- */}
      {groups.map((group) => (
        <div key={group.key}>
          <h3 className="text-foreground text-sm font-semibold">{group.title}</h3>
          <p className="text-muted-foreground mt-1 text-sm">{group.desc}</p>
          <Card className="mt-3">
            <CardContent className="p-0">
              <ul className="divide-border divide-y">
                {group.rows.map((setting) => {
                  const rowKey = `${setting.event}:${setting.variant}`;
                  const label =
                    setting.variant === 'all'
                      ? t(`events.${setting.event}.label`)
                      : `${t(`events.${setting.event}.label`)} · ${t(`variants.${setting.variant}`)}`;
                  return (
                    <li
                      key={rowKey}
                      className={`flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 ${
                        setting.variant === 'all' ? '' : 'sm:pl-8'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-foreground text-sm font-medium">{label}</p>
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          {setting.template_name
                            ? t('usingTemplate', { name: setting.template_name })
                            : t('notConfigured')}
                          {setting.template_name && setting.delay_minutes > 0
                            ? ` · ${fmtDelay(t, setting.delay_minutes)}`
                            : ''}
                        </p>
                      </div>
                      <RequireRole min="admin">
                        <div className="flex items-center gap-3">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setEditing({
                                event: setting.event,
                                variant: setting.variant,
                              })
                            }
                          >
                            {setting.template_name ? t('edit') : t('configure')}
                          </Button>
                          <Switch
                            checked={setting.is_enabled}
                            disabled={toggling === rowKey}
                            onCheckedChange={(next) => handleToggle(setting, next)}
                            aria-label={label}
                          />
                        </div>
                      </RequireRole>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        </div>
      ))}

      {/* ---- Activity -------------------------------------------- */}
      <div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-foreground text-sm font-semibold">
              {t('activityTitle')}
            </h3>
            <p className="text-muted-foreground mt-1 text-sm">{t('activityDesc')}</p>
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
        {overdue > 0 && (
          <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
            {t('overdueWarning', { count: overdue })}
          </p>
        )}
        <Card className="mt-3">
          <CardContent className="p-0">
            {activity.length === 0 ? (
              <p className="text-muted-foreground px-4 py-8 text-center text-sm">
                {t('noActivity')}
              </p>
            ) : (
              <ul className="divide-border divide-y">
                {activity.map((n) => {
                  const stale =
                    n.status === 'pending' &&
                    Date.now() - new Date(n.created_at).getTime() >
                      PENDING_STALE_MS;
                  const status = stale ? 'unknown' : n.status;
                  return (
                    <li
                      key={n.id}
                      className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-foreground text-sm">
                          <span className="font-medium">
                            {n.order_name ?? n.shopify_order_id ?? '—'}
                          </span>
                          {' · '}
                          {t(`events.${n.event}.label`)}
                        </p>
                        {n.reason && (
                          <p className="text-muted-foreground mt-0.5 text-xs break-words">
                            {shopifyReasonText(t, n.reason)}
                          </p>
                        )}
                        {n.status === 'scheduled' && n.send_at && (
                          <p className="text-muted-foreground mt-0.5 text-xs">
                            {t('sendsAt', { date: fmtDateTime(n.send_at) })}
                          </p>
                        )}
                      </div>
                      <span className="text-muted-foreground text-xs">
                        {fmtDateTime(n.created_at)}
                      </span>
                      <Badge
                        className={`text-[10px] tracking-wide uppercase ${STATUS_STYLE[status]}`}
                      >
                        {t(`status.${status}`)}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- Webhook log ----------------------------------------- */}
      {config && canEditSettings && <ShopifyWebhookLog />}

      {editing && (
        <ShopifyEventDialog
          settings={events.filter((e) => e.event === editing.event)}
          initialVariant={editing.variant}
          hasApiCredentials={config?.has_api_credentials ?? false}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={load}
        />
      )}
    </section>
  );
}
