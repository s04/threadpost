"use strict";

type ConversationStatus = "open" | "closed";
type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "unknown";
interface Conversation { id: string; name: string; status: ConversationStatus; blocked: boolean; createdAt: string; updatedAt: string; sourceOrigin: string | null; sourcePath: string | null; }
interface ConversationSummary extends Conversation { lastMessage: string | null; messageCount: number; lastInboundId: number; }
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
  conversation: Thread | null; loading: boolean; threadRequest: number;
}
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element #${id}`);
  return node as T;
};
const state: AppState = { overview: null, conversations: [], selectedId: null, conversation: null, loading: false, threadRequest: 0 };
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const shortTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
let snippetInitialized = false;
const drafts = new Map<string, string>();
const sending = new Set<string>();
const replyAttempts = new Map<string, { id: string; body: string }>();
const readWatermarks = new Map<string, number>();
const notifiedInbound = new Map<string, number>();
let watermarksLoaded = false;
let notificationsEnabled = false;
let pollTimer: number | undefined;
let pollRunning = false;
let pollFailures = 0;
let initialConversation = new URL(location.href).searchParams.get("conversation");

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin", signal: options.signal || AbortSignal.timeout(15_000) });
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
    $<HTMLInputElement>("remember-session").checked = false;
    document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach(dialog => dialog.close());
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    state.overview = null; state.conversations = []; state.selectedId = null; state.conversation = null;
    setTimeout(() => $<HTMLInputElement>("token").focus(), 0);
  }
}

function handleError(error: unknown, target: HTMLElement) {
  const known = error instanceof HttpError ? error : new HttpError(500,
    error instanceof DOMException && error.name === "TimeoutError"
      ? "The request timed out. Check the connection status before trying again."
      : "Could not reach the server. Check your connection and try again.");
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
function sourceLabel(conversation: Conversation) {
  const siteName = state.overview?.site.name || "Website";
  if (!conversation.sourceOrigin) return siteName;
  try {
    const url = new URL(conversation.sourceOrigin);
    const path = conversation.sourcePath?.startsWith("/") ? conversation.sourcePath : "";
    return `${siteName} · Browser-reported: ${url.host}${path}`;
  } catch { return siteName; }
}
function watermarkKey() { return `threadpost:read:${state.overview?.site.id || "default"}`; }
function saveWatermarks() {
  try { localStorage.setItem(watermarkKey(), JSON.stringify(Object.fromEntries(readWatermarks))); } catch { /* Storage can be unavailable. */ }
}
function loadWatermarks() {
  if (watermarksLoaded) return;
  try {
    const saved = JSON.parse(localStorage.getItem(watermarkKey()) || "{}");
    if (saved && typeof saved === "object") for (const [id, value] of Object.entries(saved)) if (Number.isSafeInteger(value)) readWatermarks.set(id, Number(value));
  } catch { /* Ignore malformed or unavailable local storage. */ }
  watermarksLoaded = true;
}
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
    ["data-position", $<HTMLSelectElement>("widget-position").value],
    ["data-theme", $<HTMLSelectElement>("widget-theme").value],
    ["data-style", $<HTMLSelectElement>("widget-style").value],
    ["data-font", $<HTMLSelectElement>("widget-font").value]
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

function renderNotificationButton() {
  const button = $<HTMLButtonElement>("notification-button");
  if (!("Notification" in window) || typeof Notification.requestPermission !== "function") { button.textContent = "Alerts unavailable"; button.disabled = true; return; }
  button.disabled = Notification.permission === "denied";
  button.textContent = Notification.permission === "denied" ? "Alerts blocked" : notificationsEnabled ? "Alerts on" : "Alerts off";
  button.setAttribute("aria-pressed", String(notificationsEnabled));
}

function loadNotificationPreference() {
  try { notificationsEnabled = localStorage.getItem("threadpost:notifications") === "on" && "Notification" in window && typeof Notification.requestPermission === "function" && Notification.permission === "granted"; }
  catch { notificationsEnabled = false; }
  renderNotificationButton();
}

function notifyConversation(conversation: ConversationSummary) {
  if (!notificationsEnabled || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const notification = new Notification(`New message · ${state.overview?.site.name || "Threadpost"}`, {
      body: "A visitor sent a new message.", tag: `threadpost-${conversation.id}`,
    });
    notification.onclick = () => { window.focus(); void selectConversation(conversation.id); notification.close(); };
  } catch {
    notificationsEnabled = false;
    try { localStorage.setItem("threadpost:notifications", "off"); } catch { /* Preference stays in memory. */ }
    renderNotificationButton();
  }
}

function processIncoming(conversations: ConversationSummary[], initial = false) {
  loadWatermarks();
  for (const conversation of conversations) {
    const latest = Number(conversation.lastInboundId) || 0;
    if (!readWatermarks.has(conversation.id)) {
      readWatermarks.set(conversation.id, initial ? latest : 0);
    }
    if (!notifiedInbound.has(conversation.id)) notifiedInbound.set(conversation.id, initial ? latest : 0);
    const notified = notifiedInbound.get(conversation.id) || 0;
    if (!initial && latest > notified) {
      const activelyReading = conversation.id === state.selectedId && !document.hidden && document.hasFocus();
      if (!activelyReading) notifyConversation(conversation);
      notifiedInbound.set(conversation.id, latest);
    }
  }
  saveWatermarks();
}

function markRead(conversationId: string, messages: Message[]) {
  if (document.hidden || !document.hasFocus()) return;
  const latest = messages.reduce((id, message) => message.direction === "inbound" ? Math.max(id, message.id) : id, 0);
  if (latest > (readWatermarks.get(conversationId) || 0)) { readWatermarks.set(conversationId, latest); saveWatermarks(); }
}

function resetThread() {
  state.selectedId = null; state.conversation = null; state.threadRequest++;
  document.body.classList.remove("thread-open");
  $("active-thread").hidden = true; $("empty-thread").hidden = false;
}

async function loadApp() {
  try {
    const [overview, result] = await Promise.all([api<Overview>("/api/admin/overview"), api<{ conversations: ConversationSummary[] }>("/api/admin/conversations")]);
    state.overview = overview; processIncoming(result.conversations || [], true); state.conversations = result.conversations || [];
    setAuthenticated(true); renderOverview(); renderList(); schedulePoll();
    if (initialConversation && /^[a-zA-Z0-9-]{1,80}$/.test(initialConversation)) {
      const id = initialConversation; initialConversation = null;
      await selectConversation(id);
    }
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
  $("first-run-empty").hidden = state.conversations.length > 0;
  $("select-conversation-empty").hidden = state.conversations.length === 0;
  state.conversations.forEach((conversation) => {
    const unread = (Number(conversation.lastInboundId) || 0) > (readWatermarks.get(conversation.id) || 0);
    const button = el("button", `conversation-item${unread ? " unread" : ""}`); button.type = "button";
    button.dataset.id = conversation.id; button.setAttribute("aria-current", conversation.id === state.selectedId ? "true" : "false");
    const top = el("span", "conversation-top"); top.append(el("strong", "", displayName(conversation)), el("time", "", formatDate(conversation.updatedAt)));
    const preview = el("span", "conversation-preview", conversation.lastMessage || "No messages yet");
    const source = el("span", "conversation-source", sourceLabel(conversation));
    const bottom = el("span", "conversation-bottom");
    bottom.append(el("span", `status-pill ${conversation.blocked ? "blocked" : conversation.status}`, conversation.blocked ? "blocked" : conversation.status), el("span", "", `${conversation.messageCount} message${conversation.messageCount === 1 ? "" : "s"}`));
    button.append(top, preview, source, bottom); button.addEventListener("click", () => selectConversation(conversation.id)); list.append(button);
  });
}

async function refresh(quiet = false): Promise<boolean> {
  if (state.loading) return true;
  state.loading = true; $<HTMLButtonElement>("refresh-button").disabled = true;
  if (!quiet) show($("list-status"), "Refreshing…");
  try {
    const [overview, result] = await Promise.all([api<Overview>("/api/admin/overview"), api<{ conversations: ConversationSummary[] }>("/api/admin/conversations")]);
    state.overview = overview; processIncoming(result.conversations || []); state.conversations = result.conversations || []; renderOverview(); renderList();
    if (state.selectedId) await selectConversation(state.selectedId, false, true);
    return true;
  } catch (error) { handleError(error, $("list-status")); return false; }
  finally { state.loading = false; $<HTMLButtonElement>("refresh-button").disabled = false; }
}

async function selectConversation(id: string, moveFocus = true, quiet = false): Promise<void> {
  const previousId = state.selectedId;
  if (previousId && previousId !== id) drafts.set(previousId, $<HTMLTextAreaElement>("reply").value);
  const changedConversation = previousId !== id;
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
    const unchanged = !changedConversation && state.conversation
      && JSON.stringify(state.conversation) === JSON.stringify(result);
    state.conversation = result;
    markRead(id, result.messages); renderList();
    if (changedConversation) $<HTMLTextAreaElement>("reply").value = drafts.get(id) || "";
    if (!unchanged) renderThread(quiet);
    if (moveFocus) $("thread-name").focus?.();
  } catch (error) {
    if (requestId !== state.threadRequest) return;
    if (quiet && error instanceof HttpError && error.status === 404) { resetThread(); renderList(); return; }
    if (!quiet) clear($("message-list"));
    handleError(error, $("thread-error"));
  }
}

function renderThread(preserveScroll = false) {
  if (!state.conversation) return;
  const { conversation, messages } = state.conversation;
  $("thread-name").textContent = displayName(conversation);
  $("thread-name").tabIndex = -1;
  $("thread-meta").textContent = `${sourceLabel(conversation)} · Started ${formatDate(conversation.createdAt)} · ${conversation.blocked ? "blocked" : conversation.status}`;
  $("status-button").textContent = conversation.status === "open" ? "Close" : "Reopen";
  $("block-button").textContent = conversation.blocked ? "Unblock" : "Block";
  const canReply = conversation.status === "open" && !conversation.blocked;
  $("reply-form").hidden = !canReply;
  $("closed-note").hidden = canReply;
  $("closed-note").textContent = conversation.blocked ? "This visitor is blocked. Unblock them to receive messages and reply." : "This conversation is closed. Reopen it to reply.";
  const isSending = sending.has(conversation.id);
  $<HTMLTextAreaElement>("reply").disabled = isSending;
  $<HTMLButtonElement>("reply-form").querySelector<HTMLButtonElement>("button[type=submit]")!.disabled = isSending;
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
  if (sending.has(conversationId)) return;
  sending.add(conversationId);
  const form = event.currentTarget as HTMLFormElement;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!; button.disabled = true; input.disabled = true; show($("reply-status"), "Sending…");
  try {
    let attempt = replyAttempts.get(conversationId);
    if (!attempt || attempt.body !== body) { attempt = { id: crypto.randomUUID(), body }; replyAttempts.set(conversationId, attempt); }
    await api<Message>(`/api/admin/conversations/${encodeURIComponent(conversationId)}/messages`, { method: "POST", body: JSON.stringify({ body, clientMessageId: attempt.id }) });
    replyAttempts.delete(conversationId); drafts.delete(conversationId);
    if (state.selectedId === conversationId) input.value = "";
    show($("reply-status"), "Sent"); await selectConversation(conversationId, false);
    const result = await api<{ conversations: ConversationSummary[] }>("/api/admin/conversations"); state.conversations = result.conversations || []; renderList();
  } catch (error) { handleError(error, $("reply-status")); }
  finally {
    sending.delete(conversationId);
    if (state.selectedId === conversationId) { button.disabled = false; input.disabled = false; }
  }
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
      drafts.delete(conversationId); replyAttempts.delete(conversationId); resetThread(); await refresh();
    } catch (error) { handleError(error, $("thread-error")); }
  });
}

async function setBlocked(blocked: boolean) {
  if (!state.selectedId) return;
  const id = state.selectedId;
  $<HTMLButtonElement>("block-button").disabled = true;
  try {
    await api(`/api/admin/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ blocked }) });
    await refresh();
  } catch (error) { handleError(error, $("thread-error")); }
  finally { $<HTMLButtonElement>("block-button").disabled = false; }
}

function toggleBlocked() {
  if (!state.conversation) return;
  if (state.conversation.conversation.blocked) { void setBlocked(false); return; }
  confirmDialog("Block visitor?", "This stops new messages from this visitor. Their existing conversation remains available.", "Block", () => setBlocked(true));
}

function schedulePoll(delay?: number) {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = undefined;
  if ($("admin-view").hidden || !navigator.onLine || (document.hidden && !notificationsEnabled)) return;
  const normalDelay = document.hidden ? 15_000 : 3_000;
  pollTimer = window.setTimeout(() => void pollNow(), delay ?? normalDelay);
}

async function pollNow() {
  if (pollRunning || $("admin-view").hidden || !navigator.onLine || (document.hidden && !notificationsEnabled)) { schedulePoll(); return; }
  pollRunning = true;
  try {
    const succeeded = await refresh(true);
    pollFailures = succeeded ? 0 : Math.min(pollFailures + 1, 6);
  } finally {
    pollRunning = false;
    const backoff = pollFailures ? Math.min(60_000, 3_000 * 2 ** pollFailures) : undefined;
    schedulePoll(backoff);
  }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const button = form.querySelector<HTMLButtonElement>("button")!; button.disabled = true; show($("login-error"), "");
  try { await api<{ ok: true }>("/api/admin/login", { method: "POST", body: JSON.stringify({ token: $<HTMLInputElement>("token").value, rememberSession: $<HTMLInputElement>("remember-session").checked }) }); await loadApp(); }
  catch (error) { handleError(error, $("login-error")); }
  finally { button.disabled = false; }
});
$("logout-button").addEventListener("click", async () => { try { await api("/api/admin/logout", { method: "POST" }); } finally { setAuthenticated(false); } });
$("refresh-button").addEventListener("click", () => refresh());
$("reply-form").addEventListener("submit", (event) => void submitReply(event as SubmitEvent));
$("status-button").addEventListener("click", toggleStatus);
$("block-button").addEventListener("click", toggleBlocked);
$("delete-button").addEventListener("click", confirmDelete);
$("reply").addEventListener("input", () => { if (state.selectedId) drafts.set(state.selectedId, $<HTMLTextAreaElement>("reply").value); });
$("back-button").addEventListener("click", () => { document.body.classList.remove("thread-open"); if (state.selectedId) $("conversation-list").querySelector<HTMLElement>(`[data-id="${CSS.escape(state.selectedId)}"]`)?.focus(); });
$("settings-button").addEventListener("click", () => {
  $<HTMLDialogElement>("settings-dialog").showModal();
  void loadTelegram();
});
$("install-widget-button").addEventListener("click", () => {
  $<HTMLDialogElement>("settings-dialog").showModal();
  $("snippet-title").scrollIntoView({ block: "start" });
  $<HTMLButtonElement>("copy-button").focus();
  void loadTelegram();
});
$("settings-close").addEventListener("click", () => $<HTMLDialogElement>("settings-dialog").close());
$("telegram-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $<HTMLButtonElement>("telegram-submit");
  const token = $<HTMLInputElement>("telegram-token");
  const operatorIds = $<HTMLInputElement>("telegram-operator-ids").value.split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
  if (button.disabled) return;
  button.disabled = true; button.textContent = "Connecting…";
  show($("telegram-error"), "");
  show($("telegram-status"), "Checking your bot, group permissions, and webhook. This may take up to a minute…");
  try {
    const connection = await api<TelegramConnection>("/api/admin/telegram", { method: "POST", body: JSON.stringify({
      botToken: token.value.trim(), chatId: $<HTMLInputElement>("telegram-chat-id").value.trim(), operatorIds,
    }), signal: AbortSignal.timeout(75_000) });
    token.value = "";
    renderTelegram(connection);
  } catch (error) {
    handleError(error, $("telegram-error"));
    if (!(error instanceof HttpError && error.status === 401)) {
      show($("telegram-status"), $("telegram-error").textContent || "Connection could not be completed.");
      $("telegram-error").scrollIntoView({ block: "nearest" });
    }
  }
  finally { button.disabled = false; if (button.textContent === "Connecting…") button.textContent = "Connect Telegram"; }
});
["widget-title", "widget-greeting", "widget-color", "widget-position", "widget-theme", "widget-style", "widget-font"].forEach(id => {
  $(id).addEventListener("input", renderEmbedSnippet);
  $(id).addEventListener("change", renderEmbedSnippet);
});
$("copy-button").addEventListener("click", async () => {
  const embed = $<HTMLTextAreaElement>("embed-code");
  try { await navigator.clipboard.writeText(embed.value); show($("copy-status"), "Copied"); }
  catch { embed.select(); show($("copy-status"), "Select the snippet and copy it manually."); }
});
$("notification-button").addEventListener("click", async () => {
  if (!("Notification" in window) || typeof Notification.requestPermission !== "function") return;
  try {
    if (notificationsEnabled) notificationsEnabled = false;
    else notificationsEnabled = await Notification.requestPermission() === "granted";
    try { localStorage.setItem("threadpost:notifications", notificationsEnabled ? "on" : "off"); } catch { /* Preference stays in memory. */ }
  } catch { notificationsEnabled = false; }
  renderNotificationButton(); schedulePoll(0);
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) schedulePoll(0); else schedulePoll(); });
window.addEventListener("focus", () => schedulePoll(0));
window.addEventListener("online", () => { pollFailures = 0; schedulePoll(0); });
window.addEventListener("offline", () => schedulePoll());
loadNotificationPreference();
loadApp();
