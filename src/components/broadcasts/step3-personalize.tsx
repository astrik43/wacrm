'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Contact, CustomField, MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  FileText,
  ImageIcon,
  Link2,
  Loader2,
  Ticket,
  Video,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  buttonsNeedingParams,
  missingButtonParam,
  type ButtonVariables,
} from '@/hooks/use-broadcast-sending';

type VariableType = 'static' | 'field' | 'custom_field';

interface VariableMapping {
  type: VariableType;
  value: string;
}

interface Step3Props {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  onUpdate: (variables: Record<string, VariableMapping>) => void;
  /** Values for URL-button {{1}} suffixes and COPY_CODE coupon codes. */
  buttonVariables: ButtonVariables;
  onButtonVariablesChange: (buttonVariables: ButtonVariables) => void;
  /** Media URL for an IMAGE/VIDEO/DOCUMENT header, when the template has one. */
  headerMediaUrl: string;
  onHeaderMediaUrlChange: (url: string) => void;
  onNext: () => void;
  onBack: () => void;
}

const MEDIA_HEADER_TYPES = ['image', 'video', 'document'] as const;
type MediaHeaderType = (typeof MEDIA_HEADER_TYPES)[number];

function isMediaHeaderType(value: unknown): value is MediaHeaderType {
  return MEDIA_HEADER_TYPES.includes(value as MediaHeaderType);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const contactFields = [
  { value: 'name', labelKey: 'name' },
  { value: 'phone', labelKey: 'phone' },
  { value: 'email', labelKey: 'email' },
];

const SAMPLE_CONTACT: Contact = {
  id: 'sample',
  user_id: '',
  account_id: '',
  name: 'John Doe',
  phone: '+1234567890',
  email: 'john@example.com',
  company: 'Acme Corp',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export function Step3Personalize({
  template,
  variables,
  onUpdate,
  buttonVariables,
  onButtonVariablesChange,
  headerMediaUrl,
  onHeaderMediaUrlChange,
  onNext,
  onBack,
}: Step3Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [firstContact, setFirstContact] = useState<Contact | null>(null);
  const [firstContactCustomValues, setFirstContactCustomValues] = useState<
    Map<string, string>
  >(new Map());
  const [loadingPreview, setLoadingPreview] = useState(true);

  // Load user's custom fields + a representative contact for the
  // live preview. Fall back to sample data if no contacts exist yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [fieldsRes, contactRes] = await Promise.all([
        supabase.from('custom_fields').select('*').order('field_name'),
        supabase
          .from('contacts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      setCustomFields(fieldsRes.data ?? []);
      setLoadingFields(false);

      const contact = contactRes.data ?? null;
      setFirstContact(contact);

      if (contact) {
        const { data: customVals } = await supabase
          .from('contact_custom_values')
          .select('custom_field_id, value')
          .eq('contact_id', contact.id);
        if (!cancelled) {
          const map = new Map<string, string>();
          for (const row of customVals ?? []) {
            map.set(row.custom_field_id, row.value ?? '');
          }
          setFirstContactCustomValues(map);
        }
      }
      setLoadingPreview(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const placeholders = useMemo(() => {
    const matches = template.body_text.match(/\{\{(\d+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches)].sort();
  }, [template.body_text]);

  // Templates with an IMAGE/VIDEO/DOCUMENT header need a media URL at
  // send time — Meta requires the media component on every delivery and
  // rejects the broadcast without it. The field is hidden for text-only
  // headers.
  const mediaHeaderType = isMediaHeaderType(template.header_type)
    ? template.header_type
    : null;

  // Seed the field with the template's stored sample URL the first time
  // we land on a media-header template, so the common "reuse the
  // approved media" case needs no typing. Only seeds when empty to avoid
  // clobbering a URL the user already edited.
  useEffect(() => {
    if (mediaHeaderType && !headerMediaUrl && template.header_media_url) {
      onHeaderMediaUrlChange(template.header_media_url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaHeaderType, template.header_media_url]);

  // Buttons that take a value when sent: a URL button with {{1}} in its
  // link and a COPY_CODE button. Indices are the button's position in
  // the template — the index Meta expects.
  const paramButtons = useMemo(() => buttonsNeedingParams(template), [template]);

  // Seed each COPY_CODE button with the template's example code, which
  // is the code the template was approved with.
  useEffect(() => {
    const seeded: ButtonVariables = { ...buttonVariables };
    let changed = false;
    for (const index of paramButtons) {
      const button = template.buttons![index];
      if (button.type === 'COPY_CODE' && !seeded[index] && button.example) {
        seeded[index] = { type: 'static', value: button.example };
        changed = true;
      }
    }
    if (changed) onButtonVariablesChange(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramButtons]);

  const missingButton = useMemo(
    () => missingButtonParam(template, buttonVariables),
    [template, buttonVariables]
  );

  function updateButtonVariable(index: number, patch: Partial<VariableMapping>) {
    const current = buttonVariables[index] ?? { type: 'static' as VariableType, value: '' };
    onButtonVariablesChange({
      ...buttonVariables,
      [index]: { ...current, ...patch },
    });
  }

  const headerMediaError = useMemo<'missing' | 'invalid' | null>(() => {
    if (!mediaHeaderType) return null;
    const value = headerMediaUrl.trim();
    if (!value) return 'missing';
    if (!isValidHttpUrl(value)) return 'invalid';
    return null;
  }, [mediaHeaderType, headerMediaUrl]);

  /**
   * A placeholder is "unmapped" if the user hasn't picked either a
   * static value or a field/custom-field source. Blocks Next until
   * every placeholder has something — otherwise the broadcast would
   * ship with empty strings and confuse recipients.
   */
  const unmappedKeys = useMemo(() => {
    const missing: string[] = [];
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      if (!mapping || !mapping.value?.trim()) {
        missing.push(placeholder);
      }
    }
    return missing;
  }, [placeholders, variables]);

  function updateVariable(key: string, patch: Partial<VariableMapping>) {
    const current = variables[key] ?? { type: 'static' as VariableType, value: '' };
    onUpdate({
      ...variables,
      [key]: { ...current, ...patch },
    });
  }

  /** Type + value fields shared by body variables and button values. */
  function mappingEditor(
    mapping: VariableMapping,
    update: (patch: Partial<VariableMapping>) => void
  ) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            {t('personalize.type')}
          </label>
          <Select
            value={mapping.type}
            onValueChange={(val) =>
              update({
                type: val as VariableType,
                value: '',
              })
            }
          >
            <SelectTrigger className="w-full border-border bg-muted text-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-border bg-popover">
              <SelectItem value="static">{t('personalize.typeStatic')}</SelectItem>
              <SelectItem value="field">{t('personalize.typeContact')}</SelectItem>
              <SelectItem value="custom_field">
                {t('personalize.typeCustom')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            {mapping.type === 'static' ? t('personalize.staticValue') : t('personalize.contactField')}
          </label>
          {mapping.type === 'static' ? (
            <Input
              value={mapping.value}
              onChange={(e) =>
                update({ value: e.target.value })
              }
              placeholder={t('personalize.enterValue')}
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
            />
          ) : mapping.type === 'field' ? (
            <Select
              value={mapping.value || undefined}
              onValueChange={(val) =>
                update({ value: val || '' })
              }
            >
              <SelectTrigger className="w-full border-border bg-muted text-foreground">
                <SelectValue placeholder={t('personalize.selectContactField')} />
              </SelectTrigger>
              <SelectContent className="border-border bg-popover">
                {contactFields.map((field) => (
                  <SelectItem key={field.value} value={field.value}>
                    {t(`personalize.fieldMap.${field.labelKey}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Select
              value={mapping.value || undefined}
              onValueChange={(val) =>
                update({ value: val || '' })
              }
            >
              <SelectTrigger className="w-full border-border bg-muted text-foreground">
                <SelectValue
                  placeholder={
                    loadingFields
                      ? t('personalize.loadingFields')
                      : customFields.length === 0
                        ? t('personalize.noCustomFields')
                        : t('personalize.selectCustomField')
                  }
                />
              </SelectTrigger>
              <SelectContent className="border-border bg-popover">
                {customFields.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.field_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    );
  }

  /**
   * Substitute placeholders using the first real contact where
   * possible. Placeholders keyed by "{{N}}" map to variable key "N".
   */
  const previewText = useMemo(() => {
    const contact = firstContact ?? SAMPLE_CONTACT;
    const customValues = firstContact
      ? firstContactCustomValues
      : new Map<string, string>();

    let text = template.body_text;
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      let replacement = placeholder;

      if (mapping) {
        if (mapping.type === 'static' && mapping.value) {
          replacement = mapping.value;
        } else if (mapping.type === 'field' && mapping.value) {
          const fieldMap: Record<string, string | undefined> = {
            name: contact.name,
            phone: contact.phone,
            email: contact.email,
            company: contact.company,
          };
          replacement = fieldMap[mapping.value] ?? placeholder;
        } else if (mapping.type === 'custom_field' && mapping.value) {
          replacement = customValues.get(mapping.value) || placeholder;
        }
      }
      text = text.replaceAll(placeholder, replacement);
    }
    return text;
  }, [
    template.body_text,
    variables,
    placeholders,
    firstContact,
    firstContactCustomValues,
  ]);

  const previewLabel = firstContact
    ? firstContact.name || firstContact.phone
    : t('personalize.previewSample');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('personalize.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('personalize.subtitle')}
        </p>
      </div>

      {mediaHeaderType && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <div className="mb-3 flex items-center gap-2">
            {mediaHeaderType === 'video' ? (
              <Video className="h-4 w-4 text-primary" />
            ) : mediaHeaderType === 'document' ? (
              <FileText className="h-4 w-4 text-primary" />
            ) : (
              <ImageIcon className="h-4 w-4 text-primary" />
            )}
            <p className="text-sm font-medium text-foreground">
              {t(`personalize.headerMedia.${mediaHeaderType}.title`)}
            </p>
            <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium uppercase text-primary">
              {mediaHeaderType}
            </span>
          </div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            {t(`personalize.headerMedia.${mediaHeaderType}.url`)}
          </label>
          <Input
            type="url"
            value={headerMediaUrl}
            onChange={(e) => onHeaderMediaUrlChange(e.target.value)}
            placeholder={t(`personalize.headerMedia.${mediaHeaderType}.placeholder`)}
            className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t(`personalize.headerMedia.${mediaHeaderType}.desc`)}
          </p>
          {mediaHeaderType === 'image' &&
            headerMediaError === null &&
            headerMediaUrl.trim() && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={headerMediaUrl.trim()}
                alt={t('personalize.headerPreviewAlt')}
                className="mt-3 max-h-40 rounded-lg border border-border object-contain"
              />
            )}
          {mediaHeaderType === 'video' &&
            headerMediaError === null &&
            headerMediaUrl.trim() && (
              <video
                key={headerMediaUrl.trim()}
                src={headerMediaUrl.trim()}
                controls
                preload="metadata"
                className="mt-3 max-h-56 rounded-lg border border-border"
              />
            )}
          {mediaHeaderType === 'document' &&
            headerMediaError === null &&
            headerMediaUrl.trim() && (
              <a
                href={headerMediaUrl.trim()}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-xs text-primary underline"
              >
                <FileText className="h-3.5 w-3.5" />
                {t('personalize.openDocument')}
              </a>
            )}
          {headerMediaError && (
            <p className="mt-1.5 text-xs text-amber-300">
              {headerMediaError === 'missing'
                ? t('personalize.mediaUrlRequired')
                : t('personalize.mediaUrlInvalid')}
            </p>
          )}
        </div>
      )}

      {placeholders.length === 0 && !mediaHeaderType && paramButtons.length === 0 ? (
        <div className="rounded-xl border border-border bg-card/50 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {t('personalize.noPreview')}
          </p>
        </div>
      ) : placeholders.length === 0 ? null : (
        <div className="space-y-4">
          {placeholders.map((placeholder) => {
            const key = placeholder.replace(/^\{\{|\}\}$/g, '');
            const mapping = variables[key] ?? { type: 'static', value: '' };

            return (
              <div
                key={placeholder}
                className="rounded-xl border border-border bg-card/50 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-mono font-medium text-primary">
                    {placeholder}
                  </span>
                </div>

                {mappingEditor(mapping, (patch) => updateVariable(key, patch))}
              </div>
            );
          })}
        </div>
      )}

      {paramButtons.length > 0 && (
        <div className="space-y-4">
          {paramButtons.map((index) => {
            const button = template.buttons![index];
            const mapping = buttonVariables[index] ?? { type: 'static', value: '' };
            return (
              <div key={index} className="rounded-xl border border-border bg-card/50 p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  {button.type === 'URL' ? (
                    <Link2 className="h-4 w-4 text-primary" />
                  ) : (
                    <Ticket className="h-4 w-4 text-primary" />
                  )}
                  <p className="text-sm font-medium text-foreground">
                    {button.type === 'URL'
                      ? t('personalize.buttonParam', { button: button.text })
                      : t('personalize.couponCode', { button: button.text })}
                  </p>
                  {button.type === 'URL' && (
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {button.url}
                    </span>
                  )}
                </div>
                {button.type === 'URL' ? (
                  mappingEditor(mapping, (patch) => updateButtonVariable(index, patch))
                ) : (
                  <Input
                    value={mapping.value}
                    onChange={(e) => updateButtonVariable(index, { type: 'static', value: e.target.value })}
                    placeholder={button.type === 'COPY_CODE' ? button.example : undefined}
                    className="border-border bg-muted font-mono text-foreground placeholder:text-muted-foreground"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Live Preview — rendered as a WhatsApp-style bubble so the user
          sees approximately what the recipient will see. */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Eye className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium text-foreground">{t('personalize.preview')}</p>
          <span className="text-xs text-muted-foreground">({previewLabel})</span>
          {loadingPreview && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          )}
        </div>
        <div className="rounded-lg bg-[#0e1a12] p-3">
          <div className="ml-auto max-w-[85%] rounded-lg bg-primary/30 px-3 py-2 shadow-sm">
            <p className="whitespace-pre-wrap text-sm text-primary">
              {previewText}
            </p>
          </div>
        </div>
      </div>

      {missingButton && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {t('personalize.buttonParamMissing', { button: missingButton })}
        </div>
      )}

      {unmappedKeys.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {t.rich('personalize.unmappedWarning', {
            keys: unmappedKeys.join(', '),
            mono: (chunks) => <span className="font-mono font-semibold">{chunks}</span>,
          })}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={
            unmappedKeys.length > 0 || headerMediaError !== null || missingButton !== null
          }
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
