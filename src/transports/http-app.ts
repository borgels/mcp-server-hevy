import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createMcpServer } from '../server.js';
import type { HevyClient } from '../hevy/client.js';
import type { CredentialStore } from '../hevy/store.js';
import {
  assertAllowedHost,
  assertAllowedOrigin,
  assertAuthorized,
  AuthFailureLimiter,
  corsHeaders,
  DEFAULT_AUTH_FAILURE_LIMIT,
  DEFAULT_AUTH_FAILURE_WINDOW_MS,
  escapeHtml,
  type HttpConfig,
  HttpRequestError,
  readJsonBody,
  sendJson,
} from './http-helpers.js';

export interface HttpAppDeps {
  config: HttpConfig;
  store: CredentialStore;
  client: HevyClient;
  /** Public origin of the enrollment page; an https origin marks the cookie Secure. */
  publicBaseUrl?: string;
  /** Defaults to console.error. */
  log?: (line: string) => void;
}

/** Cookie binding the browser that confirmed the identity to the API-key submission. */
export const ENROLL_COOKIE = 'hevy_enroll';
const ENROLL_COOKIE_MAX_AGE_S = 10 * 60;

export function createHttpHandler(deps: HttpAppDeps): RequestListener {
  const { config, store, client } = deps;
  const log = deps.log ?? ((line: string) => console.error(line));
  const failureLimit = config.authFailureLimit ?? DEFAULT_AUTH_FAILURE_LIMIT;
  const limiter = failureLimit > 0
    ? new AuthFailureLimiter(failureLimit, config.authFailureWindowMs ?? DEFAULT_AUTH_FAILURE_WINDOW_MS)
    : undefined;

  return async (req, res) => {
    const remote = req.socket.remoteAddress ?? 'unknown';
    const describeRequest = () => `${req.method ?? '-'} ${(req.url ?? '').split('?')[0]!.slice(0, 200)} from ${remote}`;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      // Enrollment form: reached directly by the user's browser through a
      // reverse proxy, not by the MCP client, so it does not require the /mcp
      // bearer. Security comes from the single-use, user-bound state token plus
      // an explicit, browser-bound identity confirmation.
      if (url.pathname === '/hevy/enroll') {
        await handleEnroll(req, res, url, deps);
        return;
      }

      if (url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname !== '/mcp') {
        throw new HttpRequestError(404, 'Not found');
      }

      assertAllowedHost(req, config);
      assertAllowedOrigin(req, config);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req, config));
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        throw new HttpRequestError(405, 'Method not allowed', { headers: { Allow: 'POST, OPTIONS' } });
      }

      try {
        assertAuthorized(req, config);
      } catch (error) {
        // Only failing requests are counted and throttled; a valid token is never blocked.
        if (limiter) {
          const retryAfter = limiter.retryAfterSeconds(remote);
          if (retryAfter > 0) {
            sendJson(res, 429, { error: 'Too many failed authentication attempts' }, req, {
              'Retry-After': String(retryAfter),
            }, config);
            return;
          }
          if (limiter.recordFailure(remote)) {
            log(`[http] ${remote} reached ${failureLimit} failed authentication attempts; further failures get 429`);
          }
        }
        throw error;
      }

      const body = await readJsonBody(req, config.maxBodyBytes);
      const forwardedUser = config.trustForwardedUser ? firstHeader(req.headers['x-mcp-user']) : undefined;

      const mcpServer = createMcpServer({ client, store, onBehalfOf: forwardedUser });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });
      for (const [name, value] of Object.entries(corsHeaders(req, config))) {
        res.setHeader(name, value);
      }
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        log(`[http] ${error.status} ${describeRequest()}: ${error.message}`);
        if (!res.headersSent && !res.destroyed) {
          const payload = error.jsonRpcCode === undefined
            ? { error: error.message }
            : { jsonrpc: '2.0', error: { code: error.jsonRpcCode, message: error.message }, id: null };
          sendJson(res, error.status, payload, req, error.headers, config);
        }
        return;
      }

      log(`[http] 500 ${describeRequest()}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }, req, {}, config);
      }
    }
  };
}

const EXPIRED = '<p>This link is invalid or has expired. Run <code>hevy_connect</code> again in Claude.</p>';

async function handleEnroll(req: IncomingMessage, res: ServerResponse, url: URL, deps: HttpAppDeps): Promise<void> {
  const { store, client } = deps;
  if (req.method === 'GET') {
    const state = url.searchParams.get('state') ?? '';
    const user = store.peekState(state);
    if (!user) {
      html(res, 400, page('Link expired', EXPIRED, false));
      return;
    }
    // Step 1: show which identity the link is bound to and require an explicit
    // confirmation before any API key is accepted.
    html(res, 200, page('Connect Hevy', confirmForm(state, user)));
    return;
  }

  if (req.method !== 'POST') {
    html(res, 405, page('Method not allowed', '<p>Use the form.</p>', false));
    return;
  }

  const raw = await readRawBody(req);
  const fields = new URLSearchParams(raw);
  const state = fields.get('state') ?? '';
  const user = store.peekState(state);

  if (!user) {
    html(res, 400, page('Link expired', EXPIRED, false));
    return;
  }

  if (fields.get('step') === 'confirm') {
    if (fields.get('confirm_identity') !== 'yes') {
      html(res, 400, page('Connect Hevy', confirmForm(state, user, 'Please tick the box to confirm.'), false));
      return;
    }
    const nonce = store.confirmState(state);
    if (!nonce) {
      html(res, 400, page('Link expired', EXPIRED, false));
      return;
    }
    const secure = (deps.publicBaseUrl ?? '').startsWith('https:') ? '; Secure' : '';
    html(res, 200, page('Connect Hevy', form(state, user)), {
      'Set-Cookie': `${ENROLL_COOKIE}=${nonce}; Path=/hevy; Max-Age=${ENROLL_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Strict${secure}`,
    });
    return;
  }

  if (!store.isConfirmed(state, readCookie(req, ENROLL_COOKIE))) {
    html(res, 400, page('Connect Hevy', confirmForm(state, user, 'Please confirm the account in this browser first.'), false));
    return;
  }

  const apiKey = (fields.get('apiKey') ?? '').trim();
  if (!apiKey) {
    html(res, 400, page('Connect Hevy', form(state, user, 'Please paste your API key.')));
    return;
  }

  try {
    // Validate against Hevy before storing, so a wrong key fails here rather
    // than as a confusing 401 on the user's first real question.
    const profile = await client.verifyKey(apiKey);
    store.consumeState(state);
    store.set(user, { apiKey, connectedAt: Date.now() });
    html(
      res,
      200,
      page('Hevy connected', `<p>Linked${profile.name ? ` as <strong>${escapeHtml(profile.name)}</strong>` : ''}. You can close this tab and return to Claude.</p>`),
      { 'Set-Cookie': `${ENROLL_COOKIE}=; Path=/hevy; Max-Age=0; HttpOnly; SameSite=Strict` },
    );
  } catch (error) {
    const message = error instanceof Error && error.message.includes('401')
      ? 'Hevy rejected that key. Check you copied it fully from hevy.com/settings?developer, and that your Hevy Pro subscription is active.'
      : 'Could not verify the key with Hevy. Please try again.';
    html(res, 400, page('Connect Hevy', form(state, user, message)));
  }
}

function identityBanner(user: string): string {
  return `<p class="who">You are linking this Hevy account to <strong>${escapeHtml(user)}</strong>.</p>`;
}

function confirmForm(state: string, user: string, error = ''): string {
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  return `${err}${identityBanner(user)}
  <p>Only continue if this is <strong>your</strong> identity and you started this link yourself from your own Claude session. If not, close this page.</p>
  <form method="post">
    <input type="hidden" name="state" value="${escapeHtml(state)}">
    <input type="hidden" name="step" value="confirm">
    <label class="check"><input type="checkbox" name="confirm_identity" value="yes" required> Yes, link my Hevy account to ${escapeHtml(user)}</label>
    <button type="submit">Continue</button>
  </form>`;
}

function form(state: string, user: string, error = ''): string {
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  return `${err}${identityBanner(user)}<form method="post">
    <input type="hidden" name="state" value="${escapeHtml(state)}">
    <label for="apiKey">Hevy API key</label>
    <input id="apiKey" name="apiKey" type="password" autocomplete="off" spellcheck="false" required
           placeholder="paste your key here">
    <button type="submit">Connect</button>
  </form>
  <p class="hint">Find your key at <a href="https://hevy.com/settings?developer" target="_blank" rel="noreferrer">hevy.com/settings?developer</a>
  (open in a browser — it is not in the mobile app). Requires an active Hevy Pro subscription.</p>`;
}

function page(title: string, body: string, ok = true): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
 h1{font-size:1.3rem} label{display:block;margin:1rem 0 .35rem;font-weight:600}
 label.check{font-weight:400} label.check input{width:auto}
 input{width:100%;padding:.6rem;font-size:1rem;border:1px solid #bbb;border-radius:6px;box-sizing:border-box}
 button{margin-top:1rem;padding:.6rem 1.2rem;font-size:1rem;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer}
 .err{color:#b00020;font-weight:600} .hint{color:#555;font-size:.9rem;margin-top:1.5rem}
 .who{padding:.75rem;border:2px solid #b60;background:#fff4e5;font-size:1.1rem}
</style>
<h1>${ok ? '' : '⚠️ '}${escapeHtml(title)}</h1>${body}`;
}

function html(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    ...extra,
  });
  res.end(body);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > 64 * 1024) {
        throw new HttpRequestError(413, 'Payload too large');
      }
      chunks.push(buf);
    }
  } catch (error) {
    if (error instanceof HttpRequestError) {
      throw error;
    }
    throw new HttpRequestError(400, 'Request body could not be read (connection aborted)');
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return part.slice(idx + 1).trim() || undefined;
    }
  }
  return undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}
