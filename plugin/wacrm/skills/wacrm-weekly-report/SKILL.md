---
name: wacrm-weekly-report
description: Weekly business report from wacrm: conversations, response time, broadcasts, spend, new customers, delivered vs RTO. Use for "weekly report", "how did we do this week", "monthly summary", "WhatsApp performance".
---

# Weekly report

Staff are already left out of customer metrics. Use the same period for everything (default `days: 7`; the user may give `from` / `to`).

1. `get_dashboard_summary`: conversations opened and closed, messages per day, response time, new contacts.
2. `get_broadcast_performance`: each broadcast's sent, delivered, read, replied, failed.
3. `get_spend_report`: spend (INR estimate with GST) per category and per broadcast.
4. `get_agent_performance`: chats handled and first-response time per team member.
5. `get_top_tags` and `get_deal_value_by_stage`.
6. Delivered vs RTO this week: `list_events_since` (`types: ["tag_added"]`, `since` = start of period), count `Order Delivered` and `Order RTO`. If the volume is very large, say the counts are partial.
7. Write it in this fixed format:

```
Week <from> to <to>
Conversations: opened N, closed N | first response median X min
Broadcasts: <name>: sent N, delivered N%, read N%, replied N
Spend: ₹X (marketing ₹X, utility ₹X, service ₹X)
New customers: N | Delivered N | RTO N (N% of shipped)
Team: <name> N chats, X min
Top tags: …
Open pipeline: ₹X
Worth a look: 2-3 one-line observations (a template with low reads, slow responses, a spike in RTO)
```

The report numbers are estimates where noted (spend, truncated reads). Say so when a tool reported `truncated`.
