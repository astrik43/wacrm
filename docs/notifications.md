# Phone notifications and the installed app

wacrm can be installed on a phone or computer like an app, and can send
a notification for every new customer message, even when it is closed.

## Server setup (once)

1. Generate a key pair:

   ```sh
   npx web-push generate-vapid-keys
   ```

2. Add the keys to the app's environment (Dokploy → Environment) and
   redeploy:

   ```
   VAPID_PUBLIC_KEY=<public key>
   VAPID_PRIVATE_KEY=<private key>
   VAPID_SUBJECT=mailto:you@example.com
   ```

   Keep the pair. A new pair invalidates every device that already
   turned notifications on; they have to turn them on again.

3. Apply `supabase/migrations/051_push_subscriptions.sql`.

## Installing the app

| Device | How |
|---|---|
| **Android** (Chrome) | Open the CRM → ⋮ menu → **Install app** / **Add to Home screen**. |
| **iPhone / iPad** (iOS 16.4+) | Open the CRM in **Safari** → Share → **Add to Home Screen**. Push only works from the installed app, not from a Safari tab. |
| **Desktop** (Chrome / Edge) | Install icon at the right of the address bar. |

The installed app opens straight into the Inbox.

## Turning notifications on

Each person does this on each device: open **Settings → Profile →
Phone notifications**, switch it on and allow notifications when the
phone asks. **Send test notification** checks it end to end.

Every customer message then notifies every device in the account that
turned this on. Messages in the same chat replace the previous
notification instead of stacking. Tapping one opens that chat.

A device with phone notifications on no longer gets the separate
in-tab "Browser notifications" alert, so nothing arrives twice.

## Troubleshooting

- **"Push notifications aren't set up on the server"** — the VAPID
  variables are missing; see Server setup.
- **Blocked** — allow notifications for the site in the phone's settings
  (iPhone: Settings → Notifications → Chatstrik; Android: long-press the
  app icon → App info → Notifications), then switch it on again.
- **iPhone shows the install steps instead of a switch** — the page is
  open in Safari, not the installed app. Open it from the Home Screen.
- **Nothing arrives on Android** — battery saver can delay pushes; set
  the browser/app to "Unrestricted" battery use.
