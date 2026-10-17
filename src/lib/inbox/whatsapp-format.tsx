import { Fragment, type ReactNode } from "react";

// ============================================================
// WhatsApp text formatting for the inbox, as the WhatsApp apps show it:
//   *bold*   _italic_   ~strikethrough~   ```monospace```
// A marker only counts when it hugs the text (no space just inside it)
// and sits at a word boundary, so "2*3*4", "snake_case_name" or a
// lone "*" stay as typed. Builds React nodes — never HTML strings — so
// customer text can't inject markup.
// ============================================================

const MARKERS: Record<string, "strong" | "em" | "del"> = {
  "*": "strong",
  _: "em",
  "~": "del",
};

const WORD = /[\p{L}\p{N}]/u;

function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || !WORD.test(ch);
}

/** Index of the marker that closes one opened at `start`, or -1. */
function findClose(text: string, marker: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\n") return -1;
    if (
      text[i] === marker &&
      i > start + 1 &&
      !/\s/.test(text[i - 1]) &&
      isBoundary(text[i + 1])
    ) {
      return i;
    }
  }
  return -1;
}

function formatInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = "";
  let i = 0;
  const flush = () => {
    if (plain) {
      out.push(plain);
      plain = "";
    }
  };
  while (i < text.length) {
    const ch = text[i];
    const tag = MARKERS[ch];
    if (
      tag &&
      isBoundary(text[i - 1]) &&
      text[i + 1] !== undefined &&
      !/\s/.test(text[i + 1])
    ) {
      const close = findClose(text, ch, i);
      if (close !== -1) {
        flush();
        const Tag = tag;
        out.push(
          <Tag key={`${keyPrefix}-${i}`}>
            {formatInline(text.slice(i + 1, close), `${keyPrefix}-${i}`)}
          </Tag>,
        );
        i = close + 1;
        continue;
      }
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

/** WhatsApp-formatted text as React nodes (line breaks kept by the caller's whitespace-pre-wrap). */
export function formatWhatsAppText(text: string | null | undefined): ReactNode {
  if (!text) return text ?? null;
  const parts = text.split("```");
  // An unmatched ``` leaves the last part outside any block.
  return parts.map((part, idx) => {
    const isCode = idx % 2 === 1 && idx < parts.length - 1;
    if (isCode) {
      return (
        <code key={`c-${idx}`} className="rounded bg-black/10 px-1 font-mono text-[0.92em]">
          {part}
        </code>
      );
    }
    const raw = idx % 2 === 1 ? "```" + part : part;
    return <Fragment key={`t-${idx}`}>{formatInline(raw, `t-${idx}`)}</Fragment>;
  });
}

const INLINE_MARK = /(^|[^\p{L}\p{N}])([*_~])(?!\s)([^\n]*?\S)\2(?=[^\p{L}\p{N}]|$)/gu;

/** The same text without formatting marks, for one-line previews. */
export function stripWhatsAppFormatting(text: string | null | undefined): string {
  if (!text) return "";
  let out = text.replace(/```/g, "");
  // Nested marks (*_bold italic_*) unwrap one layer per pass.
  for (let pass = 0; pass < 3; pass++) {
    const next = out.replace(INLINE_MARK, "$1$3");
    if (next === out) break;
    out = next;
  }
  return out;
}
