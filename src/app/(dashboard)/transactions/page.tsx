"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Loader2,
  Receipt,
} from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCan } from "@/hooks/use-can";
import type { Transaction } from "@/lib/billing/transactions";
import { cn } from "@/lib/utils";

interface Summary {
  messages: number;
  billable: number;
  by_status: Record<string, number>;
  by_category: Record<
    string,
    { count: number; billable: number; amount_inr: number }
  >;
  amount_inr: number;
  gst_inr: number;
  total_inr: number;
}

interface TransactionsResponse {
  page: number;
  page_size: number;
  total: number;
  truncated: boolean;
  summary: Summary;
  transactions: Transaction[];
}

const STATUSES = ["sent", "delivered", "read", "failed"] as const;
const CATEGORIES = [
  "marketing",
  "utility",
  "authentication",
  "service",
] as const;

const STATUS_CLASSES: Record<string, string> = {
  sent: "border-border bg-muted text-muted-foreground",
  delivered: "border-primary/40 bg-primary/10 text-primary",
  read: "border-blue-500/40 bg-blue-500/10 text-blue-500",
  failed: "border-red-500/40 bg-red-500/10 text-red-500",
};

const CATEGORY_CLASSES: Record<string, string> = {
  marketing: "border-amber-500/40 bg-amber-500/10 text-amber-600",
  utility: "border-primary/40 bg-primary/10 text-primary",
  authentication: "border-violet-500/40 bg-violet-500/10 text-violet-500",
  service: "border-border bg-muted text-muted-foreground",
};

const META_BILLING_URL = "https://business.facebook.com/billing_hub/accounts";

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function inr(amount: number, digits = 2): string {
  return `₹${amount.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground";

export default function TransactionsPage() {
  const t = useTranslations("Transactions");
  const tEvents = useTranslations("Settings.shopify.events");
  const canView = useCan("edit-settings");

  const today = new Date();
  const [from, setFrom] = useState(
    localDate(new Date(today.getFullYear(), today.getMonth(), 1)),
  );
  const [to, setTo] = useState(localDate(today));
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TransactionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback(
    (extra: Record<string, string> = {}) => {
      const params = new URLSearchParams({ from, to, ...extra });
      if (status) params.set("status", status);
      if (category) params.set("category", category);
      return params.toString();
    },
    [from, to, status, category],
  );

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch(`/api/billing/transactions?${query({ page: String(page) })}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? t("loadFailed"));
        return body as TransactionsResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canView, query, page, t]);

  // A new filter starts again from the first page.
  const onFilter = (apply: () => void) => {
    apply();
    setPage(1);
  };

  const eventLabel = (detail: string | null): string => {
    if (!detail) return "";
    const [event, step] = detail.split("#");
    const key = `${event}.label`;
    const name = tEvents.has(key) ? tEvents(key) : event;
    return step ? t("followUp", { name, step }) : name;
  };

  const sourceLabel = (row: Transaction): string => {
    switch (row.source) {
      case "shopify":
        return `${t("sources.shopify")} · ${eventLabel(row.source_detail)}`;
      case "broadcast":
        return row.source_detail
          ? `${t("sources.broadcast")} · ${row.source_detail}`
          : t("sources.broadcast");
      default:
        return t(`sources.${row.source}`);
    }
  };

  if (!canView) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card">
        <Receipt className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("adminOnly")}</p>
      </div>
    );
  }

  const summary = data?.summary;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={META_BILLING_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: "outline", size: "lg" })}
          >
            <ExternalLink className="h-4 w-4" />
            {t("metaInvoices")}
          </a>
          <a
            href={`/api/billing/transactions?${query({ format: "csv" })}`}
            aria-disabled={!data || data.total === 0}
            className={cn(
              buttonVariants({ size: "lg" }),
              (!data || data.total === 0) && "pointer-events-none opacity-50",
            )}
          >
            <Download className="h-4 w-4" />
            {t("downloadCsv")}
          </a>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("from")}
          <Input
            type="date"
            value={from}
            max={to}
            onChange={(e) => onFilter(() => setFrom(e.target.value))}
            className="h-9 w-40"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("to")}
          <Input
            type="date"
            value={to}
            min={from}
            onChange={(e) => onFilter(() => setTo(e.target.value))}
            className="h-9 w-40"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("status")}
          <select
            className={selectClass}
            value={status}
            onChange={(e) => onFilter(() => setStatus(e.target.value))}
          >
            <option value="">{t("all")}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`statuses.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("category")}
          <select
            className={selectClass}
            value={category}
            onChange={(e) => onFilter(() => setCategory(e.target.value))}
          >
            <option value="">{t("all")}</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`categories.${c}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryCard label={t("cards.messages")} value={String(summary.messages)}>
            {STATUSES.filter((s) => summary.by_status[s]).map((s) => (
              <span key={s}>
                {t(`statuses.${s}`)} {summary.by_status[s]}
              </span>
            ))}
          </SummaryCard>
          <SummaryCard label={t("cards.billable")} value={String(summary.billable)}>
            {Object.entries(summary.by_category)
              .filter(([, c]) => c.billable > 0)
              .map(([key, c]) => (
                <span key={key}>
                  {t.has(`categories.${key}`) ? t(`categories.${key}`) : key}{" "}
                  {c.billable}
                </span>
              ))}
          </SummaryCard>
          <SummaryCard label={t("cards.cost")} value={inr(summary.amount_inr)}>
            {Object.entries(summary.by_category)
              .filter(([, c]) => c.amount_inr > 0)
              .map(([key, c]) => (
                <span key={key}>
                  {t.has(`categories.${key}`) ? t(`categories.${key}`) : key}{" "}
                  {inr(c.amount_inr)}
                </span>
              ))}
          </SummaryCard>
          <SummaryCard label={t("cards.total")} value={inr(summary.total_inr)}>
            <span>{t("cards.gst", { amount: inr(summary.gst_inr) })}</span>
          </SummaryCard>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t("estimateNote")}</p>

      {error ? (
        <div className="flex h-40 items-center justify-center rounded-xl border border-border bg-card">
          <p className="text-sm text-red-500">{error}</p>
        </div>
      ) : loading && !data ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : data && data.transactions.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center rounded-xl border border-border bg-card">
          <Receipt className="mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </div>
      ) : data ? (
        <div
          className={cn(
            "overflow-x-auto rounded-xl border border-border bg-card",
            loading && "opacity-60",
          )}
        >
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t("table.sentAt")}</TableHead>
                <TableHead className="text-muted-foreground">{t("table.recipient")}</TableHead>
                <TableHead className="text-muted-foreground">{t("table.template")}</TableHead>
                <TableHead className="text-muted-foreground">{t("table.source")}</TableHead>
                <TableHead className="text-muted-foreground">{t("table.order")}</TableHead>
                <TableHead className="text-muted-foreground">{t("table.status")}</TableHead>
                <TableHead className="text-muted-foreground">{t("table.category")}</TableHead>
                <TableHead className="text-right text-muted-foreground">{t("table.amount")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.transactions.map((row) => (
                <TableRow key={row.id} className="border-border align-top">
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTime(row.sent_at ?? row.created_at)}
                  </TableCell>
                  <TableCell>
                    <div className="text-sm text-foreground">
                      {row.contact_name ?? "—"}
                    </div>
                    <div className="text-xs tabular-nums text-muted-foreground">
                      {row.phone ? `+${row.phone.replace(/^\+/, "")}` : ""}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-foreground">
                    {row.template_name ?? (
                      <span className="text-muted-foreground">
                        {t("freeForm", { type: row.content_type ?? "text" })}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {sourceLabel(row)}
                    {row.is_test && (
                      <span className="ml-1 rounded border border-border px-1 text-[10px] uppercase">
                        {t("test")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-foreground">
                    {row.order_name ?? "—"}
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium",
                        STATUS_CLASSES[row.status] ?? STATUS_CLASSES.sent,
                      )}
                      title={
                        row.error_code
                          ? `${row.error_code} ${row.error_title ?? ""}`
                          : undefined
                      }
                    >
                      {t.has(`statuses.${row.status}`)
                        ? t(`statuses.${row.status}`)
                        : row.status}
                    </span>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {row.read_at
                        ? t("readAt", { time: formatDateTime(row.read_at) })
                        : row.delivered_at
                          ? t("deliveredAt", { time: formatDateTime(row.delivered_at) })
                          : row.error_code
                            ? `${row.error_code} ${row.error_title ?? ""}`
                            : ""}
                    </div>
                  </TableCell>
                  <TableCell>
                    {row.pricing_category ? (
                      <span
                        className={cn(
                          "inline-flex rounded-full border px-2 py-0.5 text-xs",
                          CATEGORY_CLASSES[row.pricing_category] ??
                            CATEGORY_CLASSES.service,
                        )}
                      >
                        {t.has(`categories.${row.pricing_category}`)
                          ? t(`categories.${row.pricing_category}`)
                          : row.pricing_category}
                      </span>
                    ) : (
                      "—"
                    )}
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {row.pricing_type && row.pricing_type !== "regular"
                        ? t.has(`pricingTypes.${row.pricing_type}`)
                          ? t(`pricingTypes.${row.pricing_type}`)
                          : row.pricing_type
                        : ""}
                      {row.pricing_source === "estimated" && ` ${t("estimated")}`}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums text-foreground">
                    {row.amount_inr > 0 ? inr(row.amount_inr, 4) : (
                      <span className="text-muted-foreground">{t("free")}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
            <span>
              {t("pageOf", { page: data.page, pages, total: data.total })}
            </span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => p - 1)}
                aria-label={t("previous")}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={page >= pages || loading}
                onClick={() => setPage((p) => p + 1)}
                aria-label={t("next")}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
        {value}
      </p>
      <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
        {children}
      </div>
    </div>
  );
}
