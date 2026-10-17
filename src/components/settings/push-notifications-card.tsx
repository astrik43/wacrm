'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { BellRing, CircleAlert, Loader2, Share, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  disablePush,
  enablePush,
  hasPushSubscription,
  isIOS,
  isPushSupported,
  isStandalone,
  readPushDevice,
  subscribePushDevice,
} from '@/lib/push/client';

const serverFalse = () => false;

/**
 * "Phone notifications" — Web Push for this device, delivered even when
 * the app is closed. On iPhone it only works once the CRM is added to
 * the Home Screen and opened from there (iOS 16.4+), so the card says
 * how instead of offering a switch that can't work.
 */
export function PushNotificationsCard({ className }: { className?: string }) {
  const t = useTranslations('Settings.pushNotifications');
  const enabled = useSyncExternalStore(subscribePushDevice, readPushDevice, serverFalse);
  const [env, setEnv] = useState<{
    supported: boolean;
    ios: boolean;
    standalone: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    // Browser-only checks, after hydration.
    setEnv({ supported: isPushSupported(), ios: isIOS(), standalone: isStandalone() });
    // The flag can outlive a subscription the browser dropped.
    void hasPushSubscription().then((has) => {
      if (!has && readPushDevice()) void disablePush();
    });
  }, []);

  const onToggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (!next) {
        await disablePush();
        return;
      }
      const result = await enablePush();
      if (result.ok) {
        toast.success(t('enabledToast'));
      } else {
        toast.error(t(`errors.${result.reason}`));
      }
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/push/test', { method: 'POST' });
      const body = (await res.json().catch(() => null)) as { sent?: number; error?: string } | null;
      if (!res.ok) toast.error(body?.error ?? t('errors.failed'));
      else if (!body?.sent) toast.error(t('testNone'));
      else toast.success(t('testSent'));
    } finally {
      setTesting(false);
    }
  };

  const needsInstall = env?.ios && !env.standalone;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Smartphone className="size-4 text-muted-foreground" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {env === null ? null : needsInstall ? (
          <div className="space-y-2 rounded-md border border-border p-3 text-sm">
            <p className="font-medium text-foreground">{t('iosTitle')}</p>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>
                {t('iosStep1')} <Share className="inline size-3.5 align-text-bottom" />
              </li>
              <li>{t('iosStep2')}</li>
              <li>{t('iosStep3')}</li>
            </ol>
          </div>
        ) : !env.supported ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleAlert className="size-4 shrink-0" />
            {t('unsupported')}
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{t('toggleLabel')}</p>
                <p className="text-xs text-muted-foreground">{t('toggleDesc')}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                <Switch
                  checked={enabled}
                  onCheckedChange={(next) => void onToggle(next)}
                  disabled={busy}
                  aria-label={t('toggleLabel')}
                />
              </div>
            </div>
            {enabled && (
              <Button variant="outline" size="sm" onClick={() => void sendTest()} disabled={testing}>
                {testing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <BellRing className="size-4" />
                )}
                {t('sendTest')}
              </Button>
            )}
            {!env.standalone && (
              <p className="text-xs text-muted-foreground">{t('installHint')}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
