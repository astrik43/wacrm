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
- Order number, order total, currency
- Item summary, item count
- Order status link, or its path for a URL button
- Tracking number, courier, tracking link (shipment updates only)
- Cancel reason (order cancelled only)
- Fixed text

A field can have a fallback used when the order has no value. If a
placeholder still ends up empty, the message is **skipped** and the
Activity list says which one — WhatsApp rejects empty parameters.

**URL buttons:** WhatsApp button links have a fixed base and a variable
suffix. Create the template with your store as the base
(`https://your-store.com/{{1}}`) and map the button to *Order status
link (button suffix)*. A courier tracking link has a different base per
courier, so put it in the body instead.

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

## Limits

- **Out for delivery / Delivered** depend on Shopify receiving those
  statuses from your courier or shipping app. If the order page in
  Shopify never shows them, those messages are never sent.
- **Opt-in is your responsibility.** wacrm has no opt-out list; every
  customer with a usable phone number receives the updates you switch
  on. Collect WhatsApp consent at checkout.
- **No automatic retry.** A failed send is recorded in Activity with
  the reason and is not attempted again.
- **Contact matching** uses the same rule as the rest of wacrm (last 8
  digits), so two contacts whose numbers share those digits can be
  confused.
- One store per workspace. Past orders are not imported.
- Shopify's "Send test notification" uses sample data and, if the
  matching update is on, attempts a real send to the sample number.
