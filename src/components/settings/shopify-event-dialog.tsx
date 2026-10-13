'use client';

// ============================================================
// ShopifyEventDialog — choose the template for one order update and
// map each of its placeholders to an order detail (or fixed text).
// Validation here mirrors the server (`validateVariableMapping`), so
// Save is only offered for a mapping the API will accept.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { createClient } from '@/lib/supabase/client';
import type { ShopifyEvent } from '@/lib/shopify/events';
import {
  SHOPIFY_FIELDS,
  fieldsForEvent,
  isShopifyFieldKey,
} from '@/lib/shopify/order-fields';
import {
  templateSlotIds,
  validateVariableMapping,
  type ShopifyVariableMapping,
  type VariableSource,
} from '@/lib/shopify/variable-mapping';
import type { MessageTemplate } from '@/types';

export interface ShopifyEventSetting {
  event: ShopifyEvent;
  is_enabled: boolean;
  template_name: string | null;
  template_language: string | null;
  variable_mapping: ShopifyVariableMapping;
}

const STATIC = '__static__';

function templateKey(name: string, language?: string | null): string {
  return `${name}::${language ?? ''}`;
}

function getSource(
  mapping: ShopifyVariableMapping,
  slotId: string
): VariableSource | undefined {
  if (slotId === 'header') return mapping.headerText;
  if (slotId.startsWith('body_')) return mapping.body[Number(slotId.slice(5)) - 1];
  return mapping.buttonParams?.[slotId.slice(7)];
}

function setSource(
  mapping: ShopifyVariableMapping,
  slotId: string,
  source: VariableSource
): ShopifyVariableMapping {
  if (slotId === 'header') return { ...mapping, headerText: source };
  if (slotId.startsWith('body_')) {
    const body = mapping.body.slice();
    body[Number(slotId.slice(5)) - 1] = source;
    return { ...mapping, body };
  }
  return {
    ...mapping,
    buttonParams: { ...(mapping.buttonParams ?? {}), [slotId.slice(7)]: source },
  };
}

function sampleFor(source: VariableSource | undefined): string {
  if (!source) return '';
  if (source.type === 'static') return source.value;
  return SHOPIFY_FIELDS[source.value].sample;
}

export function ShopifyEventDialog({
  setting,
  onOpenChange,
  onSaved,
}: {
  /** The update being edited; `null` closes the dialog. */
  setting: ShopifyEventSetting | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const t = useTranslations('Settings.shopify');

  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState('');
  const [mapping, setMapping] = useState<ShopifyVariableMapping>({ body: [] });
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!setting) return;
    setSelectedKey(
      setting.template_name
        ? templateKey(setting.template_name, setting.template_language)
        : ''
    );
    setMapping(setting.variable_mapping ?? { body: [] });
    setEnabled(setting.is_enabled);

    let cancelled = false;
    (async () => {
      setLoading(true);
      // RLS scopes this to the account; only templates Meta has
      // approved can be sent.
      const { data, error } = await createClient()
        .from('message_templates')
        .select('*')
        .eq('status', 'APPROVED')
        .order('name', { ascending: true });
      if (cancelled) return;
      if (error) console.error('[ShopifyEventDialog] templates error:', error);
      setTemplates((data as MessageTemplate[] | null) ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [setting]);

  const template = useMemo(
    () =>
      templates.find((tpl) => templateKey(tpl.name, tpl.language) === selectedKey) ??
      null,
    [templates, selectedKey]
  );
  const slotIds = useMemo(
    () => (template ? templateSlotIds(template) : []),
    [template]
  );
  const problems = useMemo(
    () =>
      template && setting
        ? validateVariableMapping(template, mapping, setting.event)
        : [],
    [template, mapping, setting]
  );

  if (!setting) return null;
  const event = setting.event;
  const fieldOptions = fieldsForEvent(event);

  function slotLabel(slotId: string): string {
    if (slotId === 'header') return t('slotHeader', { val: '{{1}}' });
    if (slotId.startsWith('body_')) {
      return t('slotBody', { val: `{{${slotId.slice(5)}}}` });
    }
    const button = template?.buttons?.[Number(slotId.slice(7))];
    return t('slotButton', { name: button?.text ?? '', val: '{{1}}' });
  }

  const preview = template
    ? template.body_text.replace(/\{\{(\d+)\}\}/g, (match, raw) => {
        return sampleFor(mapping.body[Number(raw) - 1]) || match;
      })
    : '';

  async function handleSave() {
    if (enabled && !template) {
      toast.error(t('enableNeedsTemplate'));
      return;
    }
    if (template && problems.length > 0) {
      toast.error(t('mappingIncomplete'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/shopify/events', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event,
          is_enabled: enabled,
          template_name: template?.name ?? null,
          template_language: template?.language ?? null,
          variable_mapping: template ? mapping : { body: [] },
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      toast.success(t('eventSaved'));
      onSaved();
      onOpenChange(false);
    } catch (err) {
      console.error('[ShopifyEventDialog] save error:', err);
      toast.error(t('networkError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t(`events.${event}.label`)}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t(`events.${event}.desc`)}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="text-primary size-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t('templateLabel')}</Label>
              {templates.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {t('noApprovedTemplates')}
                </p>
              ) : (
                <Select
                  value={selectedKey || undefined}
                  onValueChange={(val) => {
                    setSelectedKey(val ?? '');
                    setMapping({ body: [] });
                  }}
                >
                  <SelectTrigger className="border-border bg-muted text-foreground w-full">
                    <SelectValue placeholder={t('templatePlaceholder')} />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-popover">
                    {templates.map((tpl) => (
                      <SelectItem
                        key={tpl.id}
                        value={templateKey(tpl.name, tpl.language)}
                      >
                        {tpl.name}
                        {tpl.language ? ` (${tpl.language})` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {template && slotIds.length > 0 && (
              <div className="space-y-3">
                {slotIds.map((slotId) => {
                  const source = getSource(mapping, slotId);
                  const selectValue = source
                    ? source.type === 'static'
                      ? STATIC
                      : source.value
                    : undefined;
                  return (
                    <div key={slotId} className="space-y-1.5">
                      <Label className="text-popover-foreground text-xs">
                        {slotLabel(slotId)}
                      </Label>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Select
                          value={selectValue}
                          onValueChange={(val) => {
                            if (val === STATIC) {
                              setMapping((m) =>
                                setSource(m, slotId, { type: 'static', value: '' })
                              );
                            } else if (isShopifyFieldKey(val)) {
                              setMapping((m) =>
                                setSource(m, slotId, { type: 'field', value: val })
                              );
                            }
                          }}
                        >
                          <SelectTrigger className="border-border bg-muted text-foreground w-full">
                            <SelectValue placeholder={t('sourcePlaceholder')} />
                          </SelectTrigger>
                          <SelectContent className="border-border bg-popover">
                            {fieldOptions.map((field) => (
                              <SelectItem key={field} value={field}>
                                {t(`fields.${field}`)}
                              </SelectItem>
                            ))}
                            <SelectItem value={STATIC}>{t('sourceStatic')}</SelectItem>
                          </SelectContent>
                        </Select>
                        {source?.type === 'static' && (
                          <Input
                            id={`shopify-static-${slotId}`}
                            value={source.value}
                            placeholder={t('staticPlaceholder')}
                            onChange={(e) =>
                              setMapping((m) =>
                                setSource(m, slotId, {
                                  type: 'static',
                                  value: e.target.value,
                                })
                              )
                            }
                          />
                        )}
                        {source?.type === 'field' && (
                          <Input
                            id={`shopify-fallback-${slotId}`}
                            value={source.fallback ?? ''}
                            placeholder={t('fallbackPlaceholder')}
                            onChange={(e) =>
                              setMapping((m) =>
                                setSource(m, slotId, {
                                  type: 'field',
                                  value: source.value,
                                  fallback: e.target.value,
                                })
                              )
                            }
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {template && (
              <div className="space-y-1.5">
                <Label className="text-muted-foreground">{t('preview')}</Label>
                <p className="border-border bg-muted text-foreground rounded-md border p-3 text-sm whitespace-pre-wrap">
                  {preview}
                </p>
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <Label className="text-popover-foreground">{t('enableLabel')}</Label>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving || loading}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('save')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
