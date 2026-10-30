/**
 * Heuristic extraction of the purchase date and final charged total from raw OCR text.
 *
 * These are pure functions so they can be tested without running OCR. OCR output is noisy, so the
 * result carries a coarse status ("ok" | "uncertain" | "missing") and human-readable warnings instead
 * of a numeric confidence score (which would not be calibrated). The user always confirms the values.
 */

export type FieldStatus = 'ok' | 'uncertain' | 'missing';

export interface ParsedReceipt {
  date: string | null; // YYYY-MM-DD
  total: number | null;
  dateStatus: FieldStatus;
  totalStatus: FieldStatus;
  warnings: string[];
}

// ---------------------------------------------------------------- amounts

// Accepts "47.82", "$47.82", "1,234.56", and OCR variants like "47,82" or "47. 82".
// Lookbehind/ahead keep us from matching fragments of longer digit runs (item codes, phone numbers).
const AMOUNT_RE = /(?<![\d.,])(-)?\$?\s?(\d{1,3}(?:,\d{3})+|\d+)\s?[.,]\s?(\d{2})(?!\d)(-)?/g;

interface AmountHit {
  value: number;
  negative: boolean;
}

export function findAmounts(line: string): AmountHit[] {
  const hits: AmountHit[] = [];
  for (const m of line.matchAll(AMOUNT_RE)) {
    const whole = (m[2] ?? '').replace(/,/g, '');
    const value = Number(`${whole}.${m[3]}`);
    if (Number.isFinite(value)) hits.push({ value, negative: Boolean(m[1] || m[4]) });
  }
  return hits;
}

const STRONG_TOTAL =
  /grand\s*total|amount\s*(?:paid|due|charged)|total\s*(?:due|amount|charged|payment|paid|sale)|balance\s*(?:due|paid)|order\s*total|sale\s*total|total\s*purchase/i;
const PLAIN_TOTAL = /\btotal\b|\bt[o0]tal\b/i;
const TOTAL_EXCLUDE =
  /sub\s*-?\s*total|total\s*(?:tax|savings?|saved|discounts?|items?|number|qty|points|rewards?|before|pre)|savings?|you\s*saved|change|cash\s*back|tax\s*total|before\s*tax|pre-?\s*tax|net\s*sales?|rewards?|points|coupon|items?\s*(?:sold|purchased)/i;
const TENDER = /\b(?:visa|mastercard|master\s*card|amex|american\s*express|discover|debit|credit|card|contactless|chip)\b/i;
const SUBTOTAL = /sub\s*-?\s*total/i;
const TAX_LINE = /\btax\b/i;
const REFUND = /\brefund|\breturn(?:ed)?\b|\bvoid(?:ed)?\b/i;
const NUMERIC_ONLY = /^[^A-Za-z]*$/;

interface Candidate {
  value: number;
  priority: number; // 100 strong total, 80 plain total, 40 card tender
  line: number;
}

function amountForLine(lines: string[], i: number): number | null {
  const own = findAmounts(lines[i] ?? '').filter((a) => !a.negative);
  if (own.length) return own[own.length - 1]!.value;
  // Label and value are sometimes split across two lines by OCR column handling.
  const next = lines[i + 1];
  if (next && NUMERIC_ONLY.test(next)) {
    const n = findAmounts(next).filter((a) => !a.negative);
    if (n.length) return n[0]!.value;
  }
  return null;
}

const MAX_PLAUSIBLE_TOTAL = 10_000;

export function extractTotal(text: string): { total: number | null; status: FieldStatus; warnings: string[] } {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const candidates: Candidate[] = [];
  const subtotals: number[] = [];
  const taxes: number[] = [];

  lines.forEach((line, i) => {
    if (SUBTOTAL.test(line)) {
      const v = amountForLine(lines, i);
      if (v !== null) subtotals.push(v);
      return;
    }
    if (TAX_LINE.test(line) && !PLAIN_TOTAL.test(line)) {
      const v = amountForLine(lines, i);
      if (v !== null) taxes.push(v);
    }
    const excluded = TOTAL_EXCLUDE.test(line);
    let priority = 0;
    if (!excluded && STRONG_TOTAL.test(line)) priority = 100;
    else if (!excluded && PLAIN_TOTAL.test(line)) priority = 80;
    else if (!excluded && TENDER.test(line)) priority = 40;
    if (!priority) return;
    const v = amountForLine(lines, i);
    if (v === null || v <= 0 || v >= MAX_PLAUSIBLE_TOTAL) return;
    candidates.push({ value: v, priority, line: i });
  });

  if (REFUND.test(text)) {
    warnings.push('This receipt mentions a refund, return or void. Make sure the amount is the purchase you want to record.');
  }

  if (!candidates.length) {
    warnings.push('Could not find a total on this receipt. Enter it manually.');
    return { total: null, status: 'missing', warnings };
  }

  const best = Math.max(...candidates.map((c) => c.priority));
  const top = candidates.filter((c) => c.priority === best);
  const distinct = [...new Set(top.map((c) => c.value.toFixed(2)))].map(Number);
  // The final total is the largest value among the strongest "total" lines (subtotals are already excluded).
  const total = Math.max(...distinct);
  let status: FieldStatus = 'ok';

  if (best === 40) {
    warnings.push('No "TOTAL" line was found; the amount comes from a card payment line. Please verify it.');
    status = 'uncertain';
  }
  if (distinct.length > 1) {
    warnings.push(`Several different totals were found (${distinct.map((d) => d.toFixed(2)).join(', ')}). The largest was selected; please verify.`);
    status = 'uncertain';
  }
  const sub = subtotals.length ? Math.max(...subtotals) : null;
  if (sub !== null && total < sub - 0.005) {
    warnings.push('The total is lower than the subtotal. That can be a discount, or an OCR error; please verify.');
    status = 'uncertain';
  } else if (sub !== null && taxes.length) {
    const expected = sub + taxes.reduce((a, b) => a + b, 0);
    if (Math.abs(expected - total) > 0.02 && total > sub + 0.005 && !taxes.some((t) => Math.abs(sub + t - total) <= 0.02)) {
      warnings.push('Subtotal plus tax does not match the total. Please verify the amount.');
      status = 'uncertain';
    }
  }
  return { total, status, warnings };
}

// ---------------------------------------------------------------- dates

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE_LINE_EXCLUDE = /\bexp(?:ires?|iry)?\b|\bvalid\b|\breturn\s*by\b|\bsell\s*by\b|\bbest\s*by\b|\buse\s*by\b|\bcoupon\b/i;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function fullYear(y: string): number {
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

function datesInLine(line: string): string[] {
  const out: string[] = [];
  const push = (y: number, m: number, d: number) => {
    if (isRealDate(y, m, d)) out.push(`${y}-${pad(m)}-${pad(d)}`);
  };

  for (const m of line.matchAll(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)) {
    push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  // US-style M/D/Y first (receipts are US grocery); fall back to D/M/Y when the first part cannot be a month.
  for (const m of line.matchAll(/(?<![\d/.-])(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = fullYear(m[3]!);
    if (isRealDate(y, a, b)) push(y, a, b);
    else if (isRealDate(y, b, a)) push(y, b, a);
  }
  const monthRe = MONTHS.join('|');
  for (const m of line.matchAll(new RegExp(`\\b(${monthRe})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4}|\\d{2})\\b`, 'gi'))) {
    push(fullYear(m[3]!), MONTHS.indexOf(m[1]!.toLowerCase()) + 1, Number(m[2]));
  }
  for (const m of line.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(${monthRe})[a-z]*\\.?,?\\s+(\\d{4}|\\d{2})\\b`, 'gi'))) {
    push(fullYear(m[3]!), MONTHS.indexOf(m[2]!.toLowerCase()) + 1, Number(m[1]));
  }
  return out;
}

/** `today` is injectable (YYYY-MM-DD) so tests are deterministic. */
export function extractDate(text: string, today: string = localIsoDate(new Date())): { date: string | null; status: FieldStatus; warnings: string[] } {
  const warnings: string[] = [];
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (DATE_LINE_EXCLUDE.test(line)) continue;
    for (const d of datesInLine(line)) {
      const ms = Date.parse(`${d}T00:00:00Z`);
      if (ms > todayMs + 86_400_000) continue; // future dates are not purchase dates
      if (ms < todayMs - 3 * 366 * 86_400_000) continue;
      found.push(d);
    }
  }
  if (!found.length) {
    warnings.push('Could not find a purchase date on this receipt. Enter it manually.');
    return { date: null, status: 'missing', warnings };
  }
  const date = found[0]!;
  let status: FieldStatus = 'ok';
  const distinct = new Set(found);
  if (distinct.size > 1) {
    warnings.push(`Several dates were found (${[...distinct].join(', ')}). The first was selected; please verify.`);
    status = 'uncertain';
  }
  if (Date.parse(`${date}T00:00:00Z`) < todayMs - 365 * 86_400_000) {
    warnings.push('The detected date is more than a year old. Please verify it.');
    status = 'uncertain';
  }
  return { date, status, warnings };
}

export function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseReceipt(text: string, today?: string): ParsedReceipt {
  const t = extractTotal(text);
  const d = extractDate(text, today);
  return {
    date: d.date,
    total: t.total,
    dateStatus: d.status,
    totalStatus: t.status,
    warnings: [...d.warnings, ...t.warnings],
  };
}
