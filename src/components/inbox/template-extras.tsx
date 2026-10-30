"use client";

import { Copy, CornerDownLeft, ExternalLink, Phone } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import type {
  SentTemplateButton,
  SentTemplatePayload,
} from "@/lib/whatsapp/sent-template";

/**
 * The header picture and buttons of a sent template, under its body —
 * as the customer's phone shows them. Link buttons open the exact URL
 * the customer got (it is printed under the label too), so an agent
 * can check a tracking or COD-confirmation link actually works.
 */

// Same cap as the inbox's other inline media (message-media.tsx).
const MEDIA_MAX_W = "max-w-[min(15rem,calc(75vw-3rem))]";

function ButtonIcon({ type }: { type: SentTemplateButton["type"] }) {
  const className = "h-3.5 w-3.5 shrink-0";
  switch (type) {
    case "url":
      return <ExternalLink className={className} />;
    case "phone":
      return <Phone className={className} />;
    case "copy_code":
      return <Copy className={className} />;
    case "quick_reply":
      return <CornerDownLeft className={className} />;
  }
}

export function TemplateHeaderMedia({
  payload,
}: {
  payload: SentTemplatePayload;
}) {
  const t = useTranslations("Inbox.bubble");
  if (!payload.header_media_url) return null;
  if (payload.header_type === "image") {
    return (
      <a
        href={payload.header_media_url}
        target="_blank"
        rel="noopener noreferrer"
        className="mb-1.5 block"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={payload.header_media_url}
          alt={t("imageAlt")}
          className={cn("max-h-64 rounded-lg object-contain", MEDIA_MAX_W)}
        />
      </a>
    );
  }
  return (
    <a
      href={payload.header_media_url}
      target="_blank"
      rel="noopener noreferrer"
      className="mb-1.5 flex items-center gap-1.5 text-xs underline underline-offset-2"
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {payload.header_type === "video" ? t("video") : t("document")}
    </a>
  );
}

export function TemplateButtons({
  payload,
  isAgent,
}: {
  payload: SentTemplatePayload;
  isAgent: boolean;
}) {
  const t = useTranslations("Inbox.bubble");
  if (payload.buttons.length === 0) return null;

  const rowClass = cn(
    "flex w-full min-w-0 flex-col items-center gap-0.5 border-t px-2 py-1.5 text-center text-sm font-medium",
    isAgent ? "border-primary-foreground/25" : "border-border",
  );

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("codeCopied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  }

  return (
    <div className="-mx-1 mt-2 -mb-1">
      {payload.buttons.map((button, i) => {
        const label = (
          <span className="inline-flex max-w-full items-center gap-1.5">
            <ButtonIcon type={button.type} />
            <span className="truncate">{button.text}</span>
          </span>
        );
        const detail = button.value ? (
          <span className="max-w-full break-all text-[10px] font-normal opacity-75">
            {button.value}
          </span>
        ) : null;

        if (button.type === "url" && button.value) {
          return (
            <a
              key={i}
              href={button.value}
              target="_blank"
              rel="noopener noreferrer"
              title={button.value}
              className={cn(rowClass, "hover:opacity-80")}
            >
              {label}
              {detail}
            </a>
          );
        }
        if (button.type === "phone" && button.value) {
          return (
            <a
              key={i}
              href={`tel:${button.value}`}
              className={cn(rowClass, "hover:opacity-80")}
            >
              {label}
              {detail}
            </a>
          );
        }
        if (button.type === "copy_code" && button.value) {
          const code = button.value;
          return (
            <button
              key={i}
              type="button"
              onClick={() => copy(code)}
              className={cn(rowClass, "hover:opacity-80")}
            >
              {label}
              {detail}
            </button>
          );
        }
        return (
          <div key={i} className={rowClass}>
            {label}
          </div>
        );
      })}
    </div>
  );
}
