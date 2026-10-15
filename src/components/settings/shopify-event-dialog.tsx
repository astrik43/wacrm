'use client';

// ============================================================
// ShopifyEventDialog — choose the template for one update and map
// each of its placeholders to an order detail (or fixed text).
// Validation here mirrors the server (`validateVariableMapping`), so
// Save is only offered for a mapping the API will accept.
//
// An order or shipment update can have a different template for COD
// and prepaid orders: "Applies to" switches between those variants,
// each saved separately. Any variant can also wait before sending.
//
// Each variant can send more than one message: the first one plus up
// to MAX_FOLLOW_UPS follow-ups (e.g. a feedback request 15 days after
// delivery). Every message is saved on its own, with its own delay
// counted from the update.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Search, Send, Trash2 } from 'lucide-react';
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
import {
  MAX_DELAY_MINUTES,
  MAX_FOLLOW_UPS,
  MIN_CART_DELAY_MINUTES,
  isCartEvent,
  variantsForEvent,
  type ShopifyEvent,
  type ShopifyVariant,
} from '@/lib/shopify/events';
import {
  SHOPIFY_FIELDS,
  fieldsForEvent,
  isShopifyFieldKey,
} from '@/lib/shopify/order-fields';
import {
  templateHasImageHeader,
  templateSlotIds,
  validateVariableMapping,
  type ShopifyVariableMapping,
  type VariableSource,
} from '@/lib/shopify/variable-mapping';
import type { MessageTemplate } from '@/types';

export interface ShopifyEventSetting {
  event: ShopifyEvent;
  variant: ShopifyVariant;
  /** 0 = the update's first message; 1.. = follow-ups. */
  step: number;
  /** 0 = send as soon as Shopify reports the change. */
  delay_minutes: number;
  is_enabled: boolean;
  template_name: string | null;
  template_language: string | null;
  variable_mapping: ShopifyVariableMapping;
}

const DELAY_UNITS = { minutes: 1, hours: 60, days: 1440 } as const;
/** A new follow-up starts at one day; feedback asks are usually later. */
const DEFAULT_FOLLOW_UP_DELAY = 1440;
type DelayUnit = keyof typeof DELAY_UNITS;

/** The largest unit that expresses the delay as a whole number. */
function splitDelay(minutes: number): { amount: string; unit: DelayUnit } {
  if (minutes > 0 && minutes % 1440 === 0) {
    return { amount: String(minutes / 1440), unit: 'days' };
  }
  if (minutes > 0 && minutes % 60 === 0) {
    return { amount: String(minutes / 60), unit: 'hours' };
  }
  return { amount: String(minutes), unit: 'minutes' };
}

const STATIC = '__static__';
const IMAGE_TEMPLATE = '__template__';
const IMAGE_PRODUCT = 'product_image_url';

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
  settings,
  initialVariant,
  initialStep = 0,
  testPhones = [],
  hasApiCredentials,
  onOpenChange,
  onSaved,
}: {
  /** Every variant of the update being edited. */
  settings: ShopifyEventSetting[];
  initialVariant: ShopifyVariant;
  initialStep?: number;
  /** The store's test numbers (digits only), offered for "Send test". */
  testPhones?: string[];
  /** Whether the store can look product pictures up (Shopify app set). */
  hasApiCredentials: boolean;
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
  const [variant, setVariant] = useState<ShopifyVariant>(initialVariant);
  const [step, setStep] = useState(initialStep);
  // Follow-ups added in this dialog that haven't been saved yet.
  const [drafts, setDrafts] = useState<ShopifyEventSetting[]>([]);
  const [removing, setRemoving] = useState(false);
  const [testPhone, setTestPhone] = useState(
    testPhones[0] ? `+${testPhones[0]}` : ''
  );
  const [testSource, setTestSource] = useState<'latest' | 'sample'>('latest');
  const [testing, setTesting] = useState(false);
  const [templateQuery, setTemplateQuery] = useState('');
  const [delayAmount, setDelayAmount] = useState('0');
  const [delayUnit, setDelayUnit] = useState<DelayUnit>('minutes');

  const all = useMemo(() => [...settings, ...drafts], [settings, drafts]);
  const steps = all
    .filter((s) => s.variant === variant)
    .map((s) => s.step)
    .sort((a, b) => a - b);
  const setting =
    all.find((s) => s.variant === variant && s.step === step) ?? null;
  const isDraft = drafts.some((d) => d.variant === variant && d.step === step);

  // Load the form from whichever variant is selected.
  useEffect(() => {
    if (!setting) return;
    setSelectedKey(
      setting.template_name
        ? templateKey(setting.template_name, setting.template_language)
        : ''
    );
    setMapping(setting.variable_mapping ?? { body: [] });
    setEnabled(setting.is_enabled);
    const delay = splitDelay(setting.delay_minutes ?? 0);
    setDelayAmount(delay.amount);
    setDelayUnit(delay.unit);
  }, [setting]);

  useEffect(() => {
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
  }, []);

  const template = useMemo(
    () =>
      templates.find((tpl) => templateKey(tpl.name, tpl.language) === selectedKey) ??
      null,
    [templates, selectedKey]
  );
  // Search by name, language or body text. The chosen template always
  // stays in the list so the select never shows a blank value.
  const visibleTemplates = useMemo(() => {
    const q = templateQuery.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (tpl) =>
        templateKey(tpl.name, tpl.language) === selectedKey ||
        tpl.name.toLowerCase().includes(q) ||
        (tpl.language ?? '').toLowerCase().includes(q) ||
        (tpl.body_text ?? '').toLowerCase().includes(q)
    );
  }, [templates, templateQuery, selectedKey]);
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
  const variants = variantsForEvent(event);
  const delayMinutes = Math.round(
    (Number(delayAmount) || 0) * DELAY_UNITS[delayUnit]
  );

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
    if (delayMinutes < 0 || delayMinutes > MAX_DELAY_MINUTES) {
      toast.error(t('delayTooLong'));
      return;
    }
    if (enabled && isCartEvent(event) && delayMinutes < MIN_CART_DELAY_MINUTES) {
      toast.error(t('cartDelayTooShort', { min: MIN_CART_DELAY_MINUTES }));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/shopify/events', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event,
          variant,
          step,
          delay_minutes: delayMinutes,
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

  function addFollowUp() {
    const next = Math.max(...steps) + 1;
    if (next > MAX_FOLLOW_UPS) return;
    setDrafts((prev) => [
      ...prev,
      {
        event,
        variant,
        step: next,
        delay_minutes: Math.max(DEFAULT_FOLLOW_UP_DELAY, MIN_CART_DELAY_MINUTES),
        is_enabled: true,
        template_name: null,
        template_language: null,
        variable_mapping: { body: [] },
      },
    ]);
    setStep(next);
  }

  async function removeFollowUp() {
    if (step === 0) return;
    if (isDraft) {
      setDrafts((prev) =>
        prev.filter((d) => !(d.variant === variant && d.step === step))
      );
      setStep(0);
      return;
    }
    setRemoving(true);
    try {
      const qs = new URLSearchParams({ event, variant, step: String(step) });
      const res = await fetch(`/api/shopify/events?${qs}`, { method: 'DELETE' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      toast.success(t('followUpRemoved'));
      setStep(0);
      onSaved();
    } catch (err) {
      console.error('[ShopifyEventDialog] remove error:', err);
      toast.error(t('networkError'));
    } finally {
      setRemoving(false);
    }
  }

  async function handleSendTest() {
    if (!template || problems.length > 0) {
      toast.error(t('mappingIncomplete'));
      return;
    }
    if (!testPhone.trim()) {
      toast.error(t('testPhoneRequired'));
      return;
    }
    setTesting(true);
    try {
      const res = await fetch('/api/shopify/events/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event,
          variant,
          step,
          template_name: template.name,
          template_language: template.language ?? null,
          variable_mapping: mapping,
          phone: testPhone.trim(),
          source: testSource,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(t('testSent', { phone: `+${payload.phone ?? ''}` }));
      } else {
        toast.error(
          payload.outcome?.reason
            ? t('testFailed', { reason: payload.outcome.reason })
            : payload.error || t('saveFailed')
        );
      }
      onSaved();
    } catch (err) {
      console.error('[ShopifyEventDialog] test send error:', err);
      toast.error(t('networkError'));
    } finally {
      setTesting(false);
    }
  }

  function stepLabel(n: number): string {
    return n === 0 ? t('firstMessage') : t('followUpN', { n });
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
            {variants.length > 1 && (
              <div className="space-y-1.5">
                <Label className="text-muted-foreground">{t('variantLabel')}</Label>
                <Select
                  value={variant}
                  onValueChange={(val) => {
                    const next = variants.find((v) => v === val);
                    if (next) {
                      setVariant(next);
                      setStep(0);
                    }
                  }}
                >
                  <SelectTrigger className="border-border bg-muted text-foreground w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-popover">
                    {variants.map((v) => (
                      <SelectItem key={v} value={v}>
                        {t(`variants.${v}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">{t('variantHint')}</p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t('messagesLabel')}</Label>
              <div className="flex flex-wrap gap-2">
                {steps.map((n) => (
                  <Button
                    key={n}
                    type="button"
                    size="sm"
                    variant={n === step ? 'default' : 'outline'}
                    onClick={() => setStep(n)}
                  >
                    {stepLabel(n)}
                  </Button>
                ))}
                {steps.length <= MAX_FOLLOW_UPS && (
                  <Button type="button" size="sm" variant="ghost" onClick={addFollowUp}>
                    <Plus className="size-4" />
                    {t('addFollowUp')}
                  </Button>
                )}
              </div>
              <p className="text-muted-foreground text-xs">{t('messagesHint')}</p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t('templateLabel')}</Label>
              {templates.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {t('noApprovedTemplates')}
                </p>
              ) : (
                <div className="space-y-2">
                  {templates.length > 5 && (
                    <div className="relative">
                      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                      <Input
                        id="shopify-template-search"
                        type="search"
                        value={templateQuery}
                        placeholder={t('templateSearchPlaceholder')}
                        onChange={(e) => setTemplateQuery(e.target.value)}
                        className="pl-8"
                      />
                    </div>
                  )}
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
                      {visibleTemplates.length === 0 && (
                        <p className="text-muted-foreground px-2 py-1.5 text-sm">
                          {t('templateSearchEmpty')}
                        </p>
                      )}
                      {visibleTemplates.map((tpl) => (
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
                  {templateQuery.trim() && (
                    <p className="text-muted-foreground text-xs">
                      {t('templateSearchCount', {
                        shown: visibleTemplates.length,
                        total: templates.length,
                      })}
                    </p>
                  )}
                </div>
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

            {template && templateHasImageHeader(template) && (
              <div className="space-y-1.5">
                <Label className="text-popover-foreground text-xs">
                  {t('headerImageLabel')}
                </Label>
                <Select
                  value={mapping.headerImage ? IMAGE_PRODUCT : IMAGE_TEMPLATE}
                  onValueChange={(val) =>
                    setMapping((m) => {
                      const next = { ...m };
                      if (val === IMAGE_PRODUCT) {
                        next.headerImage = { type: 'field', value: IMAGE_PRODUCT };
                      } else {
                        delete next.headerImage;
                      }
                      return next;
                    })
                  }
                >
                  <SelectTrigger className="border-border bg-muted text-foreground w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-popover">
                    <SelectItem value={IMAGE_TEMPLATE}>
                      {t('headerImageTemplate')}
                    </SelectItem>
                    <SelectItem value={IMAGE_PRODUCT}>
                      {t('headerImageProduct')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  {mapping.headerImage && !hasApiCredentials
                    ? t('headerImageNeedsApi')
                    : t('headerImageHint')}
                </p>
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

            {template && (
              <div className="border-border space-y-2 rounded-md border p-3">
                <Label className="text-muted-foreground">{t('testSendLabel')}</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    id="shopify-test-send-phone"
                    inputMode="tel"
                    list="shopify-test-phones"
                    value={testPhone}
                    placeholder="+91 98765 43210"
                    onChange={(e) => setTestPhone(e.target.value)}
                  />
                  <datalist id="shopify-test-phones">
                    {testPhones.map((p) => (
                      <option key={p} value={`+${p}`} />
                    ))}
                  </datalist>
                  <Select
                    value={testSource}
                    onValueChange={(val) => {
                      if (val === 'latest' || val === 'sample') setTestSource(val);
                    }}
                  >
                    <SelectTrigger className="border-border bg-muted text-foreground w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-border bg-popover">
                      <SelectItem value="latest">{t('testSourceLatest')}</SelectItem>
                      <SelectItem value="sample">{t('testSourceSample')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={testing || problems.length > 0}
                  onClick={handleSendTest}
                >
                  {testing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  {t('testSendButton')}
                </Button>
                <p className="text-muted-foreground text-xs">{t('testSendHint')}</p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="shopify-delay" className="text-muted-foreground">
                {t('delayLabel')}
              </Label>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  id="shopify-delay"
                  inputMode="numeric"
                  value={delayAmount}
                  onChange={(e) =>
                    setDelayAmount(e.target.value.replace(/[^\d]/g, ''))
                  }
                />
                <Select
                  value={delayUnit}
                  onValueChange={(val) => {
                    if (val === 'minutes' || val === 'hours' || val === 'days') {
                      setDelayUnit(val);
                    }
                  }}
                >
                  <SelectTrigger className="border-border bg-muted text-foreground w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-popover">
                    <SelectItem value="minutes">{t('delayUnits.minutes')}</SelectItem>
                    <SelectItem value="hours">{t('delayUnits.hours')}</SelectItem>
                    <SelectItem value="days">{t('delayUnits.days')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-muted-foreground text-xs">
                {isCartEvent(event)
                  ? t('delayHintCart', { min: MIN_CART_DELAY_MINUTES })
                  : step > 0
                    ? t('delayHintFollowUp')
                    : t('delayHint')}
              </p>
            </div>

            <div className="flex items-center justify-between gap-3">
              <Label className="text-popover-foreground">
                {step === 0 ? t('enableLabel') : t('enableFollowUpLabel')}
              </Label>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            {step > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={removing}
                onClick={removeFollowUp}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="size-4" />
                {t('removeFollowUp')}
              </Button>
            )}
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
