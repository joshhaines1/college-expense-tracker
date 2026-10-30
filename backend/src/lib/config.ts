import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.string().default('development'),
  DATA_DIR: z.string().default('./data'),
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_REFRESH_TOKEN: optionalString,
  SPREADSHEET_ID: optionalString,
  DRIVE_FOLDER_ID: optionalString,
  SHEET_NAME: z.string().default('Sheet1'),
  FIRST_DATA_ROW: z.coerce.number().int().min(2).default(8),
  MAX_UPLOAD_MB: z.coerce.number().min(1).max(50).default(15),
  OCR_TIMEOUT_MS: z.coerce.number().int().min(5000).default(60000),
  /** If set, /api requests must carry Tailscale-User-Login equal to this value (Tailscale Serve injects it). */
  ALLOWED_TAILSCALE_LOGIN: optionalString,
});

export type Config = z.infer<typeof schema>;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  spreadsheetId: string;
  driveFolderId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

/** Returns the Google settings, or the names of whichever are missing. */
export function googleConfig(cfg: Config): { ok: true; value: GoogleConfig } | { ok: false; missing: string[] } {
  const entries = {
    GOOGLE_CLIENT_ID: cfg.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: cfg.GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN: cfg.GOOGLE_REFRESH_TOKEN,
    SPREADSHEET_ID: cfg.SPREADSHEET_ID,
    DRIVE_FOLDER_ID: cfg.DRIVE_FOLDER_ID,
  };
  const missing = Object.entries(entries).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    value: {
      clientId: entries.GOOGLE_CLIENT_ID!,
      clientSecret: entries.GOOGLE_CLIENT_SECRET!,
      refreshToken: entries.GOOGLE_REFRESH_TOKEN!,
      spreadsheetId: entries.SPREADSHEET_ID!,
      driveFolderId: entries.DRIVE_FOLDER_ID!,
    },
  };
}
