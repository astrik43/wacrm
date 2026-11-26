---
name: wacrm-customer-360
description: One-page summary of a customer: tags, orders, deliveries, notes, deals and recent chat. Use for "tell me about order #EL2204", "who is this customer", "customer history", "what happened with this order".
---

# Customer 360

1. Start from what the user gave you.
   - An order number or AWB: `find_by_order` (`query`). It returns the contact id, conversation id and order status without any phone number.
   - A contact id: use it directly.
   - Only a name or phone, because the user typed it: `search_contacts` (`query`).
2. `get_contact` (`contact_id`): tags, custom fields, notes, open deals, last message.
3. `list_contact_orders` (`contact_id`) and, for a specific order, `get_order` (`order_number`): fulfilment timeline, payment mode (COD or prepaid), notifications sent.
4. `list_contact_notes`, and `get_conversation_thread` for the last few messages.
5. Write the summary:
   - **Who**: first name, how long a customer, tags (`Order Delivered`, `Order RTO`, `Blocked`, `Partial pay`, `NDR: …`).
   - **Orders**: count, COD vs prepaid, delivered vs returned, the latest order and where it is.
   - **Conversation**: the last exchange and whether anything is waiting on us.
   - **Risk / value**: RTO history, deals, anything the notes say.
   - **Suggested next step**, one line.

Don't print the phone, email or address unless the user asked for contact details.
