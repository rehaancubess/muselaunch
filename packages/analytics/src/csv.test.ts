import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeText, parseDateCell, parseImport, parseNumber } from "./csv";

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/analytics/${name}`, import.meta.url));
const find = (out: ReturnType<typeof parseImport>, metric: string, day: string, currency?: string) =>
  out.drafts.filter((d) => d.metric === metric && d.windowStart.startsWith(day) && (currency === undefined || d.currency === currency));

describe("CSV import parsing (fixtures)", () => {
  it("generic wide: maps headers, keeps empty cells as missing, rejects bad cells and total rows", () => {
    const out = parseImport({ bytes: fixture("generic-wide.csv"), filename: "export.csv" });
    expect(out.format).toBe("generic_wide");
    expect(out.mapping).toMatchObject({ Date: "date", Installs: "metric:installs", Trials: "metric:trials_started", "Revenue (USD)": "metric:revenue#USD", "TikTok Views": "metric:views@tiktok", Notes: "ignore" });
    expect(find(out, "installs", "2026-10-20")[0]!.value).toBe(120);
    // 2026-10-22 has no installs cell: no observation, never a zero
    expect(find(out, "installs", "2026-10-22")).toHaveLength(0);
    expect(find(out, "views", "2026-10-20")[0]).toMatchObject({ value: 3400, channel: "tiktok" });
    expect(find(out, "revenue", "2026-10-21")[0]).toMatchObject({ value: 61.3, currency: "USD" });
    expect(out.rejected.some((r) => r.reason.includes("Trials") && r.reason.includes("abc"))).toBe(true);
    expect(out.rejected.some((r) => r.reason.includes("Summary row"))).toBe(true);
    expect(out.source).toBe("csv_import");
    expect(out.drafts.every((d) => d.definition.includes("Imported CSV"))).toBe(true);
  });

  it("generic long: rejects unknown metrics and negative counts, requires currency for money", () => {
    const out = parseImport({ bytes: fixture("generic-long.csv") });
    expect(out.format).toBe("generic_long");
    expect(find(out, "views", "2026-10-21")[0]).toMatchObject({ value: 2900, channel: "tiktok" });
    expect(find(out, "ad_spend", "2026-10-21")[0]).toMatchObject({ value: 25.5, currency: "USD", channel: "instagram" });
    expect(out.rejected.map((r) => r.reason).join("|")).toMatch(/Unknown metric “happiness”/);
    expect(out.rejected.map((r) => r.reason).join("|")).toMatch(/negative count/);
  });

  it("App Store Connect summary sales: downloads, paid new subscriptions, proceeds per currency", () => {
    const out = parseImport({ bytes: fixture("app-store-sales-summary.tsv"), filename: "S_D_123.txt" });
    expect(out.format).toBe("app_store_sales");
    expect(out.source).toBe("app_store_connect");
    expect(out.timezone).toBe("America/Los_Angeles");
    // 10/20/2026 in Pacific time starts at 07:00Z
    const installs = out.drafts.find((d) => d.metric === "installs" && d.windowStart === "2026-10-20T07:00:00.000Z");
    expect(installs?.value).toBe(155); // 120 + 35, updates (7F) excluded
    const subs = out.drafts.find((d) => d.metric === "new_subscriptions" && d.windowStart === "2026-10-20T07:00:00.000Z");
    expect(subs?.value).toBe(12); // 9 USD + 3 EUR paid "New"; the free (price 0) row is not counted
    const usd = out.drafts.find((d) => d.metric === "revenue" && d.currency === "USD" && d.windowStart === "2026-10-20T07:00:00.000Z");
    expect(usd?.value).toBeCloseTo(104.7, 6); // (9 + 21) × 3.49
    const eur = out.drafts.find((d) => d.metric === "revenue" && d.currency === "EUR");
    expect(eur?.value).toBeCloseTo(11.55, 6);
    const refundDay = out.drafts.find((d) => d.metric === "revenue" && d.currency === "USD" && d.windowStart === "2026-10-21T07:00:00.000Z");
    expect(refundDay?.value).toBeCloseTo(17.45, 6); // −3.49 refund + 6 × 3.49
    expect(installs!.definition).toMatch(/first-time downloads/);
  });

  it("Play Console installs: sums Daily User Installs across the dimension", () => {
    const out = parseImport({ bytes: fixture("play-installs-country.csv") });
    expect(out.format).toBe("play_installs");
    expect(find(out, "installs", "2026-10-20")[0]).toMatchObject({ value: 70, channel: "google_play", source: "google_play_console" });
    expect(find(out, "installs", "2026-10-20")[0]!.definition).toMatch(/Daily User Installs.*Country/);
  });

  it("refuses ambiguous dates unless a date order is chosen", () => {
    const csv = Buffer.from("Date,Installs\n03/04/2026,5\n05/06/2026,7\n");
    const out = parseImport({ bytes: csv });
    expect(out.drafts).toHaveLength(0);
    expect(out.rejected[0]!.reason).toMatch(/Ambiguous date/);
    const dmy = parseImport({ bytes: csv, options: { dateFormat: "DMY" } });
    expect(dmy.drafts[0]!.windowStart).toBe("2026-04-03T00:00:00.000Z");
  });

  it("decodes UTF-16 exports and parses number formats", () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Date,Installs\n2026-10-20,9\n", "utf16le")]);
    expect(decodeText(utf16)).toContain("Installs");
    expect(parseImport({ bytes: utf16 }).drafts[0]!.value).toBe(9);
    expect(parseNumber("1,234.50")).toBe(1234.5);
    expect(parseNumber("1.234,50")).toBe(1234.5);
    expect(parseNumber("(12.5)")).toBe(-12.5);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("N/A")).toBeNull();
    expect(parseNumber("12%")).toBe("invalid");
    expect(parseDateCell("Oct 27, 2026", "auto")).toEqual({ y: 2026, m: 10, d: 27 });
  });
});
