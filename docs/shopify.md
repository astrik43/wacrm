# Shopify order updates

Send customers a WhatsApp template message when something happens to
their Shopify order. Six updates are supported:

| Update | Shopify webhook | Sent when |
| --- | --- | --- |
| Order created | Order creation | A new order is placed |
| Tracking added | Fulfillment creation / update | A shipment gets its first tracking number |
| Tracking updated | Fulfillment update | The tracking number changes to a different one |
| Out for delivery | Fulfillment update | `shipment_status` becomes `out_for_delivery` |
| Delivered | Fulfillment update | `shipment_status` becomes `delivered` |
| Order cancelled | Order cancellation | The order is cancelled |

Each update is sent at most once per order or shipment ("tracking
updated" once per new tracking number).

> **Migration required:** apply
> `supabase/migrations/043_shopify_integration.sql`.

## Setup

No Shopify app is installed. You add four webhooks by hand.

1. In wacrm, open **Settings → Shopify** (admin role).
2. In Shopify admin, open **Settings → Notifications → Webhooks**. The
   page shows a line like *"Your webhooks will be signed with …"*. Copy
   that signing secret into wacrm, optionally set a default country
   code, and choose **Connect store**.
3. wacrm now shows a **Webhook URL**. In Shopify, create four webhooks
   with format **JSON** pointing at that URL:
   - Order creation
   - Order cancellation
   - Fulfillment creation
   - Fulfillment update
4. Under **Order updates**, set up each update you want: pick a
   template Meta has **approved**, map each placeholder to an order
   detail, and switch it on.
5. Place a test order and watch **Activity**.

The webhook URL must be reachable from the internet over HTTPS
(`NEXT_PUBLIC_SITE_URL`'s host). For local development use a tunnel.

## Templates and placeholders

wacrm does not create the templates. Create them under **Settings →
Templates** (Utility category is the usual fit) and wait for approval.

Each placeholder — body `{{1}}`, `{{2}}`…, a text-header `{{1}}`, a
URL-button `{{1}}` — maps to one of:

- Customer first name / full name
- Order name (the order's `name`, e.g. `#1042`), order total, currency
- Item summary, item count
- Order URL (the order's `order_status_url`), or its path for a URL
  button
- Payment mode (`Cash on Delivery` or `Prepaid`)
- COD confirmation page link, or its suffix for a URL button
- Tracking number, courier, tracking link (shipment updates only)
- Cancel reason (order cancelled only)
- Checkout recovery link, or its path for a URL button (cart reminders
  only)
- Fixed text

A field can have a fallback used when the order has no value. If a
placeholder still ends up empty, the message is **skipped** and the
Activity list says which one — WhatsApp rejects empty parameters.

**URL buttons:** WhatsApp button links have a fixed base and a variable
suffix. Create the template with your store as the base
(`https://your-store.com/{{1}}`) and map the button to *Order status
link (button suffix)*. A courier tracking link has a different base per
courier, so put it in the body instead.

## COD and prepaid templates

An order or shipment update can use a different template depending on
how the order is paid. Open the update, set **Applies to** to *COD
orders* or *Prepaid orders*, choose its template and switch it on.

- An order is COD when one of its payment gateways is a cash-on-delivery
  gateway (Shopify's own is named "Cash on Delivery (COD)"). Every other
  order is prepaid.
- A COD order uses the COD template when that one is switched on, and
  the *All orders* template otherwise. The same goes for prepaid.
- To message only COD orders, set up the COD variant and leave *All
  orders* off.

## Delays

Every update has **Wait before sending**. `0` sends as soon as Shopify
reports the change; anything else (up to 30 days) holds the message as
**Scheduled** in Activity until its time.

- A delayed message is not sent if the order is cancelled, or the
  update is switched off, before its time. It is listed as
  **Cancelled** with the reason.
- The template and mapping are read when the message is sent, so a
  correction applies to messages already waiting.

> **Delays need a scheduler.** Nothing inside wacrm runs on a timer.
> Point an external scheduler at `GET /api/shopify/cron` **once a
> minute**, sending the shared secret in the `x-cron-secret` header
> (`AUTOMATION_CRON_SECRET`, the same one the automations and flows
> crons use). On Dokploy, add a **Schedule** to the application with the
> cron expression `* * * * *` and a command such as:
>
> ```sh
> wget -qO- --header="x-cron-secret: $AUTOMATION_CRON_SECRET" http://localhost:3000/api/shopify/cron
> ```
>
> Without it, delayed messages stay **Scheduled** forever; Settings →
> Shopify warns when scheduled messages are more than 10 minutes late.

## COD confirmation page

A template button can open a page where the customer confirms or
cancels the order.

1. Give the Shopify app the **`write_orders`** access scope (see
   *Product image in the message* for creating the app), release the
   version and approve it on the store. Settings → Shopify → Shopify app
   says whether order tagging is available.
2. Create a template with a **Visit website** button whose URL is
   `https://<your wacrm domain>/o/{{1}}`.
3. In the update (usually *Order created*, COD variant), map that button
   to **COD confirmation page (button suffix)**.

The page shows the product picture, order name, items, total and
payment mode, with two buttons:

| Button | Tag added to the Shopify order |
| --- | --- |
| Confirm order | `COD confirmed` |
| Cancel order | `cancelled by WA CRM` |

- **Cancel only tags the order.** It does not cancel it in Shopify; act
  on the tag yourself or with a Shopify Flow.
- The first answer is final. Opening the link again shows what was
  chosen.
- The link is the only thing protecting the page: anyone the customer
  forwards the message to can answer. It carries a long random token
  and is never indexed.
- If Shopify does not take the tag (for example the app lacks
  `write_orders`), the customer's answer is still stored and the tag is
  retried by the cron above for up to seven days.

## Cart reminders

Up to three reminders for a checkout that was started and not finished.

1. In Shopify, add two more webhooks to the same URL: **Checkout
   creation** and **Checkout update**.
2. Under **Cart reminders**, set up each reminder: a template, a delay
   of at least 10 minutes, and switch it on. Map a URL button to
   *Checkout recovery link (button suffix)* with your store as the
   button's base URL.

- The delay is counted from when a phone number first appears on the
  checkout.
- Reminders still waiting are cancelled when the checkout is completed
  or an order arrives from the same phone number.
- Cart reminders need the scheduler described under *Delays*.

> **Third-party checkouts.** Shopify only sends checkout webhooks for
> checkouts that happen in Shopify's own checkout. If your store uses a
> separate checkout app, carts abandoned there may never reach wacrm.
> Add the two webhooks and watch the Webhook log for `checkouts/create`
> before relying on reminders.

## Product image in the message

A template with an **image header** can show the ordered product (the
first item in the order) instead of a fixed picture. Order webhooks
don't include image links, so wacrm looks the picture up through
Shopify's Admin API. That needs a Shopify app of your own.

> **Migration required:** apply
> `supabase/migrations/044_shopify_api_credentials.sql`.

1. In the [Shopify Dev Dashboard](https://dev.shopify.com/dashboard),
   create an app.
2. On the app's version, select the **`read_products`** access scope
   and release the version.
3. Install the app on your store.
4. Copy the app's **Client ID** and **Client secret** (App settings)
   into **Settings → Shopify → Product images** and choose **Save and
   check**. wacrm asks Shopify for a token straight away, so a wrong
   secret or a missing scope is reported there.
5. Create a WhatsApp template with an **image** header (any sample
   picture) and wait for approval.
6. In the order update's settings, set **Header image** to *Product
   image (first item in the order)*.

Good to know:

- The app and the store must be in the **same Shopify organization**.
  Otherwise Shopify answers `shop_not_permitted` and this cannot work
  for that store.
- If a product has no picture, or Shopify can't be reached, the image
  saved with the template is sent instead. The message is never held
  back for a missing picture.
- The picture is looked up once, when the order arrives, and reused
  for that order's shipment updates.
- Orders with several products show the first item's picture; list the
  rest with the *Item summary* placeholder.

## Phone numbers

The number is taken from, in order: the order, the customer, the
shipping address, the billing address. For a shipment whose order was
placed before you connected, the shipment's destination phone is used.

Numbers already in international format (`+91…`, `0091…`) are used as
they are. A local-format number gets the **default country code**
prefixed. With no default country code set, local-format numbers are
skipped rather than guessed.

## How it behaves

- Every delivery is verified against your signing secret; anything else
  gets `401`.
- Shopify may deliver the same webhook twice, or out of order. A
  duplicate sends nothing, and a stale shipment update is ignored.
- Messages appear in the customer's Inbox conversation as automated
  messages. They do not count as an agent reply and do not stop a
  running Flow.
- A new customer becomes a contact, named from the order.
- **Pause** keeps accepting webhooks but sends nothing. **Disconnect**
  invalidates the webhook URL (your template mappings are kept).

> **Migration required:** apply
> `supabase/migrations/046_shopify_delay_cod_cart.sql` before deploying
> the version with delays, COD / prepaid templates and cart reminders.

## Webhook log

**Settings → Shopify → Webhook log** (admins only) lists every delivery
Shopify made to your webhook URL in the last 30 days: when it arrived,
its topic, the order, and what became of it.

| Status | Meaning |
| --- | --- |
| Processed | Handled. The Result column lists each customer update and whether it was sent, skipped (with the reason) or failed, or says why there was none (for example an out-of-date shipment update). |
| Ignored | Accepted but not acted on: the connection is paused, or it is a topic wacrm doesn't use. |
| Rejected | The signature didn't match the saved signing secret, or the body wasn't JSON. Shopify received an error and will retry. |
| Error | Processing failed; the message is shown. |
| Received | Still being processed. If it stays this way, processing was interrupted. |

**View** shows the payload Shopify sent. Payloads contain customer
names, addresses and phone numbers; they are kept for 30 days and are
not stored for rejected deliveries.

> **Migration required:** apply
> `supabase/migrations/045_shopify_webhook_events.sql`.

## Limits

- **Out for delivery / Delivered** depend on Shopify receiving those
  statuses from your courier or shipping app. If the order page in
  Shopify never shows them, those messages are never sent.
- **Opt-in is your responsibility.** wacrm has no opt-out list; every
  customer with a usable phone number receives the updates you switch
  on. Collect WhatsApp consent at checkout.
- **No automatic retry.** A failed send is recorded in Activity with
  the reason and is not attempted again.
- **Cart reminders are marketing messages.** They go to anyone who
  typed a phone number at checkout, whether or not they agreed to
  marketing.
- **Contact matching** uses the same rule as the rest of wacrm (last 8
  digits), so two contacts whose numbers share those digits can be
  confused.
- One store per workspace. Past orders are not imported.
- Shopify's "Send test notification" uses sample data and, if the
  matching update is on, attempts a real send to the sample number.
