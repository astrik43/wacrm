# Estelle Luxe: defaults for wacrm tasks

- Store: Estelle Luxe, estelleluxe.in (Shopify). Instagram: estelle_luxe.in.
- Customer tags added automatically:
  - `Order Placed(CoD)` / `Order Placed(Prepaid)`: on every order, never removed.
  - `Abandoned Cart`: added on an abandoned cart, removed when the customer orders.
  - `Order Delivered`: a shipment Shopify shows as delivered. "Real customers" = this tag.
  - `Order RTO`: a shipment that came back. A customer can have both.
- A broadcast to real customers selects `Order Delivered` and excludes `Order RTO`.
- NDR tags: `NDR: reattempt`, `NDR: reschedule`.
- ERP sync tags: `Order RTO`, `Blocked`, `Partial pay` (see `get_ops_settings`).
- Staff (team members, such as the person who prints shipping labels) are flagged `is_staff` and are only ever messaged with `send_document_to_staff`.
- Owner's test number: not stored here. Ask the owner once per task and use `send_broadcast_test` / `send_order_update_test` with it.
- Coupon convention: use the code already on the approved template (COPY_CODE button example); don't invent codes.
