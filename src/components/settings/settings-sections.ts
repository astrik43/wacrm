import {
  Coins,
  FileText,
  KeyRound,
  LayoutGrid,
  Palette,
  PlugZap,
  Shield,
  ShoppingBag,
  Tags,
  User,
  UsersRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'whatsapp',
  'templates',
  'quick-replies',
  'fields',
  'deals',
  'members',
  'api',
  'shopify',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/** Rail grouping. `adminOnly` items are hidden for non-admins. */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
  /**
   * Workspace configuration (WhatsApp connection, Shopify, members,
   * keys…): hidden from agents and viewers, and a deep link to it
   * falls back to the Overview.
   */
  adminOnly?: boolean;
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'Overview', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', label: 'Your profile', icon: User, group: 'account' },
  security: { id: 'security', label: 'Login & security', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', label: 'Appearance', icon: Palette, group: 'account' },
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', icon: PlugZap, group: 'workspace', adminOnly: true },
  templates: { id: 'templates', label: 'Templates', icon: FileText, group: 'workspace', adminOnly: true },
  'quick-replies': { id: 'quick-replies', label: 'Quick replies', icon: Zap, group: 'workspace' },
  fields: { id: 'fields', label: 'Fields & tags', icon: Tags, group: 'workspace', adminOnly: true },
  deals: { id: 'deals', label: 'Deals & currency', icon: Coins, group: 'workspace', adminOnly: true },
  members: { id: 'members', label: 'Team members', icon: UsersRound, group: 'workspace', adminOnly: true },
  api: { id: 'api', label: 'API keys', icon: KeyRound, group: 'workspace', adminOnly: true },
  shopify: { id: 'shopify', label: 'Shopify', icon: ShoppingBag, group: 'workspace', adminOnly: true },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Account', group: 'account' },
  { label: 'Workspace', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section). Anything unknown falls back to the
 * Overview landing.
 */
export function resolveSection(
  raw: string | null,
  isAdmin = true
): SettingsSection {
  const section: SettingsSection =
    raw === 'tags' || raw === 'custom-fields'
      ? 'fields'
      : isSection(raw)
        ? raw
        : DEFAULT_SECTION;
  return canSeeSection(section, isAdmin) ? section : DEFAULT_SECTION;
}

/** Whether a member with (or without) admin rights may open `section`. */
export function canSeeSection(section: SettingsSection, isAdmin: boolean): boolean {
  return isAdmin || !SECTION_META[section].adminOnly;
}
