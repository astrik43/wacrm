import { describe, it, expect } from "vitest";
import {
  matchesContactFilters,
  formatListTime,
  normalizeConversation,
  sortByLatestMessage,
} from "./conversations";
import type { Conversation } from "@/types";

function makeConversation(
  contact: Partial<Conversation["contact"]> | null,
): Conversation {
  return {
    id: "c1",
    user_id: "u1",
    contact_id: "ct1",
    status: "open",
    unread_count: 0,
    created_at: "",
    updated_at: "",
    contact: contact
      ? {
          id: "ct1",
          user_id: "u1",
          account_id: "a1",
          phone: "123",
          created_at: "",
          updated_at: "",
          ...contact,
        }
      : undefined,
  };
}

const tag = (id: string, name = id) => ({
  id,
  user_id: "u1",
  name,
  color: "#fff",
  created_at: "",
});

describe("matchesContactFilters", () => {
  it("matches everything when no filters are set", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(matchesContactFilters(conv, { tagIds: [], company: null })).toBe(
      true,
    );
    expect(makeConversation(null)).toBeDefined();
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: [],
        company: null,
      }),
    ).toBe(true);
  });

  it("uses OR logic across tags", () => {
    const conv = makeConversation({ tags: [tag("t1"), tag("t2")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t2", "t9"], company: null }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t9"], company: null }),
    ).toBe(false);
  });

  it("excludes conversations whose contact has no tags when a tag filter is active", () => {
    const conv = makeConversation({ tags: [] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: null }),
    ).toBe(false);
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: ["t1"],
        company: null,
      }),
    ).toBe(false);
  });

  it("matches company exactly, trimming whitespace", () => {
    const conv = makeConversation({ company: "  Acme  " });
    expect(
      matchesContactFilters(conv, { tagIds: [], company: "Acme" }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: [], company: "Other" }),
    ).toBe(false);
  });

  it("requires both tag and company to match when both are set (AND across facets)", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Acme" }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Other" }),
    ).toBe(false);
    expect(
      matchesContactFilters(conv, { tagIds: ["tX"], company: "Acme" }),
    ).toBe(false);
  });
});

describe("normalizeConversation", () => {
  it("flattens embedded contact_tags into contact.tags", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: {
        id: "ct1",
        user_id: "u1",
        account_id: "a1",
        phone: "123",
        created_at: "",
        updated_at: "",
        contact_tags: [{ tags: tag("t1", "VIP") }, { tags: null }],
      },
    };
    const normalized = normalizeConversation(raw);
    expect(normalized.contact?.tags).toEqual([tag("t1", "VIP")]);
    // The raw join key is dropped from the flattened contact.
    expect(
      (normalized.contact as unknown as Record<string, unknown>).contact_tags,
    ).toBeUndefined();
  });

  it("passes through a conversation with no contact", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: null,
    };
    // A contactless row passes through untouched (consumers use `?.`).
    expect(normalizeConversation(raw).contact).toBeNull();
  });
});

describe("sortByLatestMessage", () => {
  const conv = (id: string, last: string | null, created = "2026-10-01T00:00:00Z") => ({
    ...makeConversation(null),
    id,
    last_message_at: last ?? undefined,
    created_at: created,
  });

  it("puts the conversation with the newest message first", () => {
    const list = [
      conv("old", "2026-10-17T10:00:00Z"),
      // Got a message just now, but sat lower in the loaded list.
      conv("new", "2026-10-17T17:40:51Z"),
      conv("mid", "2026-10-17T12:00:00Z"),
    ];
    expect(sortByLatestMessage(list).map((c) => c.id)).toEqual(["new", "mid", "old"]);
    // The input is left alone.
    expect(list.map((c) => c.id)).toEqual(["old", "new", "mid"]);
  });

  it("falls back to creation time for conversations without messages", () => {
    const list = [
      conv("empty-old", null, "2026-10-01T00:00:00Z"),
      conv("msg", "2026-10-10T00:00:00Z"),
      conv("empty-new", null, "2026-10-15T00:00:00Z"),
    ];
    expect(sortByLatestMessage(list).map((c) => c.id)).toEqual([
      "empty-new",
      "msg",
      "empty-old",
    ]);
  });
});

describe("formatListTime", () => {
  const now = new Date(2026, 9, 18, 14, 10); // Sun 18 Oct 2026, 14:10 local
  const at = (d: number, h = 9, m = 5) => new Date(2026, 9, d, h, m).toISOString();
  const labels = { yesterday: "Yesterday" };

  it("shows the time for today", () => {
    expect(formatListTime(at(18, 9, 5), labels, now, "en-GB")).toBe("9:05");
  });

  it("shows Yesterday, then the weekday within a week", () => {
    expect(formatListTime(at(17, 23, 59), labels, now, "en-GB")).toBe("Yesterday");
    expect(formatListTime(at(14), labels, now, "en-GB")).toBe("Wednesday");
  });

  it("shows a short date for anything older", () => {
    expect(formatListTime(at(10), labels, now, "en-GB")).toBe("10/10/26");
  });

  it("is empty without a time", () => {
    expect(formatListTime(null, labels, now)).toBe("");
    expect(formatListTime("not a date", labels, now)).toBe("");
  });
});
