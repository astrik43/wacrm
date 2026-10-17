"use client";

import { useEffect } from "react";

import { useBrowserNotifications } from "@/hooks/use-browser-notifications";
import { registerServiceWorker } from "@/lib/push/client";

/**
 * Headless. Mount ONCE per signed-in dashboard tab (the dashboard
 * shell, below the auth gate) so desktop notifications for new customer
 * messages fire on every dashboard page, not just the inbox.
 */
export function BrowserNotificationsListener() {
  useBrowserNotifications();
  // Keep the push service worker registered and current on every
  // dashboard load, so the installed app gets notifications.
  useEffect(() => {
    void registerServiceWorker();
  }, []);
  return null;
}
