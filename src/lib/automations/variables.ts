// ============================================================
// {{ … }} placeholders in automation step text.
//
//   {{ message.text }}        text of the triggering message
//   {{ vars.<key> }}          workflow variables
//   {{ contact.<field> }}     the contact the automation runs for:
//                             name, first_name, phone, email, company, id
//
// Any placeholder can carry a fallback for when the value is empty:
//   "Hi {{ contact.first_name | there }}!"  →  "Hi there!" for a
//   contact without a name.
//
// Unknown placeholders render as empty (or their fallback), so a typo
// never leaks raw braces into a customer's message.
// ============================================================

/** Contact fields offered in the builder, in display order. */
export const CONTACT_VARIABLES = [
  'name',
  'first_name',
  'phone',
  'email',
  'company',
] as const;
export type ContactVariable = (typeof CONTACT_VARIABLES)[number];

export interface ContactForVariables {
  id: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
}

export interface VariableScope {
  messageText?: string;
  vars?: Record<string, unknown>;
  contact?: ContactForVariables | null;
}

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g;

/** The token the builder inserts for a contact field. */
export function contactToken(field: ContactVariable): string {
  return `{{contact.${field}}}`;
}

/** Whether rendering `s` needs the contact loaded. */
export function usesContactVariables(s: string): boolean {
  for (const m of s.matchAll(PLACEHOLDER)) {
    if (m[1].startsWith('contact.')) return true;
  }
  return false;
}

/**
 * A contact created from a number with no WhatsApp profile name is named
 * after its phone number. That's not a name to greet anyone by ("Hi
 * 919731540246!"), so it reads as empty and the fallback applies.
 */
function realName(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? '';
  return /^\+?[\d\s().-]{6,}$/.test(trimmed) ? '' : trimmed;
}

function contactValue(
  contact: ContactForVariables | null | undefined,
  field: string
): string {
  if (!contact) return '';
  switch (field) {
    case 'id':
      return contact.id;
    case 'name':
      return realName(contact.name);
    case 'first_name':
      return realName(contact.name).split(/\s+/)[0] ?? '';
    case 'phone':
      return contact.phone ? `+${contact.phone.replace(/^\+/, '')}` : '';
    case 'email':
      return contact.email?.trim() ?? '';
    case 'company':
      return contact.company?.trim() ?? '';
    default:
      return '';
  }
}

export function renderVariables(s: string, scope: VariableScope): string {
  return s.replace(PLACEHOLDER, (_, key: string, fallback?: string) => {
    const [ns, prop] = key.split('.');
    let value = '';
    if (ns === 'message' && prop === 'text') {
      value = String(scope.messageText ?? '');
    } else if (ns === 'vars' && prop) {
      value = String(scope.vars?.[prop] ?? '');
    } else if (ns === 'contact' && prop) {
      value = contactValue(scope.contact, prop);
    }
    return value.trim() ? value : (fallback ?? '').trim();
  });
}
