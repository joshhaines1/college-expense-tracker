export interface FormValues {
  date: string;
  amount: string;
  description: string;
  notes: string;
}

export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** "$1,234.5" -> "1234.50"; returns null if not a valid positive money amount with at most 2 decimals. */
export function normalizeAmount(input: string): string | null {
  const s = input.replace(/[$,\s]/g, '');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n.toFixed(2) : null;
}

export function validate(v: FormValues, today: string = localToday()): { date?: string; amount?: string } {
  const errors: { date?: string; amount?: string } = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) errors.date = 'Enter the purchase date.';
  else if (v.date > today) errors.date = 'The date cannot be in the future.';
  else if (v.date < '2000-01-01') errors.date = 'That date looks wrong.';
  if (!normalizeAmount(v.amount)) errors.amount = 'Enter the amount paid, e.g. 47.82.';
  return errors;
}

export function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
