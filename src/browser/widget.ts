(function () {
  "use strict";

  interface Session { id: string; token: string }
  interface Conversation { id: string; status: "open" | "closed"; name?: string; createdAt?: string }
  interface Message {
    id: number;
    direction: "inbound" | "outbound";
    body: string;
    createdAt: string;
    deliveryStatus: "pending" | "sending" | "sent" | "failed" | "unknown";
  }
  interface ConversationCreated { id: string; token: string; status?: "open" | "closed" }
  interface ThreadResponse { conversation: Conversation; messages: Message[] }
  interface PendingMessage {
    body: string;
    clientMessageId: string;
    clientToken: string;
    phase: "create" | "send";
    failed: boolean;
    sending?: boolean;
  }
  class ApiError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
  }

  const currentScript = document.currentScript;
  if (!(currentScript instanceof HTMLScriptElement) || currentScript.dataset.threadpostMounted === "true") return;
  const script: HTMLScriptElement = currentScript;
  script.dataset.threadpostMounted = "true";

  if (!document.body) document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();

  function mount() {

  const siteId = (script.dataset.site || "").trim();
  if (!siteId) {
    console.error("Threadpost: widget script requires a data-site attribute.");
    return;
  }

  const title = (script.dataset.title || "Chat with us").trim() || "Chat with us";
  const greeting = (script.dataset.greeting || "Send a message and we’ll reply here.").trim() || "Send a message and we’ll reply here.";
  const color = /^#[0-9a-f]{6}$/i.test(script.dataset.color || "") ? script.dataset.color : undefined;
  const position = script.dataset.position === "left" ? "left" : "right";
  const apiBase = new URL(".", script.src).href.replace(/\/$/, "");
  const storageKey = `threadpost:${apiBase}:${siteId}`;
  const host = document.createElement("div");
  host.id = "threadpost-widget";
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    button, input, textarea { font: inherit; }
    .tp { --ink:#191713; --ivory:#fffaf0; --paper:#fffdf8; --orange:#e4572e; --accent-border:#a83b1c; --accent-bubble-border:#d24a25; --accent-hover:#c94721; --accent-foreground:white; --line:#d8d0c2; font: 15px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--ink); }
    .launcher { position:fixed; z-index:2147483000; right:20px; bottom:20px; min-height:52px; padding:0 19px; border:1px solid var(--accent-border); border-radius:999px; background:var(--orange); color:var(--accent-foreground); font-weight:750; cursor:pointer; box-shadow:0 12px 30px #20140726; }
    .launcher:hover { background:var(--accent-hover); }
    button:focus-visible, input:focus-visible, textarea:focus-visible { outline:3px solid #f4a261; outline-offset:2px; }
    .panel { position:fixed; z-index:2147483000; right:20px; bottom:84px; width:min(390px,calc(100vw - 24px)); height:min(610px,calc(100dvh - 108px)); display:grid; grid-template-rows:auto 1fr auto; overflow:hidden; border:1px solid var(--line); border-radius:18px; background:var(--paper); box-shadow:0 24px 70px #20140730; }
    .panel[hidden], .launcher[hidden] { display:none; }
    .head { display:flex; align-items:center; justify-content:space-between; padding:17px 18px; border-bottom:1px solid var(--line); background:var(--ivory); }
    .heading { margin:0; font:750 17px/1.2 ui-serif,Georgia,serif; }
    .close { width:36px; height:36px; border:0; border-radius:50%; background:transparent; color:var(--ink); font-size:24px; line-height:1; cursor:pointer; }
    .close:hover { background:#eee7da; }
    .messages { min-height:0; overflow-y:auto; padding:18px; display:flex; flex-direction:column; gap:12px; overscroll-behavior:contain; }
    .empty { margin:auto 10px; color:#625d55; text-align:center; }
    .message { max-width:84%; }
    .message.inbound { align-self:flex-end; }
    .message.outbound { align-self:flex-start; }
    .bubble { margin:0; padding:10px 13px; border:1px solid var(--line); border-radius:14px 14px 14px 4px; background:white; white-space:pre-wrap; overflow-wrap:anywhere; }
    .inbound .bubble { border-color:var(--accent-bubble-border); border-radius:14px 14px 4px 14px; background:var(--orange); color:var(--accent-foreground); }
    .meta { margin:4px 4px 0; color:#777168; font-size:11px; }
    .inbound .meta { text-align:right; }
    .retry { margin:5px 3px 0; padding:2px 0; border:0; border-bottom:1px solid currentColor; background:transparent; color:#a6381b; font-size:12px; cursor:pointer; }
    .composer { padding:14px; border-top:1px solid var(--line); background:var(--ivory); }
    .name { width:100%; margin:0 0 9px; padding:9px 11px; border:1px solid var(--line); border-radius:8px; background:white; color:var(--ink); }
    .compose-row { display:flex; align-items:flex-end; gap:8px; }
    textarea { display:block; min-width:0; width:100%; max-height:120px; resize:none; padding:10px 11px; border:1px solid var(--line); border-radius:10px; background:white; color:var(--ink); line-height:1.35; }
    .send { flex:0 0 auto; min-height:42px; padding:0 14px; border:1px solid var(--accent-border); border-radius:10px; background:var(--orange); color:var(--accent-foreground); font-weight:700; cursor:pointer; }
    .send:disabled { cursor:not-allowed; opacity:.55; }
    .error, .count { margin:7px 2px 0; font-size:12px; }
    .error { color:#a22818; }
    .count { color:#777168; text-align:right; }
    .closed { padding:15px; border-top:1px solid var(--line); background:var(--ivory); text-align:center; }
    .closed p { margin:0 0 10px; color:#625d55; }
    .new { padding:9px 13px; border:1px solid var(--ink); border-radius:8px; background:var(--ink); color:white; font-weight:700; cursor:pointer; }
    .tp[data-position="left"] .launcher { right:auto; left:20px; }
    .tp[data-position="left"] .panel { right:auto; left:20px; }
    @media (max-width:520px) {
      .launcher { right:12px; left:auto; bottom:12px; }
      .tp[data-position="left"] .launcher { right:auto; left:12px; bottom:12px; }
      .tp[data-position="left"] .panel, .panel { inset:0; width:100vw; height:100dvh; border:0; border-radius:0; }
      .head { padding-top:max(16px,env(safe-area-inset-top)); }
      .composer, .closed { padding-bottom:max(14px,env(safe-area-inset-bottom)); }
    }
    @media (prefers-reduced-motion:no-preference) { .panel { animation:tp-in .16s ease-out; } @keyframes tp-in { from { opacity:0; transform:translateY(8px); } } }
  `;
  root.appendChild(style);

  const wrap = el("div", "tp");
  wrap.dataset.position = position;
  if (color) {
    const rgb = parseHexColor(color);
    const foreground = relativeLuminance(rgb) > 0.179 ? "#000000" : "#ffffff";
    wrap.style.setProperty("--orange", color);
    wrap.style.setProperty("--accent-border", shade(rgb, 0.74));
    wrap.style.setProperty("--accent-bubble-border", shade(rgb, 0.92));
    wrap.style.setProperty("--accent-hover", shade(rgb, 0.88));
    wrap.style.setProperty("--accent-foreground", foreground);
  }
  const launcher = el("button", "launcher", title);
  launcher.type = "button";
  launcher.setAttribute("aria-expanded", "false");
  launcher.setAttribute("aria-controls", "threadpost-panel");
  const panel = el("section", "panel");
  panel.id = "threadpost-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-labelledby", "threadpost-title");
  const head = el("header", "head");
  const heading = el("h2", "heading", title);
  heading.id = "threadpost-title";
  const close = el("button", "close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close chat");
  head.append(heading, close);
  const messages = el("div", "messages");
  messages.setAttribute("role", "log");
  messages.setAttribute("aria-live", "polite");
  messages.setAttribute("aria-relevant", "additions text");
  const empty = el("p", "empty", greeting);
  messages.appendChild(empty);
  const composer = el("form", "composer");
  const nameInput = el("input", "name");
  nameInput.type = "text";
  nameInput.name = "name";
  nameInput.maxLength = 80;
  nameInput.autocomplete = "name";
  nameInput.placeholder = "Your name (optional)";
  nameInput.setAttribute("aria-label", "Your name (optional)");
  const row = el("div", "compose-row");
  const textarea = el("textarea");
  textarea.name = "message";
  textarea.rows = 1;
  textarea.maxLength = 2000;
  textarea.placeholder = "Write a message…";
  textarea.setAttribute("aria-label", "Message");
  const send = el("button", "send", "Send");
  send.type = "submit";
  const error = el("p", "error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const count = el("div", "count", "0 / 2000");
  row.append(textarea, send);
  composer.append(nameInput, row, error, count);
  const closed = el("div", "closed");
  closed.hidden = true;
  closed.appendChild(el("p", "", "This conversation is closed. Start a new one to get in touch."));
  const newButton = el("button", "new", "New conversation");
  newButton.type = "button";
  closed.appendChild(newButton);
  panel.append(head, messages, composer, closed);
  wrap.append(launcher, panel);
  root.appendChild(wrap);

  let session = readSession();
  let status: "open" | "closed" = "open";
  let pollTimer = 0;
  let polling = false;
  let pending: PendingMessage | null = null;

  nameInput.hidden = Boolean(session);
  launcher.addEventListener("click", openPanel);
  close.addEventListener("click", closePanel);
  newButton.addEventListener("click", newConversation);
  composer.addEventListener("submit", onSubmit);
  textarea.addEventListener("input", () => {
    count.textContent = `${textarea.value.length} / 2000`;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    clearError();
  });
  textarea.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  panel.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") closePanel();
  });
  document.addEventListener("visibilitychange", updatePolling);

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function parseHexColor(value: string): [number, number, number] {
    return [
      Number.parseInt(value.slice(1, 3), 16),
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16)
    ];
  }

  function relativeLuminance(rgb: [number, number, number]): number {
    const [red, green, blue] = rgb.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }

  function shade(rgb: [number, number, number], factor: number): string {
    return `#${rgb.map((channel) => Math.round(channel * factor).toString(16).padStart(2, "0")).join("")}`;
  }

  function readSession(): Session | null {
    try {
      const stored = localStorage.getItem(storageKey);
      if (!stored) return null;
      const value: unknown = JSON.parse(stored);
      if (!value || typeof value !== "object") return null;
      const candidate = value as Record<string, unknown>;
      return typeof candidate.id === "string" && typeof candidate.token === "string"
        ? { id: candidate.id, token: candidate.token }
        : null;
    } catch (_) {
      return null;
    }
  }

  function saveSession(value: Session): void {
    session = value;
    try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch (_) {}
  }

  function clearSession() {
    session = null;
    try { localStorage.removeItem(storageKey); } catch (_) {}
  }

  function openPanel() {
    panel.hidden = false;
    launcher.hidden = true;
    launcher.setAttribute("aria-expanded", "true");
    updatePolling();
    if (session) loadMessages();
    requestAnimationFrame(() => (session ? textarea : nameInput).focus());
  }

  function closePanel() {
    panel.hidden = true;
    launcher.hidden = false;
    launcher.setAttribute("aria-expanded", "false");
    updatePolling();
    launcher.focus();
  }

  function updatePolling() {
    window.clearTimeout(pollTimer);
    pollTimer = 0;
    if (!panel.hidden && !document.hidden && session && status === "open") {
      pollTimer = window.setTimeout(async () => {
        await loadMessages();
        updatePolling();
      }, 3000);
    }
  }

  async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${apiBase}${path}`, options);
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `Request failed (${response.status})`;
      throw new ApiError(response.status, message);
    }
    return data as T;
  }

  async function onSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const body = textarea.value.trim();
    if (!body || body.length > 2000 || pending || status === "closed") return;
    textarea.value = "";
    textarea.dispatchEvent(new Event("input"));
    const clientToken = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    pending = { body, clientMessageId: makeId(), clientToken, phase: session ? "send" : "create", failed: false };
    renderPending();
    await deliverPending();
  }

  async function deliverPending() {
    if (!pending || pending.sending) return;
    pending.sending = true;
    pending.failed = false;
    send.disabled = true;
    clearError();
    renderPending();
    try {
      if (!session) {
        const created = await api<ConversationCreated>("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteId, name: nameInput.value.trim() || undefined, clientToken: pending.clientToken })
        });
        saveSession({ id: created.id, token: created.token });
        status = created.status || "open";
        nameInput.hidden = true;
        pending.phase = "send";
      }
      const activeSession = session;
      if (!activeSession) throw new Error("Conversation session was not created.");
      const sent = await api<Message>(`/api/conversations/${encodeURIComponent(activeSession.id)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeSession.token}` },
        body: JSON.stringify({ body: pending.body, clientMessageId: pending.clientMessageId })
      });
      pending = null;
      renderMessages([sent]);
      await loadMessages();
    } catch (problem) {
      if (problem instanceof ApiError && (problem.status === 401 || problem.status === 404)) {
        clearSession();
        nameInput.hidden = false;
        if (pending) pending.phase = "create";
      }
      if (pending) {
        pending.failed = true;
        pending.sending = false;
      }
      showError(problem instanceof Error ? problem.message : "Could not send. Please try again.");
      renderPending();
    } finally {
      send.disabled = Boolean(pending);
      updatePolling();
    }
  }

  async function loadMessages() {
    if (!session || polling) return;
    const requestedSession = session;
    polling = true;
    try {
      const data = await api<ThreadResponse>(`/api/conversations/${encodeURIComponent(requestedSession.id)}/messages`, {
        headers: { Authorization: `Bearer ${requestedSession.token}` }
      });
      if (session !== requestedSession) return;
      status = data.conversation.status;
      renderMessages(data.messages || []);
      setClosed(status === "closed");
      clearError();
    } catch (problem) {
      if (session !== requestedSession) return;
      if (problem instanceof ApiError && (problem.status === 401 || problem.status === 404)) {
        clearSession();
        nameInput.hidden = false;
        showError("This chat session expired. Send a message to start again.");
      }
    } finally {
      polling = false;
    }
  }

  function renderMessages(list: Message[]): void {
    messages.replaceChildren();
    if (!list.length && !pending) messages.appendChild(empty);
    list.forEach((message) => messages.appendChild(messageNode(message)));
    if (pending) messages.appendChild(pendingNode());
    messages.scrollTop = messages.scrollHeight;
  }

  function messageNode(message: Message): HTMLElement {
    const item = el("article", `message ${message.direction === "outbound" ? "outbound" : "inbound"}`);
    item.appendChild(el("p", "bubble", String(message.body || "")));
    const state = message.deliveryStatus && message.deliveryStatus !== "sent" ? ` · ${message.deliveryStatus}` : "";
    item.appendChild(el("p", "meta", `${message.direction === "outbound" ? "Threadpost" : "You"}${state}`));
    return item;
  }

  function pendingNode(): HTMLElement {
    if (!pending) throw new Error("No pending message to render.");
    const item = el("article", "message inbound");
    item.dataset.pending = "true";
    item.appendChild(el("p", "bubble", pending.body));
    item.appendChild(el("p", "meta", pending.failed ? "Not sent" : "Sending…"));
    if (pending.failed) {
      const retry = el("button", "retry", "Try again");
      retry.type = "button";
      retry.addEventListener("click", deliverPending);
      item.appendChild(retry);
    }
    return item;
  }

  function renderPending() {
    const previous = messages.querySelector('[data-pending="true"]');
    if (previous) previous.remove();
    if (pending) messages.appendChild(pendingNode());
    messages.scrollTop = messages.scrollHeight;
  }

  function setClosed(isClosed: boolean): void {
    composer.hidden = isClosed;
    closed.hidden = !isClosed;
    if (isClosed) window.clearTimeout(pollTimer);
  }

  function newConversation() {
    clearSession();
    status = "open";
    pending = null;
    nameInput.value = "";
    nameInput.hidden = false;
    setClosed(false);
    renderMessages([]);
    clearError();
    nameInput.focus();
  }

  function showError(message: string): void {
    error.textContent = message;
    error.hidden = false;
  }

  function clearError() {
    error.textContent = "";
    error.hidden = true;
  }

  function makeId() {
    return globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  }
})();
