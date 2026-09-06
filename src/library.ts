/** Small composition boundary for embedding the bridge in another Bun service. */
export { Store, AppError } from "./store";
export type { Conversation, Message, Storage } from "./store";
export { D1Store } from "./d1-store";
export type { D1Result, D1Statement, D1Transport, D1Value } from "./d1-store";
export { d1Transport } from "./d1-transport";
export { Bridge } from "./bridge";
export { createApp } from "./app";
export { TelegramSettings } from "./telegram-settings";
export type { TelegramStatus, TelegramConnectInput } from "./telegram-settings";
export { readConfig } from "./config";
export type { Config } from "./config";
export { DemoConnector, TelegramConnector, DeliveryError } from "./connectors";
export type { Connector, ConversationContext, OperatorReply } from "./connectors";
