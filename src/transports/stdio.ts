#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../server.js';

async function main(): Promise<void> {
  // HEVY_DEV_USER lets you exercise the per-user tools locally over stdio,
  // where no gateway is forwarding a verified X-MCP-User. Never set it in a
  // hosted deployment.
  const server = createServer({ onBehalfOf: process.env.HEVY_DEV_USER });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
