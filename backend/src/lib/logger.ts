/**
 * Deliberately tiny logger. Callers must only pass operational metadata (ids, status codes) —
 * never receipt text, tokens, or user-entered fields.
 */
type Meta = Record<string, string | number | boolean | undefined>;

function emit(level: string, msg: string, meta?: Meta): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta });
  (level === 'error' ? console.error : console.log)(line);
}

export const log = {
  info: (msg: string, meta?: Meta) => emit('info', msg, meta),
  warn: (msg: string, meta?: Meta) => emit('warn', msg, meta),
  error: (msg: string, meta?: Meta) => emit('error', msg, meta),
};
