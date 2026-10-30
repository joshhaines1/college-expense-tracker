/** An error whose message is safe to show to the (single) end user. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

interface GoogleLikeError {
  code?: number | string;
  status?: number;
  message?: string;
  response?: { status?: number; data?: { error?: string | { errors?: { reason?: string }[]; message?: string } } };
}

/** Translate googleapis / gaxios failures into actionable AppErrors. Never includes tokens or payloads. */
export function mapGoogleError(err: unknown, what: string): AppError {
  if (err instanceof AppError) return err;
  const e = err as GoogleLikeError;
  const status = e.response?.status ?? (typeof e.code === 'number' ? e.code : e.status);
  const data = e.response?.data?.error;
  const reason = typeof data === 'object' ? data?.errors?.[0]?.reason : undefined;
  const text = `${typeof data === 'string' ? data : ''} ${e.message ?? ''}`;

  if (/invalid_grant/i.test(text) || (status === 401 && !reason)) {
    return new AppError(
      502,
      'google_auth_expired',
      'Google authorization has expired or was revoked. Re-run the auth setup (see README, "Re-authorizing") and update GOOGLE_REFRESH_TOKEN.',
    );
  }
  if (status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'quotaExceeded') {
    return new AppError(503, 'google_quota', 'Google API rate limit reached. Wait a minute and tap Save again.', true);
  }
  if (status === 403) {
    return new AppError(502, 'google_forbidden', `Google denied access while trying to ${what}. Check sharing and API settings (see README, Troubleshooting).`);
  }
  if (status === 404) {
    return new AppError(502, 'google_not_found', `Google could not find the ${what} target. Check the spreadsheet / folder IDs in .env.`);
  }
  if (status && status >= 500) {
    return new AppError(503, 'google_unavailable', `Google was unavailable while trying to ${what}. Tap Save again in a moment.`, true);
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed/i.test(text) || /ENOTFOUND|ETIMEDOUT|ECONNRESET/.test(String(e.code))) {
    return new AppError(503, 'google_network', `The server could not reach Google while trying to ${what}. Check its internet connection and try again.`, true);
  }
  return new AppError(502, 'google_error', `Unexpected Google error while trying to ${what}.`, true);
}
