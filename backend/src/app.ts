import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { AppError } from './lib/errors';
import { log } from './lib/logger';
import type { ScanResult } from './services/ocr';
import type { ExpenseInput, SaveResult } from './services/expenseService';
import { expenseInputSchema } from './services/expenseService';
import { validateImage } from './services/image';

export interface AppDeps {
  maxUploadBytes: number;
  allowedTailscaleLogin?: string;
  scanner: { scan(image: Buffer): Promise<ScanResult> };
  /** null when Google credentials are not configured yet; saves then fail with an actionable message. */
  expenses: { save(input: ExpenseInput, image: Buffer, info: Awaited<ReturnType<typeof validateImage>>): Promise<SaveResult> } | null;
  missingGoogleConfig?: string[];
}

export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'college-expenses';

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // nginx (docker network) and Tailscale Serve (loopback) are the only hops in front of us.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use(helmet());

  const api = express.Router();

  api.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Optional: pin the API to one Tailscale identity. Tailscale Serve sets this header on proxied requests.
  api.use((req: Request, _res: Response, next: NextFunction) => {
    if (deps.allowedTailscaleLogin && req.header('tailscale-user-login')?.toLowerCase() !== deps.allowedTailscaleLogin.toLowerCase()) {
      return next(new AppError(403, 'forbidden', 'This device/user is not allowed to use this app.'));
    }
    next();
  });

  api.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

  // CSRF defence: a custom header cannot be sent cross-origin without a CORS preflight, and we serve no CORS.
  api.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.header(CSRF_HEADER) !== CSRF_VALUE) {
      return next(new AppError(403, 'csrf', 'Request rejected. Reload the app and try again.'));
    }
    next();
  });

  const heavyLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
  const upload = multer({
    storage: multer.memoryStorage(), // receipts are held in memory only and never written to disk
    limits: { fileSize: deps.maxUploadBytes, files: 1, fields: 10, fieldSize: 4096, parts: 12 },
  });

  const requireFile = (req: Request): Buffer => {
    if (!req.file?.buffer?.length) throw new AppError(400, 'no_file', 'No receipt image was received. Choose or take a photo first.');
    return req.file.buffer;
  };

  api.post('/receipts/scan', heavyLimiter, upload.single('image'), async (req, res) => {
    const buf = requireFile(req);
    await validateImage(buf);
    const { date, total, dateStatus, totalStatus, warnings, rawText } = await deps.scanner.scan(buf);
    res.json({ date, total, dateStatus, totalStatus, warnings, rawText });
  });

  api.post('/expenses', heavyLimiter, upload.single('image'), async (req, res) => {
    if (!deps.expenses) {
      throw new AppError(503, 'google_not_configured', `Google is not configured on the server (missing: ${(deps.missingGoogleConfig ?? []).join(', ')}). See the README setup steps.`);
    }
    const parsed = expenseInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new AppError(400, 'invalid_input', `${first?.path.join('.') || 'input'}: ${first?.message ?? 'invalid'}`);
    }
    const buf = requireFile(req);
    const info = await validateImage(buf);
    const result = await deps.expenses.save(parsed.data, buf, info);
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  api.use((_req, _res, next) => next(new AppError(404, 'not_found', 'Not found.')));
  app.use('/api', api);

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    let appErr: AppError;
    if (err instanceof AppError) appErr = err;
    else if (err instanceof multer.MulterError) {
      appErr =
        err.code === 'LIMIT_FILE_SIZE'
          ? new AppError(413, 'file_too_large', `That photo is larger than ${Math.round(deps.maxUploadBytes / 1024 / 1024)} MB. Try a smaller photo.`)
          : new AppError(400, 'bad_upload', 'The upload was not understood. Please try again.');
    } else if (err?.type === 'entity.too.large' || err?.status === 413) appErr = new AppError(413, 'file_too_large', 'The request was too large.');
    else {
      log.error('unhandled error', { name: err instanceof Error ? err.name : 'unknown' });
      appErr = new AppError(500, 'internal', 'Something went wrong on the server. Please try again.', true);
    }
    if (appErr.status >= 500) log.warn('request failed', { code: appErr.code, status: appErr.status });
    res.status(appErr.status).json({ error: { code: appErr.code, message: appErr.message, retryable: appErr.retryable } });
  };
  app.use(errorHandler);
  return app;
}
