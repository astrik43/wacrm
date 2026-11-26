'use client';

import { useEffect, useState } from 'react';
import { FlaskConical, Loader2, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  sendTestMessage,
  type ButtonVariables,
  type VariableMapping,
} from '@/hooks/use-broadcast-sending';
import type { MessageTemplate } from '@/types';

/** The last number a test went to, remembered on this device. */
const TEST_PHONE_KEY = 'broadcast-test-phone';

interface SendTestDialogProps {
  /** Null while the template is loading or when it no longer exists. */
  template: MessageTemplate | null;
  variables: Record<string, VariableMapping>;
  buttonVariables: ButtonVariables;
  headerMediaUrl: string;
  disabled?: boolean;
  /** Tooltip on the button, e.g. why it is disabled. */
  title?: string;
  size?: 'default' | 'sm';
}

/**
 * "Send test" button + dialog: sends a broadcast's message to one
 * number right away (see sendTestMessage). Used in the wizard's review
 * step and on a saved draft's or sent broadcast's page.
 */
export function SendTestDialog({
  template,
  variables,
  buttonVariables,
  headerMediaUrl,
  disabled,
  title,
  size = 'default',
}: SendTestDialogProps) {
  const t = useTranslations('Broadcasts.wizard');
  const [showTest, setShowTest] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testSending, setTestSending] = useState(false);

  useEffect(() => {
    try {
      setTestPhone(localStorage.getItem(TEST_PHONE_KEY) ?? '');
    } catch {
      // Storage unavailable — the field just starts empty.
    }
  }, []);

  async function handleSendTest() {
    const phone = testPhone.trim();
    if (!phone || !template) return;
    setTestSending(true);
    try {
      const result = await sendTestMessage({
        template,
        variables,
        buttonVariables,
        headerMediaUrl,
        phone,
      });
      if (!result.ok) {
        toast.error(t('scheduleSend.testFailed', { error: result.error }));
        return;
      }
      try {
        localStorage.setItem(TEST_PHONE_KEY, phone);
      } catch {
        // Not remembering the number is fine.
      }
      toast.success(
        result.contactFound
          ? t('scheduleSend.testSent', { phone })
          : t('scheduleSend.testSentNoContact', { phone })
      );
      setShowTest(false);
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      toast.error(t('scheduleSend.testFailed', { error }));
    } finally {
      setTestSending(false);
    }
  }

  return (
    <Dialog open={showTest} onOpenChange={setShowTest}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            title={title}
            size={size}
            disabled={disabled || !template}
            className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
          />
        }
      >
        <FlaskConical className="h-4 w-4" />
        {t('scheduleSend.sendTest')}
      </DialogTrigger>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('scheduleSend.testTitle')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('scheduleSend.testDesc')}
          </DialogDescription>
        </DialogHeader>
        <Input
          value={testPhone}
          onChange={(e) => setTestPhone(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSendTest();
          }}
          placeholder={t('scheduleSend.testPhonePlaceholder')}
          inputMode="tel"
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setShowTest(false)}
            className="border-border text-muted-foreground"
          >
            {t('cancel')}
          </Button>
          <Button
            onClick={() => void handleSendTest()}
            disabled={!testPhone.trim() || testSending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {testSending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {t('scheduleSend.testSend')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
