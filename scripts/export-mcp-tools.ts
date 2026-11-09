// Export the actual SDK schemas without contacting Telegram, Drive or Meta.
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/bridge/mcp.ts';
import { loadBridgeConfig } from '../src/bridge/config.ts';
import { BridgeStore } from '../src/bridge/db.ts';
import { TelegramApi } from '../src/shared/telegram.ts';
import { AgentForwarder } from '../src/bridge/forwarder.ts';
import { Outbox, RateLimiter } from '../src/bridge/outbox.ts';

const cfg = loadBridgeConfig({ TG_BOT_TOKEN: 'TEST', TG_WEBHOOK_SECRET: 's'.repeat(32), TG_ALLOWED_CHAT_IDS: '1', MCP_TOKEN: 'm'.repeat(40), BRIDGE_KEY: 'b'.repeat(32) });
const store = new BridgeStore(':memory:');
const tg = new TelegramApi('TEST');
const server = buildMcpServer({ cfg, store, tg, outbox: new Outbox(tg, 1, new RateLimiter(100)), forwarder: new AgentForwarder(cfg, store, async () => {}) });
const client = new Client({ name: 'schema-export', version: '1' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const schemas = await client.listTools();
  fs.writeFileSync('docs/bridge-tool-schemas.json', JSON.stringify(schemas, null, 2) + '\n');
  console.log(`Exported ${schemas.tools.length} tool schemas to docs/bridge-tool-schemas.json`);
} finally { await client.close(); await server.close(); store.close(); }
