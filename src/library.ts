/** Small composition boundary for embedding the bridge in another Bun service. */
export { Store, AppError } from "./store";
export type { Conversation, Message } from "./store";
export { Bridge } from "./bridge";
export { createApp } from "./app";
export { readConfig } from "./config";
export type { Config } from "./config";
export { DemoConnector, TelegramConnector, DeliveryError } from "./connectors";
export type { Connector, OperatorReply } from "./connectors";
