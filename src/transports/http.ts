import { createServer as createNodeServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createMcpServer } from '../server.js';
import { HevyClient } from '../hevy/client.js';
import { CredentialStore } from '../hevy/store.js';
import { trustForwardedUser } from '../hevy/policy.js';
import {
  assertAllowedOrigin,
  assertAuthorized,
  corsHeaders,
  getHttpConfig,
  HttpRequestError,
  readJsonBody,
  sendJson,
} from './http-helpers.js';

const config = getHttpConfig();
const store = new CredentialStore();
const client = new HevyClient();

const httpServer = createNodeServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Enrollment form — reached DIRECTLY by the user's browser (Caddy routes
    // /hevy/* to this container, bypassing the gateway), so it must not
    // require the gateway bearer. Security comes from the single-use,
    // user-bound state token, exactly as in mcp-server-garmin.
    if (url.pathname === '/hevy/enroll') {
      await handleEnroll(req, res, url);
      return;
    }

    if (url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true }, req);
      return;
    }

    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Not found' }, req);
      return;
    }

    assertAllowedOrigin(req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' }, req, { Allow: 'POST' });
      return;
    }

    assertAuthorized(req, config);
    const body = await readJsonBody(req, config.maxBodyBytes);
    const forwardedUser = trustForwardedUser() ? firstHeader(req.headers['x-mcp-user']) : undefined;

    const mcpServer = createMcpServer({ client, store, onBehalfOf: forwardedUser });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      if (error instanceof HttpRequestError) {
        sendJson(res, error.status, { error: error.message }, req);
        return;
      }
      sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }, req);
    }
  }
});

async function handleEnroll(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method === 'GET') {
    const state = url.searchParams.get('state') ?? '';
    if (!store.peekState(state)) {
      html(res, 400, page('Link expired', '<p>This link is invalid or has expired. Run <code>hevy_connect</code> again in Claude.</p>', false));
      return;
    }
    html(res, 200, page('Connect Hevy', form(state)));
    return;
  }

  if (req.method !== 'POST') {
    html(res, 405, page('Method not allowed', '<p>Use the form.</p>', false));
    return;
  }

  const raw = await readRawBody(req);
  const fields = new URLSearchParams(raw);
  const state = fields.get('state') ?? '';
  const apiKey = (fields.get('apiKey') ?? '').trim();
  const user = store.peekState(state);

  if (!user) {
    html(res, 400, page('Link expired', '<p>This link is invalid or has expired. Run <code>hevy_connect</code> again in Claude.</p>', false));
    return;
  }
  if (!apiKey) {
    html(res, 400, page('Connect Hevy', form(state, 'Please paste your API key.')));
    return;
  }

  try {
    // Validate against Hevy before storing, so a wrong key fails here rather
    // than as a confusing 401 on the user's first real question.
    const profile = await client.verifyKey(apiKey);
    store.consumeState(state);
    store.set(user, { apiKey, connectedAt: Date.now() });
    html(res, 200, page('Hevy connected', `<p>Linked${profile.name ? ` as <strong>${escapeHtml(profile.name)}</strong>` : ''}. You can close this tab and return to Claude.</p>`));
  } catch (error) {
    const message = error instanceof Error && error.message.includes('401')
      ? 'Hevy rejected that key. Check you copied it fully from hevy.com/settings?developer, and that your Hevy Pro subscription is active.'
      : 'Could not verify the key with Hevy. Please try again.';
    html(res, 400, page('Connect Hevy', form(state, message)));
  }
}

function form(state: string, error = ''): string {
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  return `${err}<form method="post">
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
 input{width:100%;padding:.6rem;font-size:1rem;border:1px solid #bbb;border-radius:6px;box-sizing:border-box}
 button{margin-top:1rem;padding:.6rem 1.2rem;font-size:1rem;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer}
 .err{color:#b00020;font-weight:600} .hint{color:#555;font-size:.9rem;margin-top:1.5rem}
</style>
<h1>${ok ? '' : '⚠️ '}${escapeHtml(title)}</h1>${body}`;
}

function html(res: import('node:http').ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readRawBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > 64 * 1024) {
      throw new HttpRequestError(413, 'Payload too large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

httpServer.listen(config.port, config.host, () => {
  console.error(`Hevy MCP HTTP server listening on http://${config.host}:${config.port} (/mcp + /hevy/enroll)`);
});
