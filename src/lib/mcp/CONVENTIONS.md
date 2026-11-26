# MCP 2.0 tool conventions

Read `docs/mcp-2.0-plan.md` for the product plan. This file is the contract for writing tools.

## Where things live
- `types.ts`: `defineTool`, `McpContext`, tiers.
- `errors.ts`: `McpToolError(code, message, field?)`. Throw it for expected failures.
- `executor.ts`: runs every call (scope, confirm, dry run, idempotency, audit). **Do not re-implement any of this in a handler.**
- `tools/<domain>.ts`: your tools, exported as an array. You own only the domain files you were given. Never edit `tools/index.ts`, the executor, the server or another domain's file.
- A domain that grows can become a folder (`tools/inbox/*.ts`) imported by its stub.

## Writing a tool
```ts
import { z } from 'zod';
import { defineTool } from '../types';
import { McpToolError } from '../errors';

export const tagsTools = [
  defineTool({
    name: 'add_contact_tag',                 // snake_case verb_noun, unique across the registry
    description: 'Add a tag to a contact. Fires "tag added" automations. Use list_tags first to get tag ids.',
    scope: 'tags:write',                     // the scope that exists in src/lib/api-keys/scopes.ts
    tier: 'write',                           // read | write | destructive
    input: { contact_id: z.string().uuid(), tag_id: z.string().uuid() },
    handler: async (ctx, args) => {
      // ctx.supabase is the SERVICE-ROLE client: it bypasses RLS.
      // Every query MUST filter by ctx.accountId.
      ...
      return { ok: true };
    },
  }),
];
```

## Rules
1. **Reuse `src/lib/*`** (the same functions the dashboard and v1 routes call), not copies. If the function you need only exists inside a route or a React component, move it to `src/lib` and have both call it.
2. **Scope by account.** `ctx.accountId` on every query and every id lookup (a uuid from the model is untrusted input). Check that an id belongs to the account before using it.
3. **Tier decides behaviour.**
   - `read`: never changes anything, so the scope must be a `:read` scope.
   - `write`: changes data or sends, so it needs a `:write` / `:send` scope. Honour `ctx.dryRun`: change and send nothing, and return what would happen (the exact Meta payload, the recipient count, the rows affected).
   - `destructive`: deletes, mass-sends or can't be undone. It needs the same scope as a write. The executor already refuses without `confirm: true`.
   - A registry test enforces that read tools use read scopes and the others use write scopes.
4. **Never send for real in tests.** Mock `fetch` / the Meta client and assert the payload.
5. **PII:** return ids, names and order numbers. Don't return phone numbers, emails or addresses unless the tool exists to read a contact. Never return secrets, tokens or credentials (mask them).
6. **Errors:** use the codes in `errors.ts`. Messages say what to do next ("Run sync_templates first").
7. **Pagination:** list tools take `limit` (default 25, max 100) and an opaque `cursor`, and return `{ items, next_cursor }`. See `src/lib/api/v1/pagination.ts`.
8. **Descriptions are the model's manual.** Say what it does, when to use it, what to call first, and which values are ids.
9. **Tests:** colocate a `*.test.ts` per domain. Cover scope isolation (another account's id gives `not_found`), dry run, and the main happy path.
10. **Migrations:** only if you really need one, use the number allocated to your workstream (below), make it idempotent, and add an assertion INSIDE the single DO block of `supabase/ci/verify-schema.sql`.

## Migration numbers
`054` audit log and `055` `contacts.is_staff` are already on the foundation branch (don't redo them). Your workstream's number: `056` ops/NDR/events · `057` inbox/templates · `058` broadcasts · `059` pipeline/automations/flows · `060` ai/settings · `061` commerce/reports. Only create one if you truly need it.

## Staff contacts
`contacts.is_staff` marks internal team members. Marketing paths must skip them: broadcast audiences (including "All contacts"), marketing counts and spend, abandoned-cart and order-update sends, and customer metrics (response time, open conversations). Use `.eq('is_staff', false)` (or `neq(true)`) wherever a customer list or metric is built.

## Check before you finish
`npm run typecheck && npm run lint && npm test && NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=x SUPABASE_SERVICE_ROLE_KEY=x npm run build`
Run `rm -rf .next/types .next/dev/types` before the build. The 2 pt/es i18n parity failures in `src/i18n/messages.test.ts` are expected.
