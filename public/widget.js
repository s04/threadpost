(function () {
  "use strict";

  const script = document.currentScript;
  if (!script || script.dataset.threadpostMounted === "true") return;
  script.dataset.threadpostMounted = "true";

  const siteId = (script.dataset.site || "").trim();
  if (!siteId) {
    console.error("Threadpost: widget script requires a data-site attribute.");
    return;
  }

  const title = (script.dataset.title || "Chat with us").trim() || "Chat with us";
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
    .tp { --ink:#191713; --ivory:#fffaf0; --paper:#fffdf8; --orange:#e4572e; --line:#d8d0c2; font: 15px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--ink); }
    .launcher { position:fixed; z-index:2147483000; right:20px; bottom:20px; min-height:52px; padding:0 19px; border:1px solid #a83b1c; border-radius:999px; background:var(--orange); color:white; font-weight:750; cursor:pointer; box-shadow:0 12px 30px #20140726; }
    .launcher:hover { background:#c94721; }
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
    .inbound .bubble { border-color:#d24a25; border-radius:14px 14px 4px 14px; background:var(--orange); color:white; }
    .meta { margin:4px 4px 0; color:#777168; font-size:11px; }
    .inbound .meta { text-align:right; }
    .retry { margin:5px 3px 0; padding:2px 0; border:0; border-bottom:1px solid currentColor; background:transparent; color:#a6381b; font-size:12px; cursor:pointer; }
    .composer { padding:14px; border-top:1px solid var(--line); background:var(--ivory); }
    .name { width:100%; margin:0 0 9px; padding:9px 11px; border:1px solid var(--line); border-radius:8px; background:white; color:var(--ink); }
    .compose-row { display:flex; align-items:flex-end; gap:8px; }
    textarea { display:block; min-width:0; width:100%; max-height:120px; resize:none; padding:10px 11px; border:1px solid var(--line); border-radius:10px; background:white; color:var(--ink); line-height:1.35; }
    .send { flex:0 0 auto; min-height:42px; padding:0 14px; border:1px solid #a83b1c; border-radius:10px; background:var(--orange); color:white; font-weight:700; cursor:pointer; }
    .send:disabled { cursor:not-allowed; opacity:.55; }
    .error, .count { margin:7px 2px 0; font-size:12px; }
    .error { color:#a22818; }
    .count { color:#777168; text-align:right; }
    .closed { padding:15px; border-top:1px solid var(--line); background:var(--ivory); text-align:center; }
    .closed p { margin:0 0 10px; color:#625d55; }
    .new { padding:9px 13px; border:1px solid var(--ink); border-radius:8px; background:var(--ink); color:white; font-weight:700; cursor:pointer; }
    @media (max-width:520px) {
      .launcher { right:12px; bottom:12px; }
      .panel { inset:0; width:100vw; height:100dvh; border:0; border-radius:0; }
      .head { padding-top:max(16px,env(safe-area-inset-top)); }
      .composer, .closed { padding-bottom:max(14px,env(safe-area-inset-bottom)); }
    }
    @media (prefers-reduced-motion:no-preference) { .panel { animation:tp-in .16s ease-out; } @keyframes tp-in { from { opacity:0; transform:translateY(8px); } } }
  `;
  root.appendChild(style);

  const wrap = el("div", "tp");
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
  const empty = el("p", "empty", "Send a message and we’ll reply here.");
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
  let status = "open";
  let pollTimer = 0;
  let polling = false;
  let pending = null;

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
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanel();
  });
  document.addEventListener("visibilitychange", updatePolling);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function readSession() {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey));
      return value && typeof value.id === "string" && typeof value.token === "string" ? value : null;
    } catch (_) {
      return null;
    }
  }

  function saveSession(value) {
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

  async function api(path, options) {
    const response = await fetch(`${apiBase}${path}`, options);
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      const problem = new Error(data && data.error ? data.error : `Request failed (${response.status})`);
      problem.status = response.status;
      throw problem;
    }
    return data;
  }

  async function onSubmit(event) {
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
        const created = await api("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteId, name: nameInput.value.trim() || undefined, clientToken: pending.clientToken })
        });
        saveSession({ id: created.id, token: created.token });
        status = created.status || "open";
        nameInput.hidden = true;
        pending.phase = "send";
      }
      const sent = await api(`/api/conversations/${encodeURIComponent(session.id)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ body: pending.body, clientMessageId: pending.clientMessageId })
      });
      pending = null;
      renderMessages([sent]);
      await loadMessages();
    } catch (problem) {
      if (problem.status === 401 || problem.status === 404) {
        clearSession();
        nameInput.hidden = false;
        if (pending) pending.phase = "create";
      }
      if (pending) {
        pending.failed = true;
        pending.sending = false;
      }
      showError(problem.message || "Could not send. Please try again.");
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
      const data = await api(`/api/conversations/${encodeURIComponent(requestedSession.id)}/messages`, {
        headers: { Authorization: `Bearer ${requestedSession.token}` }
      });
      if (session !== requestedSession) return;
      status = data.conversation.status;
      renderMessages(data.messages || []);
      setClosed(status === "closed");
      clearError();
    } catch (problem) {
      if (session !== requestedSession) return;
      if (problem.status === 401 || problem.status === 404) {
        clearSession();
        nameInput.hidden = false;
        showError("This chat session expired. Send a message to start again.");
      }
    } finally {
      polling = false;
    }
  }

  function renderMessages(list) {
    messages.replaceChildren();
    if (!list.length && !pending) messages.appendChild(empty);
    list.forEach((message) => messages.appendChild(messageNode(message)));
    if (pending) messages.appendChild(pendingNode());
    messages.scrollTop = messages.scrollHeight;
  }

  function messageNode(message) {
    const item = el("article", `message ${message.direction === "outbound" ? "outbound" : "inbound"}`);
    item.appendChild(el("p", "bubble", String(message.body || "")));
    const state = message.deliveryStatus && message.deliveryStatus !== "sent" ? ` · ${message.deliveryStatus}` : "";
    item.appendChild(el("p", "meta", `${message.direction === "outbound" ? "Threadpost" : "You"}${state}`));
    return item;
  }

  function pendingNode() {
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

  function setClosed(isClosed) {
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

  function showError(message) {
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
})();
