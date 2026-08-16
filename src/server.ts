import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HevyClient, type HevyClientOptions } from './hevy/client.js';
import { CredentialStore } from './hevy/store.js';
import { registerHevyTools } from './tools/hevy.js';

export interface CreateServerOptions {
  client?: HevyClient;
  clientOptions?: HevyClientOptions;
  store?: CredentialStore;
  /** Gateway-verified end-user identity; every tool is bound to this user's own data. */
  onBehalfOf?: string;
  publicBaseUrl?: string;
}

const INSTRUCTIONS = `Hevy strength-training data for the signed-in user.

Each person links their OWN Hevy account before any data tool works. If a tool
returns NOT_CONNECTED, call hevy_connect, give the user the enrollment link it
returns, and have them paste their Hevy API key into that page — then retry.
The key comes from hevy.com/settings?developer in a browser (not the mobile
app) and requires an active Hevy Pro subscription.

Weights are always kilograms and durations always seconds. Hevy has no partial
update and no delete: hevy_update_workout and hevy_update_routine REPLACE the
whole record, so always read the current object first and resend it complete.
Creates are not idempotent — after an error, check before retrying.`;

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'hevy', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const client = options.client ?? new HevyClient(options.clientOptions);
  const store = options.store ?? new CredentialStore();
  registerHevyTools(server, client, store, { onBehalfOf: options.onBehalfOf, publicBaseUrl: options.publicBaseUrl });
  return server;
}
