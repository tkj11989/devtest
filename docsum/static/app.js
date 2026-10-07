"use strict";

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- auth ----------
const TOKEN_KEY = "docsum_token";
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
let token = store.get(TOKEN_KEY);
let currentUser = null;

function setSession(newToken, user) {
  token = newToken;
  currentUser = user;
  store.set(TOKEN_KEY, newToken);
  $("#account").hidden = !user;
  $("#account-name").textContent = user ? (user.email || user.phone) : "";
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers });
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    setSession(null, null);
    location.hash = "#/login";
    throw new Error("Please log in again.");
  }
  if (!res.ok) throw new Error(body?.detail ? (typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail)) : `HTTP ${res.status}`);
  return body;
}
const postJSON = (path, data) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

function mount(tplId) {
  view.replaceChildren($(tplId).content.cloneNode(true));
}

function bind(data) {
  view.querySelectorAll("[data-bind]").forEach(el => { if (el.dataset.bind in data) el.textContent = data[el.dataset.bind]; });
  view.querySelectorAll("[data-bind-href]").forEach(el => { if (el.dataset.bindHref in data) el.href = data[el.dataset.bindHref]; });
}

const pages = (s, e) => (s === e ? `p. ${s}` : `pp. ${s}–${e}`);

// Minimal, safe markdown: paragraphs, "- " / "* " / "1." lists, **bold**.
function renderMarkdown(md) {
  const inline = t => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const out = [];
  let list = null;
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (m) {
      if (!list) { list = []; }
      list.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; }
    if (line) out.push(`<p>${inline(line.replace(/^#+\s*/, ""))}</p>`);
  }
  if (list) out.push(`<ul>${list.join("")}</ul>`);
  return out.join("");
}

// ---------- health ----------
async function loadHealth() {
  const el = $("#health");
  const dot = (ok, label, title) => `<span class="dot" style="background:var(${ok ? "--ok" : "--err"})"></span><span title="${esc(title)}">${esc(label)}</span>`;
  try {
    const h = await api("/api/health");
    const o = h.ollama;
    const llmOk = o.reachable && o.model_available;
    const embOk = o.reachable && o.embed_model_available;
    el.innerHTML =
      dot(llmOk, o.model || "LLM", o.reachable ? (llmOk ? "Ready" : `Run: ollama pull ${o.model}`) : `Ollama unreachable at ${o.url}`) +
      dot(embOk, "Embeddings", o.reachable ? (embOk ? o.embed_model : `Run: ollama pull ${o.embed_model}`) : "Ollama unreachable") +
      dot(h.tesseract, "OCR", h.tesseract ? "Tesseract found" : "Tesseract not installed — scanned files will fail");
  } catch {
    el.textContent = "Server unreachable";
  }
}

// ---------- Q&A panel ----------
function mountQA(container, docId, scopeLabel) {
  container.replaceChildren($("#tpl-qa").content.cloneNode(true));
  $("[data-bind=scope]", container).textContent = scopeLabel;
  const log = $(".qa-log", container);
  const form = $(".qa-form", container);
  const input = form.elements.q;
  const btn = $("button", form);

  form.addEventListener("submit", async ev => {
    ev.preventDefault();
    const question = input.value.trim();
    if (!question) return;
    input.value = "";
    log.insertAdjacentHTML("beforeend", `<div class="qa-msg user">${esc(question)}</div>`);
    const pending = document.createElement("div");
    pending.className = "qa-msg";
    pending.innerHTML = `<span class="spinner"></span>Searching documents and asking the model…`;
    log.append(pending);
    btn.disabled = true;
    try {
      const res = await postJSON("/api/qa", { question, doc_id: docId || null });
      const sources = res.sources.map(s => `
        <details><summary>[${s.n}] ${esc(s.filename)} — ${esc(s.section_title)} (${pages(s.page_start, s.page_end)})</summary>
          <div class="excerpt">${esc(s.text)}</div>
          <a href="#/doc/${encodeURIComponent(s.doc_id)}">Open document sections</a>
        </details>`).join("");
      pending.innerHTML = `${esc(res.answer)}${sources ? `<div class="sources"><strong>Sources</strong>${sources}</div>` : ""}`;
    } catch (err) {
      pending.classList.add("error");
      pending.textContent = err.message;
    } finally {
      btn.disabled = false;
      input.focus();
    }
  });
}

// ---------- Login ----------
function renderLogin() {
  mount("#tpl-login");
  const step1 = $("#login-step1"), step2 = $("#login-step2"), status = $("#login-status");
  const resend = $("#resend");
  let identifier = "", timer = null;

  const show = (msg, error = false) => {
    status.hidden = !msg;
    status.className = error ? "status error" : "status";
    status.textContent = msg || "";
  };
  const cooldown = secs => {
    clearInterval(timer);
    resend.disabled = true;
    let left = secs;
    const tick = () => {
      resend.textContent = left > 0 ? `Resend code (${left}s)` : "Resend code";
      if (left-- <= 0) { clearInterval(timer); resend.disabled = false; }
    };
    tick();
    timer = setInterval(tick, 1000);
  };
  const send = async () => {
    show("Sending code…");
    try {
      const res = await postJSON("/api/auth/request-otp", { identifier });
      $("#sent-to").textContent = res.identifier;
      step1.hidden = true;
      step2.hidden = false;
      show("");
      cooldown(res.resend_after);
      $("#code").focus();
    } catch (err) { show(err.message, true); }
  };

  step1.addEventListener("submit", e => { e.preventDefault(); identifier = step1.elements.identifier.value.trim(); send(); });
  resend.addEventListener("click", send);
  $("#change").addEventListener("click", () => { step2.hidden = true; step1.hidden = false; show(""); clearInterval(timer); });
  step2.addEventListener("submit", async e => {
    e.preventDefault();
    show("Verifying…");
    try {
      const res = await postJSON("/api/auth/verify-otp", { identifier, code: step2.elements.code.value.trim() });
      clearInterval(timer);
      setSession(res.token, res.user);
      location.hash = "#/";
    } catch (err) { show(err.message, true); step2.elements.code.select(); }
  });
  step1.elements.identifier.focus();
}

// ---------- Home ----------
async function renderHome() {
  mount("#tpl-home");
  mountQA($("#qa-home"), null, "(across all documents)");

  const input = $("#file");
  const zone = $("#dropzone");
  const status = $("#upload-status");

  const upload = async file => {
    if (!file) return;
    status.hidden = false;
    status.className = "status";
    status.innerHTML = `<span class="spinner"></span>Uploading <b>${esc(file.name)}</b> — running OCR, detecting sections and indexing. Large or scanned files can take a while…`;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const doc = await api("/api/documents", { method: "POST", body: fd });
      location.hash = `#/doc/${doc.id}`;
    } catch (err) {
      status.className = "status error";
      status.textContent = `Upload failed: ${err.message}`;
    }
  };

  input.addEventListener("change", () => upload(input.files[0]));
  zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", e => { e.preventDefault(); zone.classList.remove("over"); upload(e.dataTransfer.files[0]); });

  const list = $("#doc-list");
  try {
    const docs = await api("/api/documents");
    if (!docs.length) { list.innerHTML = `<p class="muted">No documents yet.</p>`; return; }
    list.innerHTML = docs.map(d => `
      <div class="doc">
        <div>
          <a class="name" href="#/doc/${d.id}">${esc(d.filename)}</a>
          <div class="muted small">${d.section_count} sections · ${d.pages} page(s)${d.ocr_pages ? ` · ${d.ocr_pages} OCR'd` : ""} · ${new Date(d.created_at).toLocaleString()}</div>
        </div>
        <div class="row">
          <a class="btn small" href="#/doc/${d.id}">Open</a>
          <button class="btn small danger" data-del="${d.id}">Delete</button>
        </div>
      </div>`).join("");
    list.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this document and its RAG data?")) return;
      await api(`/api/documents/${b.dataset.del}`, { method: "DELETE" });
      renderHome();
    }));
  } catch (err) {
    list.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}

// ---------- Sections ----------
const selection = {}; // docId -> Set of section ids (kept while navigating back from preview)

async function renderSections(docId) {
  mount("#tpl-sections");
  let doc;
  try { doc = await api(`/api/documents/${docId}`); }
  catch (err) { view.innerHTML = `<div class="card status error">${esc(err.message)} — <a href="#/">Home</a></div>`; return; }

  bind({
    filename: doc.filename,
    stats: `${doc.sections.length} sections · ${doc.pages} page(s)${doc.ocr_pages ? ` · ${doc.ocr_pages} page(s) OCR'd` : ""} · ${doc.chunks} chunks in RAG DB`,
  });
  mountQA($("#qa-doc"), docId, "(this document)");

  const selected = selection[docId] ??= new Set();
  const styleSel = $("#style");
  styleSel.value = sessionStorage.getItem("style") || "brief";
  styleSel.addEventListener("change", () => sessionStorage.setItem("style", styleSel.value));

  const list = $("#section-list");
  list.innerHTML = doc.sections.map(s => `
    <li data-id="${s.id}">
      <label>
        <input type="checkbox" value="${s.id}">
        <div>
          <div class="section-title">${esc(s.title)}</div>
          <div class="muted small">${pages(s.page_start, s.page_end)} · ${s.word_count} words</div>
          <div class="small">${esc(s.preview)}</div>
        </div>
      </label>
      <button class="btn ghost small" data-view="${s.id}">View full text</button>
      <div class="section-text" hidden></div>
    </li>`).join("");

  const btn = $("#summarize");
  const sync = () => {
    list.querySelectorAll("li").forEach(li => {
      const on = selected.has(li.dataset.id);
      li.classList.toggle("selected", on);
      $("input", li).checked = on;
    });
    btn.disabled = selected.size === 0;
    btn.textContent = `Summarize selected (${selected.size})`;
  };
  list.addEventListener("change", e => {
    if (e.target.type !== "checkbox") return;
    e.target.checked ? selected.add(e.target.value) : selected.delete(e.target.value);
    sync();
  });
  list.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", async () => {
    const box = b.nextElementSibling;
    if (!box.hidden) { box.hidden = true; b.textContent = "View full text"; return; }
    if (!box.textContent) box.textContent = (await api(`/api/documents/${docId}/sections/${b.dataset.view}`)).text;
    box.hidden = false;
    b.textContent = "Hide text";
  }));
  $("#select-all").addEventListener("click", () => { doc.sections.forEach(s => selected.add(s.id)); sync(); });
  $("#select-none").addEventListener("click", () => { selected.clear(); sync(); });
  btn.addEventListener("click", () => {
    const order = doc.sections.map(s => s.id).filter(id => selected.has(id));
    location.hash = `#/doc/${docId}/summary?ids=${order.join(",")}&style=${styleSel.value}`;
  });
  sync();
}

// ---------- Preview ----------
async function renderPreview(docId, params, refresh = false) {
  mount("#tpl-preview");
  const ids = (params.get("ids") || "").split(",").filter(Boolean);
  const style = params.get("style") || "brief";
  const sectionsHref = `#/doc/${docId}`;
  if (!ids.length) { location.hash = sectionsHref; return; }

  let doc;
  try { doc = await api(`/api/documents/${docId}`); }
  catch (err) { view.innerHTML = `<div class="card status error">${esc(err.message)} — <a href="#/">Home</a></div>`; return; }
  const titles = Object.fromEntries(doc.sections.map(s => [s.id, s]));
  bind({ filename: doc.filename, sections: sectionsHref, stats: `${ids.length} section(s) · style: ${style} · model runs locally via Ollama` });

  const box = $("#summaries");
  box.innerHTML = ids.map(id => `
    <article class="summary" id="sum-${esc(id)}">
      <h3>${esc(titles[id]?.title ?? id)}</h3>
      <div class="muted small">${titles[id] ? pages(titles[id].page_start, titles[id].page_end) : ""}</div>
      <div class="body muted"><span class="spinner"></span>Waiting…</div>
    </article>`).join("");

  const results = [];
  const token = location.hash;
  // One request per section so the user sees progress as each summary arrives.
  for (const id of ids) {
    if (location.hash !== token) return; // user navigated away
    const body = $(`#sum-${CSS.escape(id)} .body`);
    body.innerHTML = `<span class="spinner"></span>Summarizing with Qwen…`;
    try {
      const res = await postJSON(`/api/documents/${docId}/summarize`, { section_ids: [id], style, refresh });
      const s = res.summaries[0];
      results.push(s);
      body.className = "body";
      body.innerHTML = renderMarkdown(s.summary);
    } catch (err) {
      body.className = "body status error";
      body.textContent = err.message;
    }
  }
  if (location.hash !== token) return;

  const markdown = `# Summary: ${doc.filename}\n\n` + results.map(s => `## ${s.title}\n\n${s.summary}\n`).join("\n");
  const copy = $("#copy"), dl = $("#download"), regen = $("#regenerate");
  [copy, dl, regen].forEach(b => (b.disabled = false));
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(markdown);
    copy.textContent = "Copied ✓";
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  });
  dl.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
    a.download = doc.filename.replace(/\.[^.]+$/, "") + "-summary.md";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  regen.addEventListener("click", () => renderPreview(docId, params, true));
}

// ---------- router ----------
function route() {
  const [path, query = ""] = location.hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  window.scrollTo(0, 0);
  if (!token) return parts[0] === "login" ? renderLogin() : (location.hash = "#/login");
  if (parts[0] === "login") return (location.hash = "#/");
  if (parts[0] === "doc" && parts[1] && parts[2] === "summary") return renderPreview(parts[1], new URLSearchParams(query));
  if (parts[0] === "doc" && parts[1]) return renderSections(parts[1]);
  return renderHome();
}

$("#logout").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* already logged out */ }
  setSession(null, null);
  location.hash = "#/login";
});

window.addEventListener("hashchange", route);
loadHealth();
(async () => {
  if (token) {
    try { setSession(token, await api("/api/auth/me")); }
    catch { setSession(null, null); }
  }
  route();
})();
