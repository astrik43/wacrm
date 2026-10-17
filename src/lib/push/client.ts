// ============================================================
// Browser side of Web Push: register the service worker, subscribe
// this device and tell the server. All functions are SSR-safe.
// ============================================================

const PUSH_DEVICE_KEY = 'wacrm:push-device';
export const PUSH_CHANGE_EVENT = 'wacrm:push-change';

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Opened from the home screen (installed app) rather than a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac with touch.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/**
 * Whether this device receives push. Read by the in-tab notifier so a
 * device with push doesn't get every message twice.
 */
export function readPushDevice(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(PUSH_DEVICE_KEY) === '1';
  } catch {
    return false;
  }
}

function writePushDevice(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(PUSH_DEVICE_KEY, '1');
    else window.localStorage.removeItem(PUSH_DEVICE_KEY);
  } catch {
    // Best-effort.
  }
  window.dispatchEvent(new Event(PUSH_CHANGE_EVENT));
}

export function subscribePushDevice(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === PUSH_DEVICE_KEY) onChange();
  };
  window.addEventListener(PUSH_CHANGE_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(PUSH_CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
  } catch (err) {
    console.error('[push] service worker registration failed:', err);
    return null;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = window.atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type EnableResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'denied' | 'not_configured' | 'failed' };

/** Ask for permission, subscribe this device and save it on the server. */
export async function enablePush(): Promise<EnableResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  const config = (await fetch('/api/push/subscription')
    .then((r) => r.json())
    .catch(() => null)) as { enabled?: boolean; publicKey?: string | null } | null;
  if (!config?.enabled || !config.publicKey) {
    return { ok: false, reason: 'not_configured' };
  }

  try {
    const registration =
      (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      });
    }
    const res = await fetch('/api/push/subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!res.ok) return { ok: false, reason: 'failed' };
    writePushDevice(true);
    return { ok: true };
  } catch (err) {
    console.error('[push] subscribe failed:', err);
    return { ok: false, reason: 'failed' };
  }
}

/** Unsubscribe this device and forget it on the server. */
export async function disablePush(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      await fetch('/api/push/subscription', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }).catch(() => undefined);
      await subscription.unsubscribe();
    }
  } finally {
    writePushDevice(false);
  }
}

/** Whether this device currently holds a push subscription. */
export async function hasPushSubscription(): Promise<boolean> {
  if (!isPushSupported()) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  return Boolean(await registration?.pushManager.getSubscription());
}
