import { describe, expect, it } from 'vitest';

import { computeReplyWindow } from './reply-window';

const now = new Date('2026-05-01T12:00:00Z');

describe('computeReplyWindow', () => {
  it('is open until 24h after the last customer message', () => {
    const w = computeReplyWindow('2026-05-01T00:00:00Z', now);
    expect(w.open).toBe(true);
    expect(w.expires_at).toBe('2026-05-02T00:00:00.000Z');
    expect(w.remaining_seconds).toBe(12 * 3600);
  });

  it('is closed after 24h and when the customer never wrote', () => {
    expect(computeReplyWindow('2026-04-30T11:59:59Z', now)).toMatchObject({ open: false, remaining_seconds: 0 });
    expect(computeReplyWindow(null, now)).toEqual({
      open: false,
      last_customer_message_at: null,
      expires_at: null,
      remaining_seconds: 0,
    });
  });
});
