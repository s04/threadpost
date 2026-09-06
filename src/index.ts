import { readConfig } from "./config";
import { Store, type Storage } from "./store";
import { D1Store } from "./d1-store";
import { d1Transport } from "./d1-transport";
import { Bridge } from "./bridge";
import { DemoConnector, TelegramConnector } from "./connectors";
import { createApp } from "./app";
import { createRuntimeHandler } from "./runtime";
import { TelegramSettings } from "./telegram-settings";

const config = readConfig();
const internalToken = process.env.CONTAINER_INTERNAL_TOKEN || "";
const useD1 = Boolean(process.env.D1_URL);
if (useD1 && internalToken.length < 32) throw new Error("D1 mode requires the private container proxy.");
const store: Storage = useD1
  ? new D1Store(d1Transport(process.env.D1_URL!, process.env.D1_TOKEN || ""))
  : new Store(config.dbPath);
await store.ready();
const workspaceBinding = `${config.siteId}:${config.connector}:${config.telegramChatId}:${config.telegramToken.split(":")[0]}`;
await store.bindWorkspace(workspaceBinding);
const bridge = new Bridge(store, config.connector === "telegram" ? new TelegramConnector(config) : new DemoConnector());
const telegram = new TelegramSettings(config, bridge, process.env.SETTINGS_KEY || config.adminToken);
await telegram.load();
const handler = createApp(config, bridge, { workspaceBinding, telegram });
const runtimeHandler = createRuntimeHandler({ handler, bridge, useD1, internalToken });
const server = Bun.serve({ hostname: config.host, port: config.port, maxRequestBodySize: 16_384,
  fetch: (request, server) => runtimeHandler(request, server.requestIP(request)?.address || "unknown"),
});
const timer = useD1 ? null : setInterval(() => { void bridge.flush(); }, 2000);
console.log(`Threadpost listening on ${config.publicUrl} (${config.connector} connector).`);
async function stop() { if (timer) clearInterval(timer); await server.stop(); while (bridge.busy) await Bun.sleep(50); await store.close(); process.exit(0); }
process.once("SIGTERM", stop); process.once("SIGINT", stop);
