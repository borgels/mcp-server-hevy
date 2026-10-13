import { createServer as createNodeServer } from 'node:http';
import { HevyClient } from '../hevy/client.js';
import { CredentialStore } from '../hevy/store.js';
import { createHttpHandler } from './http-app.js';
import { assertSecureStartup, getHttpConfig } from './http-helpers.js';

// Refuse to start if X-MCP-User would be trusted without the gateway bearer on /mcp.
try {
  assertSecureStartup();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const config = getHttpConfig();
const store = new CredentialStore();
const client = new HevyClient();

const httpServer = createNodeServer(
  createHttpHandler({ config, store, client, publicBaseUrl: process.env.HEVY_PUBLIC_BASE_URL }),
);

httpServer.listen(config.port, config.host, () => {
  console.error(`Hevy MCP HTTP server listening on http://${config.host}:${config.port} (/mcp + /hevy/enroll)`);
});
