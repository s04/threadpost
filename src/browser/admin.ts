"use strict";

type ConversationStatus = "open" | "closed";
type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "unknown";
interface Conversation { id: string; name: string; status: ConversationStatus; createdAt: string; updatedAt: string; }
interface ConversationSummary extends Conversation { lastMessage: string | null; messageCount: number; }
interface Message { id: number; direction: "inbound" | "outbound"; body: string; createdAt: string; deliveryStatus: DeliveryStatus; }
interface Thread { conversation: Conversation; messages: Message[]; }
interface Overview {
  site: { id: string; name: string; origins: string[] };
  connector: { kind: "demo" | "telegram"; configured: boolean };
  counts: { open: number; closed: number; pending: number; failed: number };
  embedScript: string;
}
interface TelegramConnection { connected: boolean; botUsername?: string; chatId?: string; operatorIds?: string[]; }
interface AppState {
  overview: Overview | null; conversations: ConversationSummary[]; selectedId: string | null;
  conversation: Thread | null; loading: boolean; threadRequest: number; replyId: string | null; replyBody: string | null;
}
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element #${id}`);
  return node as T;
};
const state: AppState = { overview: null, conversations: [], selectedId: null, conversation: null, loading: false, threadRequest: 0, replyId: null, replyBody: null };
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const shortTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
let snippetInitialized = false;

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  let data: unknown = null;
  try { data = await response.json(); } catch { /* An empty response is valid for logout/delete. */ }
  if (!response.ok) {
    const detail = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string" ? data.error : null;
    throw new HttpError(response.status, detail || (response.status === 429 ? "Too many requests. Please wait and try again." : "Something went wrong."));
  }
  return data as T;
}

function setAuthenticated(authenticated: boolean) {
  $("login-view").hidden = authenticated;
  $("admin-view").hidden = !authenticated;
  if (authenticated) $<HTMLInputElement>("token").value = "";
  if (!authenticated) {
    state.overview = null; state.conversations = []; state.selectedId = null; state.conversation = null;
    setTimeout(() => $<HTMLInputElement>("token").focus(), 0);
  }
}

function handleError(error: unknown, target: HTMLElement) {
  const known = error instanceof HttpError ? error : new HttpError(500, "Something went wrong.");
  if (known.status === 401) {
    setAuthenticated(false);
    show($("login-error"), "Your session has ended. Sign in again.");
    return;
  }
  show(target, known.message);
}

function show(element: HTMLElement, message: string) { element.textContent = message; element.hidden = !message; }
function clear(element: HTMLElement) { while (element.firstChild) element.removeChild(element.firstChild); }
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function displayName(conversation: Conversation) { return conversation.name?.trim() || "Anonymous visitor"; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "" : dateTime.format(date); }
function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderEmbedSnippet() {
  if (!state.overview) return;
  const parsed = new DOMParser().parseFromString(state.overview.embedScript, "text/html").querySelector("script");
  if (!parsed?.src || !parsed.dataset.site) return;
  const attributes: Array<[string, string]> = [
    ["src", parsed.src],
    ["data-site", parsed.dataset.site],
  ];
  const title = $<HTMLInputElement>("widget-title").value.trim();
  const greeting = $<HTMLInputElement>("widget-greeting").value.trim();
  if (title) attributes.push(["data-title", title]);
  if (greeting) attributes.push(["data-greeting", greeting]);
  attributes.push(
    ["data-color", $<HTMLInputElement>("widget-color").value],
    ["data-position", $<HTMLSelectElement>("widget-position").value]
  );
  $<HTMLTextAreaElement>("embed-code").value = `<script ${attributes.map(([name, value]) => `${name}="${escapeAttribute(value)}"`).join(" ")} defer></script>`;
  $<HTMLOutputElement>("widget-color-value").value = $<HTMLInputElement>("widget-color").value;
  show($("copy-status"), "");
}

function initializeSnippet() {
  if (!state.overview || snippetInitialized) return;
  const parsed = new DOMParser().parseFromString(state.overview.embedScript, "text/html").querySelector("script");
  $<HTMLInputElement>("widget-title").value = parsed?.dataset.title || "";
  $<HTMLInputElement>("widget-greeting").value = parsed?.dataset.greeting || "";
  snippetInitialized = true;
  renderEmbedSnippet();
}

function renderTelegram(connection: TelegramConnection) {
  const badge = $("telegram-badge");
  badge.textContent = connection.connected ? "Connected" : "Not connected";
  badge.classList.toggle("connected", connection.connected);
  if (connection.connected) {
    const bot = connection.botUsername ? `@${connection.botUsername.replace(/^@/, "")}` : "Telegram bot";
    show($("telegram-status"), `${bot} is connected to group ${connection.chatId || "configured"}. ${connection.operatorIds?.length || 0} operator${connection.operatorIds?.length === 1 ? "" : "s"} allowed.`);
    $<HTMLButtonElement>("telegram-submit").textContent = "Update connection";
  } else {
    show($("telegram-status"), "No Telegram bot is connected. Complete the fields below when your private forum is ready.");
    $<HTMLButtonElement>("telegram-submit").textContent = "Connect Telegram";
  }
  if (connection.chatId) $<HTMLInputElement>("telegram-chat-id").value = connection.chatId;
  if (connection.operatorIds?.length) $<HTMLInputElement>("telegram-operator-ids").value = connection.operatorIds.join(", ");
}

async function loadTelegram() {
  try { renderTelegram(await api<TelegramConnection>("/api/admin/telegram")); }
  catch (error) { handleError(error, $("telegram-status")); }
}

async function loadApp() {
  try {
    const [overview, result] = await Promise.all([api<Overview>("/api/admin/overview"), api<{ conversations: ConversationSummary[] }>("/api/admin/conversations")]);
    state.overview = overview; state.conversations = result.conversations || [];
    setAuthenticated(true); renderOverview(); renderList();
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) setAuthenticated(false);
    else { setAuthenticated(false); handleError(error, $("login-error")); }
  }
}

function renderOverview() {
  if (!state.overview) return;
  const { site, connector, counts } = state.overview;
  $("site-name").textContent = site.name;
  initializeSnippet();
  const countItems: Array<[string, number]> = [["Open", counts.open], ["Closed", counts.closed], ["Pending", counts.pending], ["Needs attention", counts.failed]];
  clear($("counts"));
  countItems.forEach(([label, count]) => {
    const item = el("div", "count"); item.append(el("strong", "", String(count)), el("span", "", label)); $("counts").append(item);
  });
  clear($("site-details"));
  const rows: Array<[string, string]> = [
    ["Site", `${site.name} (${site.id})`],
    ["Allowed origins", site.origins.length ? site.origins.join(", ") : "None configured"],
    ["Connector", connector.kind === "demo" ? "Demo · local simulation" : `Telegram · ${connector.configured ? "configured" : "not configured"}`]
  ];
  rows.forEach(([term, value]) => { $("site-details").append(el("dt", "", term), el("dd", "", value)); });
}

function renderList() {
  const list = $("conversation-list"); clear(list);
  show($("list-status"), state.conversations.length ? "" : "No conversations yet.");
  state.conversations.forEach((conversation) => {
    const button = el("button", "conversation-item"); button.type = "button";
    button.dataset.id = conversation.id; button.setAttribute("aria-current", conversation.id === state.selectedId ? "true" : "false");
    const top = el("span", "conversation-top"); top.append(el("strong", "", displayName(conversation)), el("time", "", formatDate(conversation.updatedAt)));
    const preview = el("span", "conversation-preview", conversation.lastMessage || "No messages yet");
    const bottom = el("span", "conversation-bottom");
    bottom.append(el("span", `status-pill ${conversation.status}`, conversation.status), el("span", "", `${conversation.messageCount} message${conversation.messageCount === 1 ? "" : "s"}`));
    button.append(top, preview, bottom); button.addEventListener("click", () => selectConversation(conversation.id)); list.append(button);
  });
}

async function refresh(quiet = false): Promise<void> {
  if (state.loading) return;
  state.loading = true; $<HTMLButtonElement>("refresh-button").disabled = true;
  if (!quiet) show($("list-status"), "Refreshing…");
  try {
    const [overview, result] = await Promise.all([api<Overview>("/api/admin/overview"), api<{ conversations: ConversationSummary[] }>("/api/admin/conversations")]);
    state.overview = overview; state.conversations = result.conversations || []; renderOverview(); renderList();
    if (state.selectedId) await selectConversation(state.selectedId, false, true);
  } catch (error) { handleError(error, $("list-status")); }
  finally { state.loading = false; $<HTMLButtonElement>("refresh-button").disabled = false; }
}

async function selectConversation(id: string, moveFocus = true, quiet = false): Promise<void> {
  const requestId = ++state.threadRequest;
  state.selectedId = id; renderList();
  $("empty-thread").hidden = true; $("active-thread").hidden = false; document.body.classList.add("thread-open");
  if (!quiet) {
    $<HTMLTextAreaElement>("reply").disabled = true; $<HTMLButtonElement>("reply-form").querySelector<HTMLButtonElement>("button[type=submit]")!.disabled = true;
    show($("thread-error"), ""); clear($("message-list")); $("message-list").append(el("p", "loading", "Loading conversation…"));
  }
  try {
    const result = await api<Thread>(`/api/admin/conversations/${encodeURIComponent(id)}`);
    if (requestId !== state.threadRequest || id !== state.selectedId) return;
    state.conversation = result;
    renderThread(quiet);
    if (moveFocus) $("thread-name").focus?.();
  } catch (error) {
    if (requestId !== state.threadRequest) return;
    if (!quiet) clear($("message-list"));
    handleError(error, $("thread-error"));
  }
}

function renderThread(preserveScroll = false) {
  if (!state.conversation) return;
  const { conversation, messages } = state.conversation;
  $("thread-name").textContent = displayName(conversation);
  $("thread-name").tabIndex = -1;
  $("thread-meta").textContent = `Started ${formatDate(conversation.createdAt)} · ${conversation.status}`;
  $("status-button").textContent = conversation.status === "open" ? "Close" : "Reopen";
  $("reply-form").hidden = conversation.status !== "open";
  $("closed-note").hidden = conversation.status === "open";
  $<HTMLTextAreaElement>("reply").disabled = false; $<HTMLButtonElement>("reply-form").querySelector<HTMLButtonElement>("button[type=submit]")!.disabled = false;
  const list = $("message-list");
  const oldScrollTop = list.scrollTop;
  const wasNearBottom = list.scrollHeight - list.clientHeight - list.scrollTop < 80;
  clear(list);
  if (!messages.length) list.append(el("p", "loading", "No messages in this conversation."));
  messages.forEach((message) => {
    const article = el("article", `message ${message.direction}`);
    const bubble = el("div", "message-bubble"); bubble.append(el("p", "", message.body));
    const meta = el("div", "message-meta"); meta.append(el("time", "", shortTime.format(new Date(message.createdAt))));
    if (message.direction === "inbound") meta.append(el("span", `delivery ${message.deliveryStatus}`, message.deliveryStatus));
    bubble.append(meta); article.append(bubble);
    if (message.direction === "inbound" && (message.deliveryStatus === "failed" || message.deliveryStatus === "unknown")) {
      const retry = el("button", "retry-button", "Retry delivery"); retry.type = "button";
      retry.addEventListener("click", () => confirmRetry(message)); article.append(retry);
    }
    list.append(article);
  });
  requestAnimationFrame(() => { list.scrollTop = preserveScroll && !wasNearBottom ? oldScrollTop : list.scrollHeight; });
}

async function submitReply(event: SubmitEvent) {
  event.preventDefault(); const input = $<HTMLTextAreaElement>("reply"); const body = input.value.trim(); if (!body || !state.selectedId) return;
  const conversationId = state.selectedId;
  const form = event.currentTarget as HTMLFormElement;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!; button.disabled = true; show($("reply-status"), "Sending…");
  try {
    if (!state.replyId || state.replyBody !== body) state.replyId = crypto.randomUUID();
    state.replyBody = body;
    await api<Message>(`/api/admin/conversations/${encodeURIComponent(conversationId)}/messages`, { method: "POST", body: JSON.stringify({ body, clientMessageId: state.replyId }) });
    state.replyId = null; state.replyBody = null; input.value = ""; show($("reply-status"), "Sent"); await selectConversation(conversationId, false);
    const result = await api<{ conversations: ConversationSummary[] }>("/api/admin/conversations"); state.conversations = result.conversations || []; renderList();
  } catch (error) { handleError(error, $("reply-status")); }
  finally { button.disabled = false; }
}

async function toggleStatus() {
  if (!state.conversation || !state.selectedId) return;
  const next: ConversationStatus = state.conversation.conversation.status === "open" ? "closed" : "open";
  $<HTMLButtonElement>("status-button").disabled = true;
  try {
    await api(`/api/admin/conversations/${encodeURIComponent(state.selectedId)}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
    await refresh();
    if (next === "open") $<HTMLTextAreaElement>("reply").focus();
  } catch (error) { handleError(error, $("thread-error")); }
  finally { $<HTMLButtonElement>("status-button").disabled = false; }
}

function confirmDialog(title: string, message: string, label: string, action: () => Promise<void>) {
  $("confirm-title").textContent = title; $("confirm-message").textContent = message; $("confirm-action").textContent = label;
  const dialog = $<HTMLDialogElement>("confirm-dialog");
  dialog.showModal();
  dialog.addEventListener("close", async function runOnce() {
    dialog.removeEventListener("close", runOnce);
    if (dialog.returnValue === "confirm") await action();
  });
}

function confirmRetry(message: Message) {
  const warning = message.deliveryStatus === "unknown"
    ? "The previous delivery outcome is unknown. Retrying may send this reply twice. Continue?"
    : "This delivery failed. Retry sending the same reply?";
  confirmDialog("Retry delivery?", warning, "Retry", async () => {
    try {
      await api<Message>(`/api/admin/messages/${encodeURIComponent(message.id)}/retry`, { method: "POST" });
      if (state.selectedId) await selectConversation(state.selectedId, false);
    }
    catch (error) { handleError(error, $("thread-error")); }
  });
}

function confirmDelete() {
  if (!state.selectedId) return;
  const conversationId = state.selectedId;
  confirmDialog("Delete conversation?", "This permanently deletes the local conversation and messages. Copies already sent to Telegram are not deleted.", "Delete", async () => {
    try {
      await api<{ ok: true }>(`/api/admin/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
      state.selectedId = null; state.conversation = null; document.body.classList.remove("thread-open");
      $("active-thread").hidden = true; $("empty-thread").hidden = false; await refresh();
    } catch (error) { handleError(error, $("thread-error")); }
  });
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const button = form.querySelector<HTMLButtonElement>("button")!; button.disabled = true; show($("login-error"), "");
  try { await api<{ ok: true }>("/api/admin/login", { method: "POST", body: JSON.stringify({ token: $<HTMLInputElement>("token").value }) }); await loadApp(); }
  catch (error) { handleError(error, $("login-error")); }
  finally { button.disabled = false; }
});
$("logout-button").addEventListener("click", async () => { try { await api("/api/admin/logout", { method: "POST" }); } finally { setAuthenticated(false); } });
$("refresh-button").addEventListener("click", () => refresh());
$("reply-form").addEventListener("submit", (event) => void submitReply(event as SubmitEvent));
$("status-button").addEventListener("click", toggleStatus);
$("delete-button").addEventListener("click", confirmDelete);
$("back-button").addEventListener("click", () => { document.body.classList.remove("thread-open"); if (state.selectedId) $("conversation-list").querySelector<HTMLElement>(`[data-id="${CSS.escape(state.selectedId)}"]`)?.focus(); });
$("settings-button").addEventListener("click", () => {
  $<HTMLDialogElement>("settings-dialog").showModal();
  void loadTelegram();
});
$("settings-close").addEventListener("click", () => $<HTMLDialogElement>("settings-dialog").close());
$("telegram-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $<HTMLButtonElement>("telegram-submit");
  const token = $<HTMLInputElement>("telegram-token");
  const operatorIds = $<HTMLInputElement>("telegram-operator-ids").value.split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
  button.disabled = true; show($("telegram-error"), "");
  try {
    const connection = await api<TelegramConnection>("/api/admin/telegram", { method: "POST", body: JSON.stringify({
      botToken: token.value, chatId: $<HTMLInputElement>("telegram-chat-id").value.trim(), operatorIds,
    }) });
    token.value = "";
    renderTelegram(connection);
  } catch (error) { handleError(error, $("telegram-error")); }
  finally { button.disabled = false; }
});
["widget-title", "widget-greeting", "widget-color", "widget-position"].forEach(id => {
  $(id).addEventListener("input", renderEmbedSnippet);
  $(id).addEventListener("change", renderEmbedSnippet);
});
$("copy-button").addEventListener("click", async () => {
  const embed = $<HTMLTextAreaElement>("embed-code");
  try { await navigator.clipboard.writeText(embed.value); show($("copy-status"), "Copied"); }
  catch { embed.select(); show($("copy-status"), "Select the snippet and copy it manually."); }
});
loadApp();
setInterval(() => {
  if (!document.hidden && !$("admin-view").hidden) refresh(true);
}, 5000);
