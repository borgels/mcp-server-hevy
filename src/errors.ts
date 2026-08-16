const SECRET_PATTERNS = [
  /api-key:\s*[^,\s}]+/gi,
  /(api[_-]?key|HEVY_API_KEY|HEVY_ENCRYPTION_KEY)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

export class HevyHttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(input: { status: number; url: string; payload?: unknown; fallbackMessage?: string }) {
    super(formatHevyHttpError(input));
    this.name = 'HevyHttpError';
    this.status = input.status;
    this.url = redactSecrets(input.url);
  }
}

export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? redactSecrets(error.message) : redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    value,
  );
}

function formatHevyHttpError(input: { status: number; url: string; payload?: unknown; fallbackMessage?: string }): string {
  const hint =
    input.status === 401
      ? 'Hevy rejected the API key. It may have been regenerated — reconnect with hevy_connect. Note the API requires an active Hevy Pro subscription.'
      : input.status === 429
        ? 'Hevy rate limit hit. Wait a moment and retry.'
        : undefined;
  const payloadText =
    typeof input.payload === 'string'
      ? input.payload.slice(0, 200)
      : input.payload
        ? JSON.stringify(input.payload).slice(0, 200)
        : undefined;
  return redactSecrets(
    [`Hevy API request failed with HTTP ${input.status}`, payloadText, hint, input.fallbackMessage].filter(Boolean).join(' | '),
  );
}
