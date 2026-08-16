import { HevyHttpError } from '../errors.js';
import type { CredentialStore } from './store.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT';

export interface HevyClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

/**
 * Hevy API client.
 *
 * Auth is a static per-user API key sent as a literal `api-key` header — NOT
 * `Authorization: Bearer`. The key comes from hevy.com/settings?developer and
 * requires a Hevy Pro subscription.
 *
 * Retries are deliberately GET-only: Hevy has no idempotency mechanism, so a
 * retried POST silently creates a duplicate workout/routine. Transient
 * failures on writes are surfaced to the caller instead.
 */
export class HevyClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: HevyClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.HEVY_API_BASE_URL ?? 'https://api.hevyapp.com').replace(/\/+$/, '');
    const parsed = new URL(this.baseUrl);
    if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
      throw new Error(`Refusing non-https Hevy base URL: ${this.baseUrl}`);
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.HEVY_TIMEOUT_MS ?? 30_000);
    this.maxRetries = options.maxRetries ?? 2;
  }

  /** Validate a key by calling /v1/user/info. Used during enrollment so a bad key is rejected immediately. */
  async verifyKey(apiKey: string): Promise<{ id?: string; name?: string }> {
    const body = await this.send<{ data?: { id?: string; name?: string } }>('GET', '/v1/user/info', apiKey, {});
    return body.data ?? {};
  }

  async request<T = unknown>(
    user: string,
    store: CredentialStore,
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const credentials = store.get(user);
    if (!credentials) {
      throw new Error('NOT_CONNECTED');
    }
    return this.send<T>(method, path, credentials.apiKey, options);
  }

  private async send<T>(method: HttpMethod, path: string, apiKey: string, options: RequestOptions): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined) {
        url.searchParams.set(k, String(v));
      }
    }

    // Only reads are retried — see class doc.
    const attempts = method === 'GET' ? this.maxRetries + 1 : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), {
          method,
          headers: {
            'api-key': apiKey,
            Accept: 'application/json',
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        lastError = error;
        if (attempt < attempts - 1) {
          await delay(backoffMs(attempt));
          continue;
        }
        throw error;
      }

      if (res.ok) {
        if (res.status === 204) {
          return undefined as T;
        }
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const payload = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
      if (retryable && attempt < attempts - 1) {
        await delay(retryAfterMs(res) ?? backoffMs(attempt));
        continue;
      }
      throw new HevyHttpError({ status: res.status, url: url.toString(), payload });
    }

    throw lastError instanceof Error ? lastError : new Error('Hevy request failed');
  }
}

/** Hevy may send Retry-After as seconds or an HTTP date. */
function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.min(seconds * 1000, 30_000);
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 30_000)) : undefined;
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 4_000) + Math.floor(Math.random() * 250);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
