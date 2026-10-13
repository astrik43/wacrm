// ============================================================
// /o/[token] — a customer confirms or cancels a COD order.
//
// Server-rendered from the order the token points at. Unknown token →
// 404. Once answered (or once the order is cancelled in Shopify) the
// buttons are replaced by what stands; the first answer is final.
// ============================================================

import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CheckCircle, XCircle } from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { loadCodOrder } from '@/lib/shopify/cod-confirm';
import { submitCodDecision } from './actions';
import { DecisionButtons } from './decision-buttons';

export default async function OrderConfirmPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const order = await loadCodOrder(supabaseAdmin(), token);
  if (!order) notFound();

  const t = await getTranslations('OrderConfirm');
  const { fields } = order;
  const total = [fields.order_total, fields.currency].filter(Boolean).join(' ');
  // Only ever a picture we looked up from Shopify ourselves.
  const image = fields.product_image_url?.startsWith('https://cdn.shopify.com/')
    ? fields.product_image_url
    : null;

  const rows: [string, string | undefined][] = [
    [t('items'), fields.item_summary],
    [t('total'), total || undefined],
    [t('payment'), fields.payment_mode],
  ];

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-xl">
          {order.orderName ? t('title', { order: order.orderName }) : t('titleNoNumber')}
        </CardTitle>
        {order.customerName && (
          <CardDescription>{t('greeting', { name: order.customerName })}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {image && (
          // eslint-disable-next-line @next/next/no-img-element -- remote Shopify CDN image, no optimizer config for it
          <img
            src={image}
            alt=""
            className="aspect-square w-full rounded-lg border object-cover"
          />
        )}

        <dl className="flex flex-col gap-2 text-sm">
          {rows.map(([label, value]) =>
            value ? (
              <div key={label} className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right font-medium">{value}</dd>
              </div>
            ) : null
          )}
        </dl>

        {order.decision === 'confirmed' ? (
          <p className="flex items-center gap-2 rounded-lg border p-4 text-sm font-medium">
            <CheckCircle className="size-5 shrink-0 text-primary" />
            {t('confirmed')}
          </p>
        ) : order.decision === 'cancelled' ? (
          <p className="flex items-center gap-2 rounded-lg border p-4 text-sm font-medium">
            <XCircle className="size-5 shrink-0 text-destructive" />
            {t('cancelRequested')}
          </p>
        ) : order.cancelledAt ? (
          <p className="flex items-center gap-2 rounded-lg border p-4 text-sm font-medium">
            <XCircle className="size-5 shrink-0 text-destructive" />
            {t('alreadyCancelled')}
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t('prompt')}</p>
            <DecisionButtons
              confirmAction={submitCodDecision.bind(null, token, 'confirmed')}
              cancelAction={submitCodDecision.bind(null, token, 'cancelled')}
              confirmLabel={t('confirm')}
              cancelLabel={t('cancel')}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
