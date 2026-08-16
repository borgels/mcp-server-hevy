import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CredentialStore } from '../src/hevy/store.js';
import { HevyClient } from '../src/hevy/client.js';
import { createServer } from '../src/server.js';
import { redactSecrets } from '../src/errors.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hevy-'));
  process.env.HEVY_PUBLIC_BASE_URL = 'https://hevy.me.mcp.example.com';
});
afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

function store() {
  return new CredentialStore({ path: join(dir, 'store.json'), encryptionKey: 'test-encryption-key-1234567890' });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

describe('CredentialStore', () => {
  it('encrypts the API key at rest and round-trips per user', () => {
    const s = store();
    s.set('ABO@example.com', { apiKey: 'super-secret-hevy-key', connectedAt: Date.now() });
    expect(s.get('abo@example.com')?.apiKey).toBe('super-secret-hevy-key');
    const raw = readFileSync(join(dir, 'store.json'), 'utf8');
    expect(raw).not.toContain('super-secret-hevy-key');
  });

  it('isolates users from each other', () => {
    const s = store();
    s.set('a@x.dk', { apiKey: 'key-a', connectedAt: Date.now() });
    s.set('b@x.dk', { apiKey: 'key-b', connectedAt: Date.now() });
    expect(s.get('a@x.dk')?.apiKey).toBe('key-a');
    expect(s.get('b@x.dk')?.apiKey).toBe('key-b');
  });

  it('enrollment state is single-use and user-bound', () => {
    const s = store();
    const state = s.createState('me@x.dk');
    expect(s.peekState(state)).toBe('me@x.dk'); // peek does not consume
    expect(s.consumeState(state)).toBe('me@x.dk');
    expect(s.consumeState(state)).toBeUndefined();
    expect(s.peekState('bogus')).toBeUndefined();
  });

  it('rejects a weak encryption key', () => {
    expect(() => new CredentialStore({ path: join(dir, 's.json'), encryptionKey: 'short' })).toThrow('HEVY_ENCRYPTION_KEY');
  });
});

describe('HevyClient', () => {
  it('authenticates with the api-key header, not Authorization: Bearer', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ page: 1, page_count: 1, workouts: [] }));
    const client = new HevyClient({ fetchImpl: fetchMock });
    const s = store();
    s.set('u@x.dk', { apiKey: 'K123', connectedAt: Date.now() });

    await client.request('u@x.dk', s, 'GET', '/v1/workouts', { query: { page: 1, pageSize: 10 } });

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['api-key']).toBe('K123');
    expect(headers.Authorization).toBeUndefined();
    expect(String(url)).toContain('pageSize=10');
  });

  it('throws NOT_CONNECTED when the user has no stored key', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new HevyClient({ fetchImpl: fetchMock });
    await expect(client.request('nobody@x.dk', store(), 'GET', '/v1/workouts')).rejects.toThrow('NOT_CONNECTED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries a failed GET', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new HevyClient({ fetchImpl: fetchMock });
    const s = store();
    s.set('u@x.dk', { apiKey: 'K', connectedAt: Date.now() });

    await client.request('u@x.dk', s, 'GET', '/v1/workouts');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('NEVER retries a write — a retried create would duplicate the workout', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('boom', { status: 500 }));
    const client = new HevyClient({ fetchImpl: fetchMock });
    const s = store();
    s.set('u@x.dk', { apiKey: 'K', connectedAt: Date.now() });

    await expect(client.request('u@x.dk', s, 'POST', '/v1/workouts', { body: { workout: {} } })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('explains a 401 in terms of key rotation and Hevy Pro', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('unauthorized', { status: 401 }));
    const client = new HevyClient({ fetchImpl: fetchMock });
    const s = store();
    s.set('u@x.dk', { apiKey: 'K', connectedAt: Date.now() });
    await expect(client.request('u@x.dk', s, 'GET', '/v1/workouts')).rejects.toThrow(/Hevy Pro/);
  });

  it('refuses a non-https base URL', () => {
    expect(() => new HevyClient({ baseUrl: 'http://api.hevyapp.com' })).toThrow(/https/);
  });

  it('verifyKey calls /v1/user/info with the candidate key', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ data: { id: '1', name: 'Stine' } }));
    const client = new HevyClient({ fetchImpl: fetchMock });
    expect(await client.verifyKey('CANDIDATE')).toMatchObject({ name: 'Stine' });
    expect(((fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>)['api-key']).toBe('CANDIDATE');
  });
});

describe('per-user isolation and write gating via MCP', () => {
  async function connect(onBehalfOf: string | undefined, fetchImpl: typeof fetch, s = store()) {
    const client = new HevyClient({ fetchImpl });
    const server = createServer({ client, store: s, onBehalfOf });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(st), mcp.connect(ct)]);
    return { mcp, store: s };
  }
  const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content)[0]?.text ?? '';

  it('fails closed without a verified identity', async () => {
    const { mcp } = await connect(undefined, vi.fn() as unknown as typeof fetch);
    const r = await mcp.callTool({ name: 'hevy_get_workouts', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('X-MCP-User');
  });

  it('tells an unlinked user to connect', async () => {
    const { mcp } = await connect('nobody@x.dk', vi.fn() as unknown as typeof fetch);
    const r = await mcp.callTool({ name: 'hevy_get_workouts', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('NOT_CONNECTED');
  });

  it('hevy_connect returns a single-use enrollment link bound to the user', async () => {
    const { mcp, store: s } = await connect('me@x.dk', vi.fn() as unknown as typeof fetch);
    const out = JSON.parse(textOf(await mcp.callTool({ name: 'hevy_connect', arguments: {} })));
    const state = new URL(out.enrollmentUrl).searchParams.get('state')!;
    expect(s.consumeState(state)).toBe('me@x.dk');
  });

  it('write tools are not registered unless HEVY_ENABLE_WRITES=true', async () => {
    delete process.env.HEVY_ENABLE_WRITES;
    const { mcp } = await connect('me@x.dk', vi.fn() as unknown as typeof fetch);
    const names = (await mcp.listTools()).tools.map(t => t.name);
    expect(names).toContain('hevy_get_workouts');
    expect(names).not.toContain('hevy_create_workout');
    expect(names).not.toContain('hevy_update_routine');
  });

  it('registers write tools when enabled, and sends Hevy-shaped payloads', async () => {
    process.env.HEVY_ENABLE_WRITES = 'true';
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ id: 'w1' }));
    const s = store();
    s.set('me@x.dk', { apiKey: 'K', connectedAt: Date.now() });
    const { mcp } = await connect('me@x.dk', fetchMock, s);

    const names = (await mcp.listTools()).tools.map(t => t.name);
    expect(names).toContain('hevy_create_workout');

    await mcp.callTool({
      name: 'hevy_create_workout',
      arguments: {
        title: 'Leg day',
        start_time: '2026-08-16T10:00:00Z',
        end_time: '2026-08-16T11:00:00Z',
        exercises: [{ exercise_template_id: 'D04AC939', sets: [{ type: 'normal', weight_kg: 100, reps: 8 }] }],
      },
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    // Hevy requires the payload nested under `workout`.
    expect(body.workout.title).toBe('Leg day');
    expect(body.workout.exercises[0].exercise_template_id).toBe('D04AC939');
    expect(body.workout.exercises[0].sets[0]).toMatchObject({ type: 'normal', weight_kg: 100, reps: 8 });
  });

  it('does not expose any body-measurement write tool (Withings owns that data)', async () => {
    process.env.HEVY_ENABLE_WRITES = 'true';
    const { mcp } = await connect('me@x.dk', vi.fn() as unknown as typeof fetch);
    const names = (await mcp.listTools()).tools.map(t => t.name);
    expect(names).toContain('hevy_get_body_measurements');
    expect(names.some(n => /body_measurement/.test(n) && /create|update|set/.test(n))).toBe(false);
  });
});

describe('secret redaction', () => {
  it('redacts the api-key header and key-shaped values', () => {
    expect(redactSecrets('api-key: abcdef123456')).toContain('[REDACTED]');
    expect(redactSecrets('HEVY_API_KEY=abcdef123456')).toContain('[REDACTED]');
  });
});
