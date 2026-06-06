const STORAGE_KEY = "adhdLauncherV1";
const LLM_ENDPOINT = "/api/llm/chat";

const els = {
  taskInput: document.getElementById("taskInput"),
  steps: document.getElementById("steps"),
  bubble: document.getElementById("bubble"),
  meterBar: document.getElementById("meterBar"),
  progressText: document.getElementById("progressText"),
  progressPct: document.getElementById("progressPct"),
  apiMode: document.getElementById("apiMode"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  apiKey: document.getElementById("apiKey"),
  apiModel: document.getElementById("apiModel"),
  aiNotes: document.getElementById("aiNotes"),
  settingsHint: document.getElementById("settingsHint"),
  toast: document.querySelector(".toast"),
  confetti: document.getElementById("confetti"),
};

let state = loadState();
let toastTimer = null;
let notesSeq = 0;

boot();

function boot() {
  els.taskInput.value = state.taskText ?? "";
  hydrateSettingsUI();
  render();
  wire();
  registerServiceWorker();
  maybeGenerateAiNotes();
  if (!state.steps || state.steps.length === 0) {
    setBubble(pickMessage("idle"));
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (location.protocol !== "https:" && !isLocalhost) return;
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
}

function wire() {
  document.addEventListener("click", (e) => {
    const actionEl = e.target.closest("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === "generate") onGenerate();
    if (action === "example") onExample();
    if (action === "reset") onReset();
    if (action === "add-step") onAddStep();
    if (action === "clear-done") onClearDone();
    if (action === "save-settings") onSaveSettings();
  });

  if (els.apiMode) {
    els.apiMode.addEventListener("change", () => {
      const v = String(els.apiMode.value || "proxy");
      setSettingsHint(v === "proxy" ? "Proxy needs a local server. / 代理模式需要本地服务。" : "Direct may hit CORS. / 直连可能被 CORS 拦住。");
    });
  }

  els.taskInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      onGenerate();
    }
  });

  els.steps.addEventListener("click", (e) => {
    const checkBtn = e.target.closest('[data-step-action="toggle"]');
    if (checkBtn) {
      const id = checkBtn.dataset.stepId;
      toggleStep(id);
      return;
    }

    const delBtn = e.target.closest('[data-step-action="delete"]');
    if (delBtn) {
      const id = delBtn.dataset.stepId;
      deleteStep(id);
      return;
    }

    const editEl = e.target.closest('[data-step-action="edit"]');
    if (editEl) return;

    const li = e.target.closest("li.step");
    if (!li) return;
    const id = li.dataset.stepId;
    if (!id) return;
    toggleExpandStep(id);
  });

  els.steps.addEventListener("input", (e) => {
    const input = e.target.closest('[data-step-action="edit"]');
    if (!input) return;
    const id = input.dataset.stepId;
    const next = String(input.value ?? "");
    updateStepText(id, next);
  });

  els.steps.addEventListener("keydown", (e) => {
    const input = e.target.closest('[data-step-action="edit"]');
    if (!input) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      onAddStep(input.dataset.stepId);
    }
  });
}

function onGenerate() {
  const text = String(els.taskInput.value ?? "").trim();
  if (!text) {
    toast("Type one thing. 就写一件事就行。");
    setBubble(pickMessage("need_input"));
    return;
  }

  state.taskText = text;
  const tryAi = shouldUseAi(state.settings);
  if (!tryAi) return generateWithLocal(text);

  setBubble("Asking AI… / 正在问 AI…");
  generateAtomicSteps(text, { mode: "deepseek" })
    .then((stepsText) => setStepsFromTexts(stepsText, { source: "ai" }))
    .catch(() => generateWithLocal(text, { aiFailed: true }));
}

function onExample() {
  els.taskInput.value = "我要从床上去阳台浇花";
  onGenerate();
}

function onReset() {
  state = { taskText: "", steps: [], settings: state.settings ?? defaultSettings() };
  saveState();
  els.taskInput.value = "";
  render();
  toast(pickMessage("reset"));
  setBubble(pickMessage("idle"));
}

function generateWithLocal(text, { aiFailed } = {}) {
  if (aiFailed) toast("AI failed, using local rules. / AI 失败，先用本地拆解。");
  setBubble(pickMessage("start"));
  generateAtomicSteps(text, { mode: "local" })
    .then((stepsText) => setStepsFromTexts(stepsText, { source: "local" }))
    .catch((err) => {
      toast(String(err?.message || "Failed to generate steps"));
      setBubble(pickMessage("need_input"));
    });
}

function setStepsFromTexts(stepsText, { source } = {}) {
  const items = normalizeStepItems(stepsText);
  const packed = items
    .map((x) => ({
      text: decorateStepText(x.text, state.taskText),
      notes: normalizeNoteLines(x.notes),
    }))
    .filter((x) => String(x.text ?? "").trim().length > 0);
  state.steps = packed.map((x) => ({
    id: makeId(),
    text: x.text,
    done: false,
    notes: x.notes,
    children: [],
    expanded: false,
    generating: false,
  }));
  saveState();
  render();
  if (source === "ai") toast("AI done ✨ / AI 拆解完成");
  else toast(pickMessage("generated"));
  setBubble(pickMessage("start"));

  maybeGenerateAiNotes();
}

function onSaveSettings() {
  const next = {
    mode: String(els.apiMode?.value ?? "proxy"),
    baseUrl: String(els.apiBaseUrl?.value ?? "").trim(),
    apiKey: String(els.apiKey?.value ?? "").trim(),
    model: String(els.apiModel?.value ?? "").trim() || "deepseek-chat",
    aiNotes: Boolean(els.aiNotes?.checked),
  };
  state.settings = next;
  saveState();
  setSettingsHint("Saved. / 已保存。");
  toast("Saved ✅ / 已保存");
  maybeGenerateAiNotes();
}

function hydrateSettingsUI() {
  const s = state.settings ?? defaultSettings();
  state.settings = s;
  if (els.apiMode) els.apiMode.value = s.mode;
  if (els.apiBaseUrl) els.apiBaseUrl.value = s.baseUrl;
  if (els.apiKey) els.apiKey.value = s.apiKey;
  if (els.apiModel) els.apiModel.value = s.model;
  if (els.aiNotes) els.aiNotes.checked = Boolean(s.aiNotes);
  setSettingsHint(s.mode === "proxy" ? "Proxy needs a local server. / 代理模式需要本地服务。" : "Direct may hit CORS. / 直连可能被 CORS 拦住。");
}

function setSettingsHint(text) {
  if (!els.settingsHint) return;
  els.settingsHint.textContent = text;
}

function makeStep({ id, text, done, notes, children, expanded, generating } = {}) {
  return {
    id: typeof id === "string" && id ? id : makeId(),
    text: typeof text === "string" ? text : "",
    done: Boolean(done),
    notes: normalizeNoteLines(notes),
    children: Array.isArray(children) ? children : [],
    expanded: Boolean(expanded),
    generating: Boolean(generating),
  };
}

function countSteps(steps) {
  const arr = Array.isArray(steps) ? steps : [];
  let n = 0;
  for (const s of arr) {
    n += 1;
    if (Array.isArray(s.children) && s.children.length > 0) n += countSteps(s.children);
  }
  return n;
}

function findStepLocation(steps, id, parents = []) {
  const arr = Array.isArray(steps) ? steps : [];
  for (let i = 0; i < arr.length; i += 1) {
    const s = arr[i];
    if (s && s.id === id) return { array: arr, index: i, step: s, parents };
    if (s && Array.isArray(s.children) && s.children.length > 0) {
      const hit = findStepLocation(s.children, id, parents.concat([s]));
      if (hit) return hit;
    }
  }
  return null;
}

function findStepWithParents(steps, id) {
  const loc = findStepLocation(steps, id, []);
  if (!loc) return null;
  return { step: loc.step, parents: loc.parents };
}

function removeStepById(steps, id) {
  const loc = findStepLocation(steps, id, []);
  if (!loc) return false;
  loc.array.splice(loc.index, 1);
  return true;
}

function clearDoneSteps(steps) {
  const arr = Array.isArray(steps) ? steps : [];
  const kept = [];
  for (const s of arr) {
    if (!s || s.done) continue;
    const next = { ...s };
    if (Array.isArray(next.children) && next.children.length > 0) next.children = clearDoneSteps(next.children);
    kept.push(next);
  }
  return kept;
}

function setDoneRecursive(step, done) {
  if (!step) return;
  step.done = Boolean(done);
  if (Array.isArray(step.children) && step.children.length > 0) {
    for (const c of step.children) setDoneRecursive(c, done);
  }
}

function syncDoneFromChildren(step) {
  if (!step || !Array.isArray(step.children) || step.children.length === 0) return;
  step.done = step.children.every((c) => Boolean(c.done));
}

function syncAllParents(steps) {
  const arr = Array.isArray(steps) ? steps : [];
  for (const s of arr) {
    if (!s) continue;
    if (Array.isArray(s.children) && s.children.length > 0) {
      syncAllParents(s.children);
      syncDoneFromChildren(s);
    }
  }
}

function getLeafSteps(steps) {
  const arr = Array.isArray(steps) ? steps : [];
  const leaves = [];
  for (const s of arr) {
    if (!s) continue;
    if (Array.isArray(s.children) && s.children.length > 0) leaves.push(...getLeafSteps(s.children));
    else leaves.push(s);
  }
  return leaves;
}

function onAddStep(afterId) {
  if (!Array.isArray(state.steps)) state.steps = [];
  const next = makeStep({ text: "" });
  const loc = afterId ? findStepLocation(state.steps, afterId) : null;
  if (loc) loc.array.splice(loc.index + 1, 0, next);
  else state.steps.push(next);
  saveState();
  render({ focusId: next.id });
  toast(pickMessage("add_step"));
}

function onClearDone() {
  if (!Array.isArray(state.steps)) state.steps = [];
  const before = countSteps(state.steps);
  state.steps = clearDoneSteps(state.steps);
  syncAllParents(state.steps);
  saveState();
  render();
  const removed = before - countSteps(state.steps);
  toast(removed > 0 ? `Cleared ${removed}. 清掉啦。` : pickMessage("nothing_to_clear"));
}

function toggleStep(id) {
  const hit = findStepWithParents(state.steps ?? [], id);
  if (!hit) return;
  const { step, parents } = hit;
  const nextDone = !Boolean(step.done);
  if (Array.isArray(step.children) && step.children.length > 0) {
    setDoneRecursive(step, nextDone);
  } else {
    step.done = nextDone;
  }

  for (let i = parents.length - 1; i >= 0; i -= 1) {
    syncDoneFromChildren(parents[i]);
  }
  saveState();
  render();
  const { doneCount, total, pct } = getProgress(state.steps);
  if (total > 0 && doneCount === total) {
    toast(pickMessage("done_all"));
    setBubble(pickMessage("done_all"));
    launchConfetti();
    return;
  }
  if (nextDone) {
    toast(pickMessage(pct < 0.34 ? "done_early" : pct < 0.75 ? "done_mid" : "done_late"));
    setBubble(pickMessage(pct < 0.34 ? "done_early" : pct < 0.75 ? "done_mid" : "done_late"));
  } else {
    toast(pickMessage("undo"));
    setBubble(pickMessage("undo"));
  }
}

function deleteStep(id) {
  if (!Array.isArray(state.steps)) state.steps = [];
  const removed = removeStepById(state.steps, id);
  if (!removed) return;
  syncAllParents(state.steps);
  saveState();
  render();
  toast(pickMessage("deleted"));
  if (countSteps(state.steps) === 0) setBubble(pickMessage("idle"));
}

function updateStepText(id, text) {
  const hit = findStepWithParents(state.steps ?? [], id);
  if (!hit) return;
  const step = hit.step;
  step.text = decorateStepText(text, state.taskText);
  saveState();
  render({ silent: true });
}

function toggleExpandStep(id) {
  const hit = findStepWithParents(state.steps ?? [], id);
  if (!hit) return;
  const step = hit.step;

  if (Array.isArray(step.children) && step.children.length > 0) {
    step.expanded = !Boolean(step.expanded);
    saveState();
    render({ silent: true });
    return;
  }

  if (step.generating) return;
  const plain = stripEmoji(String(step.text ?? "")).trim();
  if (!plain) return;

  step.generating = true;
  saveState();
  render({ silent: true });
  setBubble("Splitting… / 细化中…");

  generateSubSteps(plain, state.taskText)
    .then((subSteps) => {
      const items = normalizeStepItems(subSteps);
      const packed = items
        .map((x) => ({ text: decorateStepText(x.text, `${state.taskText ?? ""} ${plain}`), notes: normalizeNoteLines(x.notes) }))
        .filter((x) => String(x.text ?? "").trim().length > 0)
        .slice(0, 12);
      if (packed.length === 0) throw new Error("Empty sub steps");
      step.children = packed.map((x) => makeStep({ text: x.text, notes: x.notes }));
      step.expanded = true;
      step.generating = false;
      syncDoneFromChildren(step);
      saveState();
      render();
      toast("Sub-list ready ✨ / 子清单生成");
      setBubble(pickMessage("start"));
      maybeGenerateAiNotes();
      return;
    })
    .catch((err) => {
      const fallback = generateSubStepsLocal(plain, state.taskText);
      const items = normalizeStepItems(fallback);
      const packed = items
        .map((x) => ({ text: decorateStepText(x.text, `${state.taskText ?? ""} ${plain}`), notes: normalizeNoteLines(x.notes) }))
        .filter((x) => String(x.text ?? "").trim().length > 0)
        .slice(0, 12);
      if (packed.length > 0) {
        step.children = packed.map((x) => makeStep({ text: x.text, notes: x.notes }));
        step.expanded = true;
        step.generating = false;
        syncDoneFromChildren(step);
        saveState();
        render();
        toast("AI split failed, local split ok. / AI 细化失败，已用本地细化");
        setBubble(pickMessage("start"));
        maybeGenerateAiNotes();
        return;
      }

      step.generating = false;
      saveState();
      render({ silent: true });
      toast(String(err?.message || "Failed to split"));
      setBubble("Split failed. / 细化失败。");
    });
}

function renderSteps(steps, container, depth) {
  const arr = Array.isArray(steps) ? steps : [];
  for (const step of arr) {
    const li = document.createElement("li");
    li.className = [
      "step",
      depth === 0 ? "is-parent" : "is-child",
      step.done ? "is-done" : "",
      step.generating ? "is-generating" : "",
    ]
      .filter(Boolean)
      .join(" ");
    li.dataset.stepId = step.id;

    const check = document.createElement("button");
    check.type = "button";
    check.className = "step-check";
    check.dataset.stepAction = "toggle";
    check.dataset.stepId = step.id;
    check.setAttribute("aria-label", step.done ? "标记为未完成" : "标记为已完成");
    check.setAttribute("aria-pressed", step.done ? "true" : "false");

    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = "✓";
    check.appendChild(tick);

    const input = document.createElement("input");
    input.className = "step-text";
    input.type = "text";
    input.placeholder = "写一个更小的动作 / one tiny action";
    input.value = String(step.text ?? "");
    input.dataset.stepAction = "edit";
    input.dataset.stepId = step.id;

    const sub = document.createElement("div");
    sub.className = "step-sub";
    const lines = normalizeNoteLines(step.notes);
    const finalLines = lines.length > 0 ? lines : describeStepLines(String(step.text ?? ""), String(state.taskText ?? ""));
    for (const line of finalLines) {
      const div = document.createElement("div");
      div.textContent = line;
      sub.appendChild(div);
    }

    const main = document.createElement("div");
    main.className = "step-main";
    main.dataset.stepAction = "toggle-expand";
    main.dataset.stepId = step.id;
    main.appendChild(input);
    main.appendChild(sub);

    const meta = document.createElement("div");
    meta.className = "step-meta";

    const hasChildren = Array.isArray(step.children) && step.children.length > 0;
    if (hasChildren && step.expanded) {
      const leaf = getLeafSteps(step.children);
      const total = leaf.length;
      const doneCount = leaf.reduce((acc, s) => acc + (s.done ? 1 : 0), 0);
      const pct = total === 0 ? 0 : doneCount / total;

      const prog = document.createElement("div");
      prog.className = "step-progress";
      prog.setAttribute("aria-label", `子任务进度 ${doneCount}/${total}`);

      const bar = document.createElement("div");
      bar.className = "step-progress-bar";
      const fill = document.createElement("div");
      fill.className = "step-progress-fill";
      fill.style.width = `${Math.round(pct * 100)}%`;
      bar.appendChild(fill);

      const label = document.createElement("div");
      label.className = "step-progress-text";
      label.textContent = `${doneCount}/${total}`;

      prog.appendChild(bar);
      prog.appendChild(label);
      meta.appendChild(prog);
    }

    const chevron = document.createElement("div");
    chevron.className = hasChildren ? (step.expanded ? "step-chevron is-open" : "step-chevron") : "step-chevron is-empty";
    chevron.textContent = "›";
    chevron.setAttribute("aria-hidden", "true");
    meta.appendChild(chevron);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "mini-btn";
    del.textContent = "×";
    del.dataset.stepAction = "delete";
    del.dataset.stepId = step.id;
    del.setAttribute("aria-label", "删除这一步");
    meta.appendChild(del);

    li.appendChild(check);
    li.appendChild(main);
    li.appendChild(meta);

    if (hasChildren && step.expanded) {
      const subList = document.createElement("ol");
      subList.className = "substeps";
      renderSteps(step.children, subList, depth + 1);
      li.appendChild(subList);
    }

    container.appendChild(li);
  }
}

function render(opts = {}) {
  const { silent = false, focusId } = opts;
  const steps = Array.isArray(state.steps) ? state.steps : [];

  els.steps.innerHTML = "";
  renderSteps(steps, els.steps, 0);

  const { doneCount, total, pct } = getProgress(steps);
  els.progressText.textContent = `${doneCount} / ${total}`;
  els.progressPct.textContent = `${Math.round(pct * 100)}%`;
  els.meterBar.style.width = `${Math.round(pct * 100)}%`;

  if (!silent && total > 0) {
    if (doneCount === 0) setBubble(pickMessage("start"));
    if (doneCount > 0 && doneCount < total) {
      setBubble(pickMessage(pct < 0.34 ? "mid_early" : pct < 0.75 ? "mid_mid" : "mid_late"));
    }
  }

  if (focusId) {
    const el = els.steps.querySelector(`[data-step-action="edit"][data-step-id="${cssEscape(focusId)}"]`);
    if (el) el.focus();
  }
}

function setBubble(text) {
  els.bubble.textContent = text;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-show");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => els.toast.classList.remove("is-show"), 2200);
}

function launchConfetti() {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#ff4fb3", "#43a4ff", "#19c37d", "#ffbe2e"];
  const count = 28;
  for (let i = 0; i < count; i += 1) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.setProperty("--x", `${(Math.random() - 0.5) * 240}px`);
    piece.style.animationDelay = `${Math.random() * 160}ms`;
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    piece.addEventListener(
      "animationend",
      () => {
        if (piece.parentNode) piece.parentNode.removeChild(piece);
      },
      { once: true },
    );
    els.confetti.appendChild(piece);
  }
}

async function generateAtomicSteps(text, { mode } = {}) {
  const m = mode ?? "local";
  if (m === "local") return generateAtomicStepsLocal(text);
  if (m === "deepseek") return generateAtomicStepsDeepseek(text);
  throw new Error("Unknown mode");
}

async function generateAtomicStepsDeepseek(text) {
  const s = state.settings ?? defaultSettings();
  const payload = {
    model: s.model || "deepseek-chat",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "把用户任务拆成3到8条原子步骤。输出严格JSON数组。每个元素为对象：{ \"text\": \"步骤\", \"note\": [\"说明1\",\"说明2\",\"说明3\"] }。note为2到3条灰色小字，鼓励但具体，不要空泛，不要markdown。",
      },
      { role: "user", content: String(text ?? "") },
    ],
  };

  const { url, headers, body } = buildDeepseekRequest({ payload, settings: s });
  const res = await fetch(url, { method: "POST", headers, body });

  const rawText = await res.text();
  if (!res.ok) {
    const msg = rawText || `HTTP ${res.status}`;
    throw new Error(`LLM request failed: ${msg}`);
  }

  const data = rawText ? safeJsonParse(rawText) : null;
  const content =
    data?.choices?.[0]?.message?.content ??
    data?.output_text ??
    data?.text ??
    data?.content ??
    (typeof data === "string" ? data : "");

  const items = parseStepItemsFromText(content);
  const stepTexts = items.map((x) => x.text).filter(Boolean);
  if (stepTexts.length === 0) throw new Error("LLM returned empty steps");
  const usable = ensureUsable(stepTexts, text);
  const merged = usable.map((t) => items.find((x) => normalizeKey(x.text) === normalizeKey(t)) ?? { text: t, notes: [] });
  return merged;
}

function buildDeepseekRequest({ payload, settings }) {
  const mode = String(settings?.mode ?? "proxy");
  if (mode === "direct") {
    const apiKey = String(settings?.apiKey ?? "").trim();
    if (!apiKey) throw new Error("Missing API key");
    const url = resolveChatCompletionsUrl(settings?.baseUrl);
    return {
      url,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    };
  }

  const url = LLM_ENDPOINT;
  const body = JSON.stringify({
    ...payload,
    apiKey: String(settings?.apiKey ?? "").trim(),
    baseUrl: String(settings?.baseUrl ?? "").trim(),
  });
  return { url, headers: { "Content-Type": "application/json" }, body };
}

function resolveChatCompletionsUrl(baseUrl) {
  const raw = String(baseUrl ?? "").trim() || "https://api.deepseek.com";
  if (/\/chat\/completions$/i.test(raw)) return raw;
  const u = raw.replace(/\/+$/g, "");
  if (/\/v1$/i.test(u)) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}

function generateAtomicStepsLocal(text) {
  const raw = normalizeText(text);
  const pattern = patternFromToAction(raw);
  if (pattern) return ensureUsable(pattern, raw);

  const templ = templateFromHint(raw);
  if (templ) return ensureUsable(templ, raw);

  const parts = splitByConnectors(raw);
  const cleaned = parts.map(toImperative).filter(Boolean);
  return ensureUsable(cleaned, raw);
}

function normalizeText(text) {
  return String(text ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[。！？!?]+/g, "。")
    .replace(/^我(想|要|准备)?\s*/u, "")
    .replace(/^要\s*/u, "");
}

function splitByConnectors(text) {
  const byPunc = text
    .split(/[。;；\n]+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (const p of byPunc) {
    const parts = p
      .split(/(?:然后|再|并且|同时|之后|最后|接着|同时)/g)
      .map((s) => s.trim())
      .filter(Boolean);
    out.push(...parts);
  }
  return out;
}

function toImperative(s) {
  return String(s ?? "")
    .trim()
    .replace(/^我(想|要|准备)?/u, "")
    .replace(/^(先|再|然后|接着|之后|最后)\s*/u, "")
    .replace(/^去\s*/u, "")
    .replace(/^把\s*/u, "把")
    .trim();
}

function patternFromToAction(text) {
  const t = String(text ?? "").trim();
  const m = t.match(/^从(.+?)去(.+)$/u);
  if (!m) return null;
  const from = String(m[1] ?? "").trim();
  const rest = String(m[2] ?? "").trim();
  const split = splitPlaceAndAction(rest);
  const to = split.place;
  const action = split.action;

  const steps = [];
  if (/[床]/u.test(from)) steps.push("从床上坐起来");
  else steps.push(`离开${from}`);

  const tools = guessToolSteps(action);
  steps.push(...tools);
  if (to) steps.push(`走到${to}`);
  steps.push(normalizeAction(action));
  return steps;
}

function splitPlaceAndAction(rest) {
  const s = String(rest ?? "").trim();
  const verbs = ["浇", "倒", "扔", "洗", "刷", "写", "发", "整理", "收拾", "拖", "扫", "擦", "装", "拿", "取", "带", "买"];
  const idx = verbs
    .map((v) => s.indexOf(v))
    .filter((i) => i >= 0)
    .reduce((min, i) => (min === -1 ? i : Math.min(min, i)), -1);

  if (idx <= 0) return { place: s, action: "" };
  return { place: s.slice(0, idx).trim(), action: s.slice(idx).trim() };
}

function normalizeAction(action) {
  const a = String(action ?? "").trim();
  const cleaned = a.replace(/^做/u, "").replace(/^去/u, "").trim();
  if (/(浇.*花|浇花|给.*花浇水|浇水)/u.test(cleaned)) return "把水浇到花盆里";
  if (/(倒|扔).*垃圾|倒垃圾/u.test(cleaned)) return "把垃圾扔进垃圾桶";
  return cleaned || "完成它";
}

function guessToolSteps(action) {
  const a = String(action ?? "");
  if (/(浇.*花|浇花|给.*花浇水|浇水)/u.test(a)) return ["去拿喷壶/水壶", "去水龙头装水"];
  if (/(倒|扔).*垃圾|倒垃圾/u.test(a)) return ["去拿垃圾袋"];
  if (/(洗|刷).*碗|洗碗/u.test(a)) return ["把碗放到水池旁", "挤一点洗洁精到海绵上"];
  if (/(写|发).*邮件/u.test(a)) return ["打开电脑", "打开邮箱/邮件客户端"];
  if (/(收拾|整理).*桌/u.test(a)) return ["拿一个收纳盒放在桌边"];
  return [];
}

function ensureUsable(steps, hintText) {
  const cleaned = (steps ?? [])
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .filter((s, i, arr) => arr.indexOf(s) === i);

  const hint = String(hintText ?? "").trim();
  let out = cleaned;

  if (out.length <= 1 && hint) {
    const templ = templateFromHint(hint);
    if (templ) out = templ;
  }

  if (out.length === 0) out = fallbackTemplate(hint);

  if (out.length < 3) {
    out = [...fallbackTemplate(hint), ...out];
    out = out.filter((s, i, arr) => arr.indexOf(s) === i);
  }

  if (out.length > 8) {
    out = [...out.slice(0, 7), "完成剩余小步骤"];
  }

  return out.slice(0, 8);
}

function fallbackTemplate(hintText) {
  const tool = guessToolFromHint(hintText);
  const place = guessPlaceFromHint(hintText);
  return [
    "停 3 秒，深呼吸一次",
    "坐直/站起来",
    tool || "去拿一件关键工具（例：水壶/垃圾袋/电脑）",
    place || "走到要做这件事的地方",
    "做最小的一步",
  ];
}

function templateFromHint(hintText) {
  const t = String(hintText ?? "").trim();
  if (!t) return null;

  if (/(浇.*花|浇花|给.*花浇水|浇水)/u.test(t)) {
    const place = guessPlaceFromHint(t);
    const out = ["从床上坐起来", "去拿喷壶/水壶", "去水龙头装水", place || "走到花旁边", "把水浇到花盆里"];
    return out.filter((s, i, arr) => arr.indexOf(s) === i);
  }

  if (/(倒|扔).*垃圾|倒垃圾/u.test(t)) {
    return ["去拿垃圾袋", "把垃圾装进垃圾袋", "提着垃圾走到垃圾桶", "把垃圾扔进垃圾桶", "洗手"];
  }

  if (/(洗|刷).*碗|洗碗/u.test(t)) {
    return ["把碗放到水池旁", "打开水龙头冲一下碗", "挤一点洗洁精到海绵上", "刷 3 个碗/一小部分", "把泡沫冲干净"];
  }

  if (/(写|发).*邮件/u.test(t)) {
    return ["打开电脑", "打开邮箱/邮件客户端", "写下邮件主题（先随便写）", "写 2 句正文", "点击发送"];
  }

  return null;
}

function guessToolFromHint(hintText) {
  const t = String(hintText ?? "");
  if (/(浇.*花|浇花|给.*花浇水|浇水|花)/u.test(t)) return "去拿喷壶/水壶";
  if (/(倒|扔).*垃圾|垃圾/u.test(t)) return "去拿垃圾袋";
  if (/(洗|刷).*碗|碗/u.test(t)) return "去拿海绵/洗洁精";
  if (/(写|发).*邮件|邮件/u.test(t)) return "打开电脑";
  if (/快递|取件/u.test(t)) return "拿上手机和钥匙";
  return "";
}

function guessPlaceFromHint(hintText) {
  const t = String(hintText ?? "");
  const m = t.match(/去(.+?)(浇|倒|扔|洗|刷|写|发|整理|收拾)/u);
  if (m && m[1]) return `走到${String(m[1]).trim()}`;
  if (/阳台/u.test(t)) return "走到阳台";
  if (/厨房/u.test(t)) return "走到厨房";
  if (/门口/u.test(t)) return "走到门口";
  return "";
}

function shouldUseAi(settings) {
  const s = settings ?? defaultSettings();
  if (String(s.mode ?? "proxy") === "direct") return Boolean(String(s.apiKey ?? "").trim());
  return true;
}

function decorateSteps(steps, taskText) {
  return (steps ?? []).map((s) => decorateStepText(String(s ?? ""), taskText)).filter(Boolean);
}

function decorateStepText(stepText, taskText) {
  const s = String(stepText ?? "").trim();
  if (!s) return "";
  if (/^(?:`{3}|json\b)/iu.test(s)) return "";

  const base = stripEmoji(s);
  const emoji = pickStepEmoji(base, taskText);
  return `${emoji} ${base}`;
}

function describeStepLines(stepText, taskText) {
  const s = String(stepText ?? "").trim();
  const plain = stripEmoji(s);
  const t = `${taskText ?? ""} ${plain}`;

  const lines = [];
  if (/(停 3 秒|深呼吸)/u.test(plain)) {
    lines.push("先让大脑知道：你已经开始了。");
    lines.push("只做 1 次呼吸就够了。");
  } else if (/(坐直|站起来|坐起来|起床)/u.test(t)) {
    lines.push("这是“启动动作”，不需要有动力。");
    lines.push("身体一动，下一步会更容易。");
  } else if (/(去拿|拿起|拿上|取|带上)/u.test(t)) {
    lines.push("目标很小：把东西拿到手里。");
    lines.push("拿到就停一下，别急着连做。");
  } else if (/(装水|水龙头|接水)/u.test(t)) {
    lines.push("装到够用就行，不用满。");
    lines.push("如果卡住：先把水龙头打开。");
  } else if (/(走到|去到|到阳台|到厨房|到门口|走去)/u.test(t)) {
    lines.push("走到就算赢。");
    lines.push("到了以后只做下一小步。");
  } else if (/(浇花|浇水|花盆)/u.test(t)) {
    lines.push("浇一点点就行。");
    lines.push("想停也可以：先浇 3 秒。");
  } else if (/(倒垃圾|扔垃圾|垃圾桶)/u.test(t)) {
    lines.push("把袋子提起来就成功一半。");
    lines.push("剩下就是一次投篮。");
  } else if (/(洗碗|刷碗|水池)/u.test(t)) {
    lines.push("只洗 1 个也算完成。");
    lines.push("做小范围：刷 10 秒。");
  } else if (/(写邮件|发邮件|发送|邮箱)/u.test(t)) {
    lines.push("先写 2 句就行。");
    lines.push("不完美也能发送。");
  } else {
    lines.push("只要把这一格做完就行。");
    lines.push("完成后给自己一个 ✅。");
  }

  if (isBigStep(plain)) lines.push("太大就点 ↳ 生成子清单，把它再拆小。");
  return lines.slice(0, 3);
}

function isBigStep(plain) {
  const s = String(plain ?? "").trim();
  if (s.length >= 14) return true;
  if (/[\/]/u.test(s)) return true;
  if (/(直到|完成剩余|所有|全部|整理|收拾|重复)/u.test(s)) return true;
  return false;
}

function stripEmoji(text) {
  return String(text ?? "").trim().replace(/^\p{Extended_Pictographic}\s*/u, "");
}

function normalizeKey(text) {
  return stripEmoji(String(text ?? ""))
    .trim()
    .replace(/\s+/g, "")
    .replace(/[。.!！？?，,、；;:"'“”‘’]/g, "")
    .toLowerCase();
}

function normalizeNoteLines(notes) {
  if (Array.isArray(notes)) {
    return notes
      .map((x) => String(x ?? "").trim())
      .filter(Boolean)
      .slice(0, 3);
  }
  const s = String(notes ?? "").trim();
  if (!s) return [];
  return s
    .split(/\r?\n/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .flatMap((x) => x.split(/[。；;]+/g).map((y) => y.trim()))
    .filter(Boolean)
    .slice(0, 3);
}

function normalizeStepItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((x) => {
      if (typeof x === "string") return { text: x, notes: [] };
      if (!x || typeof x !== "object") return { text: String(x ?? ""), notes: [] };
      const text = String(x.text ?? x.step ?? x.title ?? x.name ?? "").trim();
      const notes = x.note ?? x.notes ?? x.desc ?? x.description ?? [];
      return { text, notes: normalizeNoteLines(notes) };
    })
    .filter((x) => String(x.text ?? "").trim().length > 0);
}

function parseJsonFromText(content) {
  let s = String(content ?? "").trim();
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
  if (fence && fence[1]) s = String(fence[1]).trim();

  const direct = safeJsonParse(s);
  if (direct != null) return direct;

  const arrayMatch = s.match(/\[[\s\S]*\]/u);
  if (arrayMatch && arrayMatch[0]) {
    const arr = safeJsonParse(arrayMatch[0]);
    if (arr != null) return arr;
  }

  const objMatch = s.match(/\{[\s\S]*\}/u);
  if (objMatch && objMatch[0]) {
    const obj = safeJsonParse(objMatch[0]);
    if (obj != null) return obj;
  }
  return null;
}

function parseStepItemsFromText(content) {
  const json = parseJsonFromText(content);
  if (Array.isArray(json)) return normalizeStepItems(json);
  return normalizeStepItems(parseStepsFromText(content));
}

function shouldUseAiNotes(settings) {
  const s = settings ?? defaultSettings();
  return Boolean(s.aiNotes) && shouldUseAi(s);
}

function maybeGenerateAiNotes() {
  if (!shouldUseAiNotes(state.settings)) return;
  const steps = Array.isArray(state.steps) ? state.steps : [];
  if (steps.length === 0) return;
  const need = steps.some((s) => normalizeNoteLines(s.notes).length < 2);
  if (!need) return;

  const seq = ++notesSeq;
  const texts = steps.map((s) => stripEmoji(String(s.text ?? "")));
  generateNotesForStepsAi(texts, state.taskText, state.settings)
    .then((notesList) => {
      if (seq !== notesSeq) return;
      if (!Array.isArray(notesList) || notesList.length !== steps.length) return;
      state.steps = steps.map((s, i) => ({ ...s, notes: normalizeNoteLines(notesList[i]) }));
      saveState();
      render({ silent: true });
    })
    .catch(() => {});
}

async function generateNotesForStepsAi(stepTexts, taskText, settings) {
  const s = settings ?? defaultSettings();
  const payload = {
    model: s.model || "deepseek-chat",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "你为每个步骤写2到3条灰色小字说明：更具体、更可执行、温柔但不空泛。只输出严格JSON数组，长度与输入步骤一致；每个元素是字符串数组（2到3条）。不要markdown。",
      },
      {
        role: "user",
        content: JSON.stringify({ task: String(taskText ?? ""), steps: stepTexts.map((x) => String(x ?? "")) }),
      },
    ],
  };

  const { url, headers, body } = buildDeepseekRequest({ payload, settings: s });
  const res = await fetch(url, { method: "POST", headers, body });
  const rawText = await res.text();
  if (!res.ok) throw new Error(rawText || `HTTP ${res.status}`);
  const data = rawText ? safeJsonParse(rawText) : null;
  const content =
    data?.choices?.[0]?.message?.content ??
    data?.output_text ??
    data?.text ??
    data?.content ??
    (typeof data === "string" ? data : "");

  const json = parseJsonFromText(content);
  if (!Array.isArray(json)) throw new Error("Invalid notes json");
  return json.map((x) => (Array.isArray(x) ? x : typeof x === "string" ? [x] : []));
}

function pickStepEmoji(stepText, taskText) {
  const base = String(stepText ?? "").trim();
  const t = `${taskText ?? ""} ${base}`;

  if (/(站起来|站起|起身)/u.test(base)) return "\u{1F9CD}";
  if (/(走到|走去|去到|出发|往.*走|继续走|走\s*\d+|走 \d+|走)/u.test(base)) return "\u{1F6B6}";
  if (/(坐下|坐到|坐在|坐稳)/u.test(base)) return "🪑";
  if (/(停 3 秒|深呼吸)/u.test(base)) return "\u{1FAE7}";
  if (/(床|起床|坐起来)/u.test(t)) return "🛏️";
  if (/(吃饭|吃|咀嚼|吞咽|食物|筷子|勺子)/u.test(t)) return "🍚";
  if (/(喷壶|水壶|水龙头|装水|接水)/u.test(t)) return "🚰";
  if (/(浇花|浇水|花盆|植物|花)/u.test(t)) return "🌿";
  if (/(垃圾袋|垃圾桶|倒垃圾|扔垃圾)/u.test(t)) return "🗑️";
  if (/(洗碗|水池|洗洁精|海绵)/u.test(t)) return "🧽";
  if (/(电脑|开机|打开电脑)/u.test(t)) return "💻";
  if (/(邮箱|邮件|发送)/u.test(t)) return "📮";
  if (/(手机|电话|消息)/u.test(t)) return "📱";
  if (/(钥匙|门口|出门|快递|取件)/u.test(t)) return "🗝️";
  if (/(拿起|拿上|取|带上)/u.test(t)) return "🖐️";
  if (/(打开|启动)/u.test(t)) return "🟢";
  if (/(写|记录)/u.test(t)) return "✍️";
  return "✨";
}

async function generateSubSteps(stepPlain, taskText) {
  const s = state.settings ?? defaultSettings();
  const shouldAi = shouldUseAi(s);
  if (!shouldAi) return generateSubStepsLocal(stepPlain, taskText);

  const prompt = `把这一步再拆成3到6条更小、可立刻执行的动作。每条动作尽量具体（例如“去拿喷壶”，不要写“准备需要的东西”）。输出严格JSON数组；每个元素为对象：{ "text": "步骤", "note": ["说明1","说明2","说明3"] }。note为2到3条灰色小字，具体、可执行。不要markdown。一步：${stepPlain}`;
  const payload = {
    model: s.model || "deepseek-chat",
    temperature: 0.2,
    messages: [
      { role: "system", content: "你是一个善于把任务拆成原子步骤的助手。输出严格JSON数组。不要markdown。" },
      { role: "user", content: prompt },
    ],
  };

  const { url, headers, body } = buildDeepseekRequest({ payload, settings: s });
  const res = await fetch(url, { method: "POST", headers, body });
  const rawText = await res.text();
  if (!res.ok) throw new Error(rawText || `HTTP ${res.status}`);
  const data = rawText ? safeJsonParse(rawText) : null;
  const content =
    data?.choices?.[0]?.message?.content ??
    data?.output_text ??
    data?.text ??
    data?.content ??
    (typeof data === "string" ? data : "");
  const items = parseStepItemsFromText(content);
  const texts = items.map((x) => x.text).filter(Boolean);
  const usable = ensureUsable(texts, `${taskText ?? ""} ${stepPlain}`).slice(0, 6);
  const merged = usable.map((t) => items.find((x) => normalizeKey(x.text) === normalizeKey(t)) ?? { text: t, notes: [] });
  return merged;
}

function generateSubStepsLocal(stepPlain, taskText) {
  const s = String(stepPlain ?? "").trim();
  const t = `${taskText ?? ""} ${s}`;

  if (/(喷壶|水壶)/u.test(t) && /(拿|去拿|取)/u.test(s)) return ["找到喷壶/水壶放在哪里", "走过去", "把喷壶/水壶拿到手里"];
  if (/(水龙头|装水|接水)/u.test(t)) return ["走到水龙头旁", "打开水龙头", "把喷壶/水壶装到够用", "关掉水龙头"];
  if (/(走到阳台|走到厨房|走到门口|走到)/u.test(s)) return ["站起来", "往目标方向走 10 步", "继续走到目的地"];
  if (/(坐下|坐到|坐在)/u.test(t)) return ["把椅子往后拉一点", "慢慢坐下去", "把脚放稳在地上"];
  if (/(把水浇到花盆里|浇花|浇水)/u.test(t)) return ["把喷壶举到花盆上方", "浇 3 秒", "看一眼土湿了就停"];
  if (/(倒垃圾|扔垃圾)/u.test(t)) return ["把垃圾装进垃圾袋", "系一下袋口", "走到垃圾桶", "把垃圾扔进去"];
  if (/(写邮件|发邮件)/u.test(t)) return ["打开邮箱", "写下主题（先随便写）", "写 2 句正文", "点击发送"];
  if (/(吃饭|吃)/u.test(t)) return ["走到餐桌前坐下", "拿起筷子或勺子", "吃一口", "再吃一口"];

  const base = [s].filter(Boolean);
  const fallback = generateAtomicStepsLocal(`${taskText ?? ""} ${s}`) || base;
  return ensureUsable(fallback, `${taskText ?? ""} ${s}`).slice(0, 6);
}

function parseStepsFromText(content) {
  let s = String(content ?? "").trim();
  if (!s) return [];

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
  if (fence && fence[1]) s = String(fence[1]).trim();

  const asJson = safeJsonParse(s);
  if (Array.isArray(asJson)) return asJson.map((x) => String(x ?? "").trim()).filter(Boolean);
  if (typeof asJson === "string") {
    const inner = safeJsonParse(asJson);
    if (Array.isArray(inner)) return inner.map((x) => String(x ?? "").trim()).filter(Boolean);
    s = asJson;
  }

  const arrayMatch = s.match(/\[[\s\S]*\]/u);
  if (arrayMatch && arrayMatch[0]) {
    const arr = safeJsonParse(arrayMatch[0]);
    if (Array.isArray(arr)) return arr.map((x) => String(x ?? "").trim()).filter(Boolean);
  }

  const lines = s
    .split(/\r?\n/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !/^(?:`{3}|json\b)/iu.test(x))
    .map((x) => x.replace(/^\d+\s*[.)、\-]\s*/u, "").trim())
    .filter(Boolean);

  if (lines.length >= 2) return lines;

  const byPunc = s
    .split(/[。;；]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
  return byPunc;
}

function repairLegacySteps(steps, taskText) {
  const list = Array.isArray(steps) ? steps : [];
  if (list.length === 0) return [];

  const hasFence = list.some((x) => /```/u.test(String(x.text ?? "")));
  const hasJsonArray = list.some((x) => /^\s*(?:\[|"\[)/u.test(String(x.text ?? "")));
  if (!hasFence && !hasJsonArray) return list;

  const merged = list.map((x) => String(x.text ?? "")).join("\n");
  const parsed = parseStepsFromText(merged);
  if (parsed.length >= 2) {
    const decorated = decorateSteps(parsed, taskText);
    return decorated.map((t) => ({ id: makeId(), text: t, done: false }));
  }
  return list;
}

function getProgress(steps) {
  const leaf = getLeafSteps(steps);
  const total = leaf.length;
  const doneCount = leaf.reduce((acc, s) => acc + (s.done ? 1 : 0), 0);
  const pct = total === 0 ? 0 : doneCount / total;
  return { total, doneCount, pct };
}

function pickMessage(key) {
  const pool = {
    idle: [
      "Pick one thing. Just one. 🧩 / 先选一件事就行。",
      "Tiny start, big win. ✨ / 小开始就是大胜利。",
      "No pressure. We do one step. 🫶 / 不急，我们只做一步。",
    ],
    need_input: [
      "One sentence is enough. ✍️ / 一句话就够了。",
      "Give me a task, I’ll break it down. 🔧 / 说一句，我来拆。",
    ],
    generated: ["Steps ready. Let’s go. 🎯 / 清单好了，开动。", "Quest list spawned. 🧙 / 任务列表生成！"],
    start: ["Start with the smallest click. 🟣 / 从最小的一个勾开始。", "One tap. One step. 🫧 / 点一下，就算开始。"],
    mid_early: ["Nice momentum. 🌿 / 节奏起来了。", "Good start. Keep it tiny. 🫶 / 开头很好，继续小步。"],
    mid_mid: ["You’re doing it. 🔥 / 你正在做到。", "Halfway vibes. 🌓 / 走到一半啦。"],
    mid_late: ["Almost there. 🏁 / 快到了。", "Just a little more. 🍬 / 再一点点。"],
    done_early: ["Nice! Next one. ✨ / 好！下一步。", "Clean hit. 🎯 / 命中一格。"],
    done_mid: ["Solid! Keep rolling. 🛼 / 很稳，继续滚动。", "Let’s gooo. 🚀 / 冲冲冲。"],
    done_late: ["So close!! 🥺 / 就差一点啦！", "Finish line energy. ⚡ / 终点能量！"],
    done_all: ["You did it!! 🎉 / 完成啦！", "Quest cleared. 🏆 / 任务通关！"],
    undo: ["No worries. 🫶 / 没关系。", "We can re-do it. 🔁 / 重新来一下也行。"],
    deleted: ["Poof. Gone. 💨 / 已删除。", "Removed. 🧹 / 删掉啦。"],
    add_step: ["Added one more. ➕ / 加了一步。", "New step unlocked. 🗝️ / 新步骤解锁！"],
    nothing_to_clear: ["Nothing to clear. 😌 / 没有可清理的。", "Already clean. ✨ / 已经很干净啦。"],
    reset: ["Reset done. Fresh start. 🧼 / 重置完成，重新开始。", "New run. 🎮 / 新的一局。"],
  };

  const arr = pool[key] ?? pool.idle;
  return arr[Math.floor(Math.random() * arr.length)];
}

function normalizeLoadedSteps(rawSteps, taskText, depth = 0) {
  if (depth >= 4) return [];
  const arr = Array.isArray(rawSteps) ? rawSteps : [];
  const out = [];
  for (const raw of arr.slice(0, depth === 0 ? 80 : 40)) {
    const text = typeof raw?.text === "string" ? raw.text : "";
    const node = makeStep({
      id: typeof raw?.id === "string" ? raw.id : makeId(),
      text: decorateStepText(stripEmoji(text), taskText),
      done: Boolean(raw?.done),
      notes: normalizeNoteLines(raw?.notes),
      expanded: Boolean(raw?.expanded),
      generating: false,
    });
    const children = normalizeLoadedSteps(raw?.children, taskText, depth + 1);
    node.children = children;
    syncDoneFromChildren(node);
    out.push(node);
  }
  return out;
}

function serializeSteps(steps, depth = 0) {
  if (depth >= 4) return [];
  const arr = Array.isArray(steps) ? steps : [];
  return arr.slice(0, depth === 0 ? 80 : 40).map((s) => ({
    id: s.id,
    text: String(s.text ?? ""),
    done: Boolean(s.done),
    notes: normalizeNoteLines(s.notes),
    expanded: Boolean(s.expanded),
    children: Array.isArray(s.children) && s.children.length > 0 ? serializeSteps(s.children, depth + 1) : [],
  }));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { taskText: "", steps: [], settings: defaultSettings() };
    const parsed = JSON.parse(raw);
    const taskText = typeof parsed.taskText === "string" ? parsed.taskText : "";
    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const hasChildren = rawSteps.some((s) => Array.isArray(s?.children) && s.children.length > 0);
    const repairedFlat = hasChildren
      ? rawSteps
      : repairLegacySteps(
          rawSteps.map((s) => ({
            id: typeof s?.id === "string" ? s.id : makeId(),
            text: typeof s?.text === "string" ? s.text : "",
            done: Boolean(s?.done),
            notes: normalizeNoteLines(s?.notes),
          })),
          taskText,
        );
    const normalized = normalizeLoadedSteps(repairedFlat, taskText, 0);
    const settingsRaw = parsed?.settings ?? {};
    const settings = {
      mode: String(settingsRaw.mode ?? "proxy") === "direct" ? "direct" : "proxy",
      baseUrl: typeof settingsRaw.baseUrl === "string" ? settingsRaw.baseUrl : defaultSettings().baseUrl,
      apiKey: typeof settingsRaw.apiKey === "string" ? settingsRaw.apiKey : "",
      model: typeof settingsRaw.model === "string" ? settingsRaw.model : defaultSettings().model,
      aiNotes: Boolean(settingsRaw.aiNotes ?? defaultSettings().aiNotes),
    };
    return { taskText, steps: normalized, settings };
  } catch (e) {
    return { taskText: "", steps: [], settings: defaultSettings() };
  }
}

function saveState() {
  const payload = {
    taskText: String(state.taskText ?? ""),
    steps: serializeSteps(state.steps, 0),
    settings: {
      mode: String(state.settings?.mode ?? "proxy") === "direct" ? "direct" : "proxy",
      baseUrl: String(state.settings?.baseUrl ?? ""),
      apiKey: String(state.settings?.apiKey ?? ""),
      model: String(state.settings?.model ?? "deepseek-chat"),
      aiNotes: Boolean(state.settings?.aiNotes),
    },
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function defaultSettings() {
  return { mode: "proxy", baseUrl: "https://api.deepseek.com", apiKey: "", model: "deepseek-chat", aiNotes: true };
}

function makeId() {
  return `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

function cssEscape(v) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(v);
  return String(v).replace(/["\\]/g, "\\$&");
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

