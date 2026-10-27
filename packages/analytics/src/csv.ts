import type { Channel, ImportFormat, ImportOptions, MetricName, MetricSource } from "@muselaunch/contracts";
import { Channel as ChannelSchema } from "@muselaunch/contracts";
import { METRIC_INFO, isMetricName } from "./metrics";
import { DAY_MS } from "./observations";

/**
 * CSV/TSV import (spec 4.11): decode, detect the export format, propose a column mapping, and
 * normalise rows into daily observation drafts. Nothing is inferred that the file doesn't say:
 * empty cells are "no value" (never zero), unknown metrics and ambiguous dates are rejected with
 * a reason, and currency amounts without a known currency are rejected.
 */

// ---------------------------------------------------------------------------
// Decoding + tokenising
// ---------------------------------------------------------------------------

export function decodeText(buf: Uint8Array): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder("utf-8").decode(buf.subarray(3));
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  // UTF-16LE without BOM (Play Console exports): many NULs at odd positions.
  const sample = buf.subarray(0, Math.min(buf.length, 400));
  let oddNul = 0;
  for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) oddNul++;
  if (sample.length > 8 && oddNul > sample.length / 4) return new TextDecoder("utf-16le").decode(buf);
  return new TextDecoder("utf-8").decode(buf);
}

export function detectDelimiter(text: string): "," | "\t" | ";" {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  const score = (d: string) => lines.reduce((n, l) => n + (l.split(d).length - 1), 0);
  const tabs = score("\t");
  const commas = score(",");
  const semis = score(";");
  if (tabs >= commas && tabs >= semis && tabs > 0) return "\t";
  if (semis > commas) return ";";
  return ",";
}

/** RFC 4180 tokeniser (quotes, escaped quotes, CRLF, quoted newlines). */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      inQuotes = true;
      cell = "";
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
}

// ---------------------------------------------------------------------------
// Header understanding
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, "");

const SYNONYMS: [MetricName, string[]][] = [
  ["installs", ["installs", "downloads", "appunits", "firsttimedownloads", "dailyuserinstalls", "newinstalls", "userinstalls", "totaldownloads"]],
  ["views", ["views", "videoviews", "plays", "reelplays", "videoplays"]],
  ["impressions", ["impressions"]],
  ["reach", ["reach", "accountsreached"]],
  ["clicks", ["clicks", "linkclicks", "taps", "websiteclicks"]],
  ["store_page_views", ["productpageviews", "storelistingvisitors", "storepageviews", "pageviews"]],
  ["trials_started", ["trials", "trialsstarted", "newtrials", "freetrials", "trialstarts"]],
  ["trial_conversions", ["trialconversions", "convertedtrials"]],
  ["new_subscriptions", ["newsubscriptions", "newsubscribers", "subscriptions", "paidsubscriptions", "newpaidsubscriptions"]],
  ["active_subscriptions", ["activesubscriptions", "activesubscribers"]],
  ["churned_subscriptions", ["churnedsubscriptions", "cancellations", "churn"]],
  ["revenue", ["revenue", "sales", "proceeds", "grossrevenue", "netrevenue", "income"]],
  ["mrr", ["mrr", "monthlyrecurringrevenue"]],
  ["ad_spend", ["adspend", "spend", "amountspent", "cost", "adcost"]],
  ["likes", ["likes", "reactions"]],
  ["comments", ["comments"]],
  ["shares", ["shares", "reposts"]],
  ["saves", ["saves", "bookmarks"]],
  ["followers_gained", ["followersgained", "newfollowers", "followers", "follows"]],
  ["profile_visits", ["profilevisits", "profileviews"]],
  ["watch_time_sec", ["watchtimeseconds", "watchtimesec", "watchtimes"]],
];

const CHANNEL_WORDS: [Channel, RegExp][] = [
  ["tiktok", /\btik ?tok\b/i],
  ["instagram", /\b(instagram|ig|reels?)\b/i],
  ["youtube", /\b(youtube|yt|shorts)\b/i],
  ["facebook", /\b(facebook|fb)\b/i],
  ["linkedin", /\blinkedin\b/i],
  ["x", /\b(twitter|x\.com)\b/i],
  ["threads", /\bthreads\b/i],
  ["reddit", /\breddit\b/i],
];

const CURRENCY_HINTS: [string, RegExp][] = [
  ["USD", /\bUSD\b|\$/],
  ["EUR", /\bEUR\b|€/],
  ["GBP", /\bGBP\b|£/],
  ["INR", /\bINR\b|₹/],
  ["JPY", /\bJPY\b|¥/],
  ["CAD", /\bCAD\b/],
  ["AUD", /\bAUD\b/],
  ["BRL", /\bBRL\b/],
];

/** Guess `metric:<name>[@channel][#CUR]` for a column header, or null. */
export function guessMetricTarget(header: string): string | null {
  let channel: Channel | undefined;
  let stripped = header;
  for (const [c, re] of CHANNEL_WORDS) {
    if (re.test(header)) {
      channel = c;
      stripped = header.replace(re, " ");
      break;
    }
  }
  const n = norm(stripped);
  if (!n) return null;
  const hit = SYNONYMS.find(([, words]) => words.includes(n));
  if (!hit) return null;
  const metric = hit[0];
  const currency = METRIC_INFO[metric].unit === "currency" ? CURRENCY_HINTS.find(([, re]) => re.test(header))?.[0] : undefined;
  return `metric:${metric}${channel ? `@${channel}` : ""}${currency ? `#${currency}` : ""}`;
}

export function parseMetricTarget(target: string): { metric: MetricName; channel?: Channel; currency?: string } | null {
  const m = /^metric:([a-z_]+)(?:@([a-z_]+))?(?:#([A-Z]{3}))?$/.exec(target);
  if (!m || !isMetricName(m[1]!)) return null;
  const ch = m[2] ? ChannelSchema.safeParse(m[2]) : undefined;
  if (m[2] && !ch?.success) return null;
  return { metric: m[1] as MetricName, channel: ch?.success ? ch.data : undefined, currency: m[3] };
}

const has = (headers: string[], name: string) => headers.some((h) => h.toLowerCase() === name.toLowerCase());
const find = (headers: string[], ...names: string[]) => headers.find((h) => names.some((n) => h.toLowerCase() === n.toLowerCase()));

/** Locate the header row (exports sometimes start with metadata lines). */
export function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i]!;
    if (r.length < 2) continue;
    if (r.some((c) => /^(date|day|begin date|start date|week|month)$/i.test(c))) return i;
  }
  return rows.findIndex((r) => r.length >= 2);
}

export function detectFormat(headers: string[]): ImportFormat {
  if (has(headers, "Product Type Identifier") && has(headers, "Units") && has(headers, "Begin Date")) return "app_store_sales";
  if (has(headers, "Package Name") && has(headers, "Date") && headers.some((h) => /installs/i.test(h))) return "play_installs";
  if (headers.some((h) => /^metric$/i.test(h)) && headers.some((h) => /^value$/i.test(h))) return "generic_long";
  return "generic_wide";
}

export function autoMapping(headers: string[], format: ImportFormat): Record<string, string> {
  const map: Record<string, string> = {};
  if (format === "app_store_sales") {
    for (const h of headers) map[h] = "ignore";
    map["Begin Date"] = "date";
    map["End Date"] = "end_date";
    map["Product Type Identifier"] = "asc:product_type";
    map["Units"] = "asc:units";
    map["Developer Proceeds"] = "asc:proceeds_per_unit";
    if (has(headers, "Currency of Proceeds")) map["Currency of Proceeds"] = "currency";
    if (has(headers, "Subscription")) map["Subscription"] = "asc:subscription";
    if (has(headers, "Customer Price")) map["Customer Price"] = "asc:customer_price";
    return map;
  }
  if (format === "play_installs") {
    for (const h of headers) map[h] = "dimension";
    map[find(headers, "Date")!] = "date";
    const pkg = find(headers, "Package Name");
    if (pkg) map[pkg] = "ignore";
    const installs = find(headers, "Daily User Installs") ?? find(headers, "Daily Device Installs") ?? find(headers, "Install events");
    for (const h of headers) if (/installs|uninstalls|upgrades|events/i.test(h) && h !== installs) map[h] = "ignore";
    if (installs) map[installs] = "metric:installs";
    return map;
  }
  for (const h of headers) {
    const lower = h.toLowerCase();
    if (/^(date|day|begin date|start date)$/.test(lower)) map[h] = "date";
    else if (/^(end date|end)$/.test(lower)) map[h] = "end_date";
    else if (format === "generic_long" && lower === "metric") map[h] = "metric";
    else if (format === "generic_long" && lower === "value") map[h] = "value";
    else if (/^(currency|currency code)$/.test(lower)) map[h] = "currency";
    else if (/^(channel|platform|network)$/.test(lower)) map[h] = "channel";
    else map[h] = (format === "generic_wide" ? guessMetricTarget(h) : null) ?? "ignore";
  }
  return map;
}

// ---------------------------------------------------------------------------
// Values and dates
// ---------------------------------------------------------------------------

/** null = empty/not reported (never coerced to 0); "invalid" = not a number. */
export function parseNumber(raw: string | undefined): number | null | "invalid" {
  if (raw === undefined) return null;
  let s = raw.trim();
  if (!s || /^(n\/?a|-|—|–|null|none|nan)$/i.test(s)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[\s$€£₹¥]/g, "").replace(/^(USD|EUR|GBP|INR|JPY|CAD|AUD|BRL)/i, "").replace(/(USD|EUR|GBP|INR|JPY|CAD|AUD|BRL)$/i, "");
  if (/%$/.test(s)) return "invalid";
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^[-+]?\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  if (!/^[-+]?(\d+(\.\d+)?|\.\d+)$/.test(s)) return "invalid";
  const n = Number(s);
  if (!Number.isFinite(n)) return "invalid";
  return neg ? -n : n;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export type DateOrder = "YMD" | "MDY" | "DMY";

type DateParts = { y: number; m: number; d: number };

/** Parse a date cell. Ambiguous numeric dates (03/04/2026) need an explicit order. */
export function parseDateCell(raw: string, order: DateOrder | "auto"): DateParts | "ambiguous" | null {
  const s = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return valid({ y: +m[1]!, m: +m[2]!, d: +m[3]! });
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    const y = +m[3]!;
    if (order === "MDY") return valid({ y, m: a, d: b });
    if (order === "DMY") return valid({ y, m: b, d: a });
    if (a > 12 && b <= 12) return valid({ y, m: b, d: a });
    if (b > 12 && a <= 12) return valid({ y, m: a, d: b });
    if (a === b) return valid({ y, m: a, d: b });
    return "ambiguous";
  }
  m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[1]!.toLowerCase());
    return mi >= 0 ? valid({ y: +m[3]!, m: mi + 1, d: +m[2]! }) : null;
  }
  m = /^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.? (\d{4})$/.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[2]!.toLowerCase());
    return mi >= 0 ? valid({ y: +m[3]!, m: mi + 1, d: +m[1]! }) : null;
  }
  return null;
}

function valid(p: DateParts): DateParts | null {
  if (p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31 || p.y < 2000 || p.y > 2100) return null;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d));
  return t.getUTCDate() === p.d ? p : null;
}

/** Infer MDY vs DMY from all numeric dates in a column. */
export function inferDateOrder(cells: string[]): DateOrder | "ambiguous" {
  let mdy = false;
  let dmy = false;
  let numeric = false;
  for (const c of cells) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(c.trim());
    if (!m) continue;
    numeric = true;
    if (+m[1]! > 12) dmy = true;
    if (+m[2]! > 12) mdy = true;
  }
  if (!numeric) return "YMD";
  if (mdy && !dmy) return "MDY";
  if (dmy && !mdy) return "DMY";
  return "ambiguous";
}

export function assertTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs;
}

/** UTC instant of local midnight for a calendar date in `tz`. */
export function zonedMidnightUtc(p: DateParts, tz: string): number {
  const guess = Date.UTC(p.y, p.m - 1, p.d);
  if (tz === "UTC") return guess;
  const off = tzOffsetMs(guess, tz);
  let t = guess - off;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off) t = guess - off2;
  return t;
}

const nextDay = (p: DateParts): DateParts => {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d) + DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

export interface ObservationDraft {
  source: MetricSource;
  metric: MetricName;
  value: number;
  currency?: string;
  channel?: Channel;
  windowStart: string;
  windowEnd: string;
  timezone: string;
  definition: string;
  rows: number[];
}

export interface ParseOutcome {
  format: ImportFormat;
  columns: string[];
  mapping: Record<string, string>;
  rowCount: number;
  acceptedRows: number;
  drafts: ObservationDraft[];
  rejected: { row: number; reason: string }[];
  rejectedTotal: number;
  warnings: string[];
  source: MetricSource;
  timezone: string;
}

const ASC_DOWNLOAD_TYPES = new Set(["1", "1F", "1T", "F1", "1E", "1EP", "1EU", "1-B", "F1-B"]);

/** Defaults per format (timezone + source); users can override timezone in options. */
export function formatDefaults(format: ImportFormat): { source: MetricSource; timezone: string; channel?: Channel; note: string } {
  switch (format) {
    case "app_store_sales":
      return { source: "app_store_connect", timezone: "America/Los_Angeles", channel: "app_store", note: "App Store Connect report days are read in Pacific Time; change the timezone if your report differs." };
    case "play_installs":
      return { source: "google_play_console", timezone: "UTC", channel: "google_play", note: "Google doesn't state the report timezone; days are read as UTC." };
    default:
      return { source: "csv_import", timezone: "UTC", note: "Dates are read as calendar days in the chosen timezone (default UTC)." };
  }
}

export function parseImport(input: { bytes: Uint8Array; filename?: string; format?: ImportFormat; mapping?: Record<string, string>; options?: ImportOptions }): ParseOutcome {
  const text = decodeText(input.bytes);
  const delimiter = detectDelimiter(text);
  const all = parseDelimited(text, delimiter);
  const headerIdx = findHeaderRow(all);
  const options = input.options ?? {};
  const rejected: { row: number; reason: string }[] = [];
  let rejectedTotal = 0;
  const reject = (row: number, reason: string) => {
    rejectedTotal++;
    if (rejected.length < 200) rejected.push({ row, reason: reason.slice(0, 300) });
  };
  if (headerIdx < 0) {
    return { format: input.format ?? "generic_wide", columns: [], mapping: {}, rowCount: 0, acceptedRows: 0, drafts: [], rejected: [{ row: 1, reason: "No header row with at least two columns was found." }], rejectedTotal: 1, warnings: [], source: "csv_import", timezone: "UTC" };
  }
  const columns = all[headerIdx]!.map((h, i) => h || `Column ${i + 1}`);
  const format = input.format ?? detectFormat(columns);
  const mapping = { ...autoMapping(columns, format), ...(input.mapping ?? {}) };
  const defaults = formatDefaults(format);
  const timezone = options.timezone ?? defaults.timezone;
  const warnings: string[] = [defaults.note];
  const source: MetricSource = format === "generic_long" || format === "generic_wide" ? (options.source ?? "csv_import") : defaults.source;
  const body = all.slice(headerIdx + 1);
  const firstRowNumber = headerIdx + 2; // 1-based line numbers as a spreadsheet shows them

  if (!assertTimezone(timezone)) {
    return { format, columns, mapping, rowCount: body.length, acceptedRows: 0, drafts: [], rejected: [{ row: headerIdx + 1, reason: `Unknown timezone "${timezone}".` }], rejectedTotal: 1, warnings, source, timezone };
  }

  const col = (target: string) => columns.findIndex((h) => mapping[h] === target);
  const dateCol = col("date");
  const endCol = col("end_date");
  if (dateCol < 0) {
    return { format, columns, mapping, rowCount: body.length, acceptedRows: 0, drafts: [], rejected: [{ row: headerIdx + 1, reason: "No date column. Map one column to “date”." }], rejectedTotal: 1, warnings, source, timezone };
  }

  let order: DateOrder | "auto" = options.dateFormat && options.dateFormat !== "auto" ? options.dateFormat : "auto";
  if (order === "auto") {
    if (format === "app_store_sales") order = "MDY";
    else {
      const inferred = inferDateOrder(body.map((r) => r[dateCol] ?? "").concat(endCol >= 0 ? body.map((r) => r[endCol] ?? "") : []));
      if (inferred === "ambiguous") warnings.push("Dates like 03/04/2026 are ambiguous in this file. Choose a date format (MDY or DMY) to import them.");
      else order = inferred;
    }
  }

  const drafts = new Map<string, ObservationDraft>();
  const accepted = new Set<number>();
  const addDraft = (d: Omit<ObservationDraft, "rows" | "timezone" | "source">, row: number, src: MetricSource = source) => {
    const key = `${src}|${d.metric}|${d.channel ?? ""}|${d.currency ?? ""}|${d.windowStart}|${d.windowEnd}`;
    const existing = drafts.get(key);
    if (existing) {
      existing.value = round(existing.value + d.value);
      existing.rows.push(row);
    } else drafts.set(key, { ...d, source: src, timezone, rows: [row] });
    accepted.add(row);
  };

  const windowFor = (r: string[], rowNo: number): { start: string; end: string } | null => {
    const raw = r[dateCol] ?? "";
    if (/^(grand )?total/i.test(raw)) {
      reject(rowNo, `Summary row skipped (“${raw.slice(0, 40)}”).`);
      return null;
    }
    const d = parseDateCell(raw, order);
    if (d === "ambiguous") {
      reject(rowNo, `Ambiguous date “${raw}”: choose MDY or DMY.`);
      return null;
    }
    if (!d) {
      reject(rowNo, `Unrecognised date “${raw.slice(0, 40)}”.`);
      return null;
    }
    let endParts = nextDay(d);
    if (endCol >= 0 && r[endCol]) {
      const e = parseDateCell(r[endCol]!, order);
      if (!e || e === "ambiguous") {
        reject(rowNo, `Unrecognised end date “${r[endCol]!.slice(0, 40)}”.`);
        return null;
      }
      endParts = nextDay(e);
    }
    const start = zonedMidnightUtc(d, timezone);
    const end = zonedMidnightUtc(endParts, timezone);
    if (end <= start) {
      reject(rowNo, "End date is before the start date.");
      return null;
    }
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  };

  const checkValue = (metric: MetricName, n: number, header: string, rowNo: number): boolean => {
    const unit = METRIC_INFO[metric].unit;
    if (unit === "count" && n < 0) {
      reject(rowNo, `${header}: negative count ${n}.`);
      return false;
    }
    if (unit === "count" && !Number.isInteger(n)) {
      reject(rowNo, `${header}: ${n} is not a whole number.`);
      return false;
    }
    return true;
  };

  const rowCurrency = (r: string[]): string | undefined => {
    const c = col("currency");
    const v = c >= 0 ? r[c]?.trim().toUpperCase() : undefined;
    return v && /^[A-Z]{3}$/.test(v) ? v : options.currency;
  };
  const rowChannel = (r: string[]): Channel | undefined => {
    const c = col("channel");
    const v = c >= 0 ? r[c]?.trim().toLowerCase() : undefined;
    if (v) {
      const parsed = ChannelSchema.safeParse(v === "twitter" ? "x" : v);
      if (parsed.success) return parsed.data;
    }
    return options.channel ?? defaults.channel;
  };
  const userNote = options.definitionNote ? ` — ${options.definitionNote}` : "";
  const fileLabel = input.filename ? ` “${input.filename.slice(0, 80)}”` : "";

  body.forEach((r, i) => {
    const rowNo = firstRowNumber + i;
    if (r.some((c) => /^(grand )?total$/i.test(c)) && !/^(grand )?total/i.test(r[dateCol] ?? "")) {
      reject(rowNo, "Summary row skipped (Total).");
      return;
    }
    const win = windowFor(r, rowNo);
    if (!win) return;

    if (format === "app_store_sales") {
      const pti = (r[col("asc:product_type")] ?? "").trim();
      const units = parseNumber(r[col("asc:units")]);
      const proceeds = parseNumber(r[col("asc:proceeds_per_unit")]);
      const currency = rowCurrency(r);
      if (typeof units !== "number" || typeof proceeds !== "number") {
        reject(rowNo, "Units or Developer Proceeds is not a number.");
        return;
      }
      let used = false;
      if (ASC_DOWNLOAD_TYPES.has(pti)) {
        addDraft({ metric: "installs", value: units, channel: "app_store", windowStart: win.start, windowEnd: win.end, definition: `App Store Connect Summary Sales Report${fileLabel}: first-time downloads (net Units for product types 1, 1F, 1T, F1, 1E*, 1-B); excludes updates and re-downloads${userNote}` }, rowNo);
        used = true;
      }
      const sub = col("asc:subscription") >= 0 ? (r[col("asc:subscription")] ?? "").trim().toLowerCase() : "";
      const price = col("asc:customer_price") >= 0 ? parseNumber(r[col("asc:customer_price")]) : null;
      if (pti === "IAY" && sub === "new" && typeof price === "number" && price > 0) {
        addDraft({ metric: "new_subscriptions", value: units, channel: "app_store", windowStart: win.start, windowEnd: win.end, definition: `App Store Connect Summary Sales Report${fileLabel}: new paid auto-renewable subscriptions (Units where Product Type IAY, Subscription = New, Customer Price > 0); Apple counts resubscriptions as renewals${userNote}` }, rowNo);
        used = true;
      }
      if (proceeds !== 0 && units !== 0) {
        if (!currency) reject(rowNo, "Currency of Proceeds missing.");
        else {
          // Refunds: Apple marks them with negative Units and/or negative prices; either way they reduce proceeds.
          const amount = (units < 0 || proceeds < 0 ? -1 : 1) * Math.abs(units) * Math.abs(proceeds);
          addDraft({ metric: "revenue", value: round(amount), currency, channel: "app_store", windowStart: win.start, windowEnd: win.end, definition: `App Store Connect Summary Sales Report${fileLabel}: developer proceeds (Units × Developer Proceeds, after Apple's commission and taxes), in currency of proceeds; refunds negative${userNote}` }, rowNo);
          used = true;
        }
      }
      if (!used) accepted.add(rowNo); // valid row with nothing to count (e.g. updates)
      return;
    }

    if (format === "generic_long") {
      const metricRaw = (r[col("metric")] ?? "").trim();
      const metricKey = metricRaw.toLowerCase().replace(/\s+/g, "_");
      const metric: MetricName | undefined = isMetricName(metricKey) ? metricKey : parseMetricTarget(guessMetricTarget(metricRaw) ?? "")?.metric;
      if (!metric) {
        reject(rowNo, `Unknown metric “${metricRaw.slice(0, 40)}”.`);
        return;
      }
      const n = parseNumber(r[col("value")]);
      if (n === null) return reject(rowNo, "No value.");
      if (n === "invalid") return reject(rowNo, `Value “${(r[col("value")] ?? "").slice(0, 30)}” is not a number.`);
      if (!checkValue(metric, n, "value", rowNo)) return;
      const currency = METRIC_INFO[metric].unit === "currency" ? rowCurrency(r) : undefined;
      if (METRIC_INFO[metric].unit === "currency" && !currency) return reject(rowNo, `${metric}: currency unknown. Add a currency column or set the import currency.`);
      addDraft({ metric, value: n, currency, channel: rowChannel(r), windowStart: win.start, windowEnd: win.end, definition: `Imported CSV${fileLabel}: “${metricRaw.slice(0, 60)}” as reported in the file${userNote}` }, rowNo);
      return;
    }

    // generic_wide and play_installs: one draft per mapped metric column
    let anyValue = false;
    columns.forEach((h, ci) => {
      const target = parseMetricTarget(mapping[h] ?? "");
      if (!target) return;
      const n = parseNumber(r[ci]);
      if (n === null) return; // empty = not reported, never 0
      if (n === "invalid") {
        reject(rowNo, `${h}: “${(r[ci] ?? "").slice(0, 30)}” is not a number.`);
        return;
      }
      if (!checkValue(target.metric, n, h, rowNo)) return;
      const currency = METRIC_INFO[target.metric].unit === "currency" ? (target.currency ?? rowCurrency(r)) : undefined;
      if (METRIC_INFO[target.metric].unit === "currency" && !currency) {
        reject(rowNo, `${h}: currency unknown. Put the currency in the header (e.g. “Revenue (USD)”) or set the import currency.`);
        return;
      }
      const definition =
        format === "play_installs"
          ? `Google Play Console installs report${fileLabel}: “${h}”${columns.some((c) => mapping[c] === "dimension") ? ` summed across ${columns.filter((c) => mapping[c] === "dimension").join(", ")}` : ""}${userNote}`
          : `Imported CSV${fileLabel}: column “${h}” as reported in the file${userNote}`;
      addDraft({ metric: target.metric, value: n, currency, channel: target.channel ?? rowChannel(r), windowStart: win.start, windowEnd: win.end, definition }, rowNo);
      anyValue = true;
    });
    if (!anyValue && !rejected.some((x) => x.row === rowNo)) reject(rowNo, "No values in mapped columns.");
  });

  if (format === "generic_wide" && !columns.some((h) => parseMetricTarget(mapping[h] ?? ""))) {
    warnings.push("No column is mapped to a metric yet. Map at least one column (for example “Installs” → installs).");
  }
  return { format, columns, mapping, rowCount: body.length, acceptedRows: accepted.size, drafts: [...drafts.values()], rejected, rejectedTotal, warnings, source, timezone };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
