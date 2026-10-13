import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNodeServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CredentialStore } from '../src/hevy/store.js';
import { HevyClient, pathSegment } from '../src/hevy/client.js';
import { createServer } from '../src/server.js';
import { createHttpHandler, ENROLL_COOKIE } from '../src/transports/http-app.js';
import { assertAuthorized, assertSecureStartup, bearerMatches, escapeHtml, getHttpConfig } from '../src/transports/http-helpers.js';

const originalEnv = { ...process.env };
let dir: string;
let server: Server | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hevy-sec-'));
});
afterEach(async () => {
  process.env = { ...originalEnv };
  if (server) await new Promise(r => server!.close(r));
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function store() {
  return new CredentialStore({ path: join(dir, 'store.json'), encryptionKey: 'test-encryption-key-1234567890' });
}

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('/mcp bearer', () => {
  it('refuses to start when trusting X-MCP-User without MCP_HTTP_TOKEN', () => {
    expect(() => assertSecureStartup({ HEVY_TRUST_FORWARDED_USER: 'true' })).toThrow('MCP_HTTP_TOKEN');
    expect(() => assertSecureStartup({ HEVY_TRUST_FORWARDED_USER: 'true', MCP_HTTP_TOKEN: ' ' })).toThrow('MCP_HTTP_TOKEN');
    expect(() => assertSecureStartup({ HEVY_TRUST_FORWARDED_USER: 'true', MCP_HTTP_TOKEN: 'tok' })).not.toThrow();
    expect(() => assertSecureStartup({})).not.toThrow();
  });

  it('compares the bearer exactly', () => {
    expect(bearerMatches('Bearer s3cret', 's3cret')).toBe(true);
    expect(bearerMatches('Bearer s3cre', 's3cret')).toBe(false);
    expect(bearerMatches(undefined, 's3cret')).toBe(false);
  });

  it('rejects a forged X-MCP-User without the bearer', () => {
    const cfg = { ...getHttpConfig(), httpToken: 's3cret' };
    expect(() => assertAuthorized(req({ 'x-mcp-user': 'victim@example.com' }), cfg)).toThrow('Unauthorized');
    expect(() => assertAuthorized(req({ authorization: 'Bearer s3cret' }), cfg)).not.toThrow();
  });

  it('fails closed when trusting X-MCP-User and no token is configured', () => {
    process.env.HEVY_TRUST_FORWARDED_USER = 'true';
    const cfg = { ...getHttpConfig(), httpToken: undefined };
    expect(() => assertAuthorized(req({ 'x-mcp-user': 'victim@example.com' }), cfg)).toThrow('Unauthorized');
  });

  it('escapes HTML', () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  });
});

describe('path parameter guard', () => {
  it('rejects values that would change the addressed endpoint', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a?x=1', 'a#b', '%2e%2e', '%2E', 'a%2fb', 'a%2Fb', 'a%5cb']) {
      expect(() => pathSegment(bad), bad).toThrow('Invalid id');
    }
    expect(pathSegment('b459cba5-cd6d-463c-abd6-54f8eafcadcb')).toBe('b459cba5-cd6d-463c-abd6-54f8eafcadcb');
    expect(pathSegment('a b')).toBe('a%20b');
  });

  it('tools never send a traversal id upstream', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const s = store();
    s.set('me@example.com', { apiKey: 'k', connectedAt: Date.now() });
    const mcpServer = createServer({ client: new HevyClient({ fetchImpl: fetchMock }), store: s, onBehalfOf: 'me@example.com' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 't', version: '0' });
    await Promise.all([mcpServer.connect(st), mcp.connect(ct)]);
    const r = await mcp.callTool({ name: 'hevy_get_workout', arguments: { workoutId: '../user/info' } });
    expect(r.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('enrollment confirmation', () => {
  async function start() {
    const s = store();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: { id: 'h1', name: 'Hevy User' } }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;
    const client = new HevyClient({ fetchImpl: fetchMock });
    server = createNodeServer(
      createHttpHandler({ config: { ...getHttpConfig(), httpToken: 'tok' }, store: s, client, publicBaseUrl: 'https://hevy.me.mcp.example.com' }),
    );
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { store: s, base, fetchMock };
  }

  async function post(base: string, fields: Record<string, string>, cookie?: string) {
    return fetch(`${base}/hevy/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(fields),
    });
  }

  it('shows the bound identity (escaped) and requires confirmation before accepting a key', async () => {
    const { store: s, base, fetchMock } = await start();
    const state = s.createState('<i>owner</i>@example.com');

    const page = await fetch(`${base}/hevy/enroll?state=${state}`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('You are linking this Hevy account to');
    expect(html).toContain('&lt;i&gt;owner&lt;/i&gt;@example.com');
    expect(html).not.toContain('<i>owner</i>');
    expect(html).not.toContain('name="apiKey"');
    expect(page.headers.get('x-frame-options')).toBe('DENY');

    // A key posted without confirming is refused.
    const direct = await post(base, { state, apiKey: 'k1' });
    expect(direct.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.get('<i>owner</i>@example.com')).toBeUndefined();

    // Confirm without the checkbox is refused.
    expect((await post(base, { state, step: 'confirm' })).status).toBe(400);

    const confirmed = await post(base, { state, step: 'confirm', confirm_identity: 'yes' });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.text()).toContain('name="apiKey"');
    const setCookie = confirmed.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    const cookie = setCookie.split(';')[0]!;

    // Same state but a different browser (no / wrong cookie) is still refused.
    expect((await post(base, { state, apiKey: 'k1' })).status).toBe(400);
    expect((await post(base, { state, apiKey: 'k1' }, `${ENROLL_COOKIE}=guess`)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const ok = await post(base, { state, apiKey: 'k1' }, cookie);
    expect(ok.status).toBe(200);
    expect(s.get('<i>owner</i>@example.com')?.apiKey).toBe('k1');
    expect(s.peekState(state)).toBeUndefined(); // single use
  });
});
