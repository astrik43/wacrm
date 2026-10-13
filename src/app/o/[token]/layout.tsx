// ============================================================
// /o/[token] layout — the public order confirmation page.
//
// Opened from a WhatsApp template button by a customer who has no
// account here, so it sits outside `(auth)` and `(dashboard)` like
// /join. The token in the path is the only credential:
//   - `no-referrer` keeps it out of the Referer header of anything
//     the page loads (the product picture comes from Shopify's CDN);
//   - never indexed.
// ============================================================

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function OrderConfirmLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-start justify-center bg-background px-4 py-8">
      {children}
    </div>
  );
}
