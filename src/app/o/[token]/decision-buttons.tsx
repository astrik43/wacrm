'use client';

import { useFormStatus } from 'react-dom';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

function Submit({
  label,
  variant,
}: {
  label: string;
  variant: 'default' | 'outline';
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="lg"
      variant={variant}
      disabled={pending}
      className="h-12 w-full text-base"
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : label}
    </Button>
  );
}

/**
 * Two separate forms: a press submits a POST (Server Action), so a
 * link preview that merely fetches the page can never answer for the
 * customer.
 */
export function DecisionButtons({
  confirmAction,
  cancelAction,
  confirmLabel,
  cancelLabel,
}: {
  confirmAction: () => Promise<void>;
  cancelAction: () => Promise<void>;
  confirmLabel: string;
  cancelLabel: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <form action={confirmAction}>
        <Submit label={confirmLabel} variant="default" />
      </form>
      <form action={cancelAction}>
        <Submit label={cancelLabel} variant="outline" />
      </form>
    </div>
  );
}
