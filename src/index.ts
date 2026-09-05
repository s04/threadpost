import { readConfig } from "./config";
import { Store } from "./store";
import { Bridge } from "./bridge";
import { DemoConnector, TelegramConnector } from "./connectors";
import { createApp } from "./app";

const config = readConfig();
const store = new Store(config.dbPath);
const bridge = new Bridge(store, config.connector === "telegram" ? new TelegramConnector(config) : new DemoConnector());
const handler = createApp(config, bridge);
const server = Bun.serve({ hostname: config.host, port: config.port, maxRequestBodySize: 16_384,
  fetch: (request, server) => handler(request, server.requestIP(request)?.address || "unknown"),
});
const timer = setInterval(() => { void bridge.flush(); }, 2000);
console.log(`Threadpost listening on ${config.publicUrl} (${config.connector} connector).`);
async function stop() { clearInterval(timer); await server.stop(); while (bridge.busy) await Bun.sleep(50); store.db.close(); process.exit(0); }
process.once("SIGTERM", stop); process.once("SIGINT", stop);
