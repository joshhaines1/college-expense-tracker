export interface ScanResponse {
  date: string | null;
  total: number | null;
  dateStatus: 'ok' | 'uncertain' | 'missing';
  totalStatus: 'ok' | 'uncertain' | 'missing';
  warnings: string[];
  rawText: string;
}

export interface SaveResponse {
  amount: number;
  date: string;
  row: number;
  receiptUrl: string;
  duplicate: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

const HEADERS = { 'X-Requested-With': 'college-expenses' };

async function request<T>(path: string, body: FormData, timeoutMs: number): Promise<T> {
  if (!navigator.onLine) throw new ApiError("You're offline. Reconnect to the internet and try again.", 'offline', true);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, { method: 'POST', headers: HEADERS, body, signal: ctrl.signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body (e.g. proxy error page) handled below */
    }
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; retryable?: boolean } } | null)?.error;
      if (e?.message) throw new ApiError(e.message, e.code ?? 'error', Boolean(e.retryable));
      if (res.status === 413) throw new ApiError('That photo is too large to upload. Try a smaller one.', 'file_too_large', false);
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        throw new ApiError('The server is not responding. Check that the app is running on the ThinkPad, then try again.', 'server_down', true);
      }
      throw new ApiError(`Unexpected server response (${res.status}).`, 'http_error', true);
    }
    return json as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('The request timed out. Check your connection and try again.', 'timeout', true);
    }
    throw new ApiError("Can't reach the server. Make sure Tailscale is connected on your phone, then try again.", 'network', true);
  } finally {
    clearTimeout(timer);
  }
}

export function scanReceipt(image: File): Promise<ScanResponse> {
  const fd = new FormData();
  fd.append('image', image);
  return request<ScanResponse>('/api/receipts/scan', fd, 120_000);
}

export function saveExpense(args: { image: File; idempotencyKey: string; date: string; amount: string; description: string; notes: string }): Promise<SaveResponse> {
  const fd = new FormData();
  // Text fields first so the server has them before it streams the (large) file part.
  fd.append('idempotencyKey', args.idempotencyKey);
  fd.append('date', args.date);
  fd.append('amount', args.amount);
  fd.append('description', args.description);
  fd.append('notes', args.notes);
  fd.append('image', args.image);
  return request<SaveResponse>('/api/expenses', fd, 180_000);
}
