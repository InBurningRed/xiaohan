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
  if (!state.steps || state.steps.length === 0) setBubble(pickMessage("idle"));
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

  state.steps = packed.map((x) =>
    makeStep({
      text: x.text,
      done: false,
      notes: x.notes,
      children: [],
      expanded: false,
      generating: false,
    }),
  );
  saveState();
  render();
  if (source === "ai") toast("AI done ✨ / AI 拆解完成");
  else toast(pickMessage("generated"));
  setBubble(pickMessage("start"));
  maybeGenerateAiNotes();
}

function onSaveSettings() {
  const next = {
    mode: String(els.apiMode?.value ?? "proxy") === "direct" ? "direct" : "proxy",
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
    if (!s) continue;
    n += 1;
    if (Array.isArray(s.children) && s.children.length > 0) n += countSteps(s.children);
  }
  return n;
}

function findStepLocation(steps, id, parents = []) {
  const arr = Array.isArray(steps) ? steps : [];
  for (let i = 0; i < arr.length; i += 1) {
    const s = arr[i];
    if (!s) continue;
    if (s.id === id) return { array: arr, index: i, step: s, parents };
    if (Array.isArray(s.children) && s.children.length > 0) {
      const hit = findStepLocation(s.children, id, parents.concat([s]));
      if (hit) return hit;
    }
  }
  return null;
}

function findStepWithParents(steps, id) {
  const loc = findStepLocation(steps, id, []);
  if (!loc) return null;
  return { step: loc.step, parents: loc.parents, array: loc.array, index: loc.index };
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
  if (Array.isArray(step.children) && step.children.length > 0) setDoneRecursive(step, nextDone);
  else step.done = nextDone;

  for (let i = parents.length - 1; i >= 0; i -= 1) syncDoneFromChildren(parents[i]);
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
  hit.step.text = decorateStepText(text, state.taskText);
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
    })
    .catch(() => {
      const fallback = generateSubStepsLocal(plain, state.taskText);
      const items = normalizeStepItems(fallback);
      const packed = items
        .map((x) => ({ text: decorateStepText(x.text, `${state.taskText ?? ""} ${plain}`), notes: normalizeNoteLines(x.notes) }))
        .filter((x) => String(x.text ?? "").trim().length > 0)
        .slice(0, 12);
      if (packed.length === 0) {
        step.generating = false;
        saveState();
        render({ silent: true });
        toast("Split failed. / 细化失败。");
        setBubble("Split failed. / 细化失败。");
        return;
      }
      step.children = packed.map((x) => makeStep({ text: x.text, notes: x.notes }));
      step.expanded = true;
      step.generating = false;
      syncDoneFromChildren(step);
      saveState();
      render();
      toast("Local split ok. / 本地细化完成");
      setBubble(pickMessage("start"));
      maybeGenerateAiNotes();
    });
}

function renderSteps(steps, container, depth) {
  const arr = Array.isArray(steps) ? steps : [];
  for (const step of arr) {
    const li = document.createElement("li");
    li.className = ["step", depth === 0 ? "is-parent" : "is-child", step.done ? "is-done" : "", step.generating ? "is-generating" : ""].filter(Boolean).join(" ");
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
    if (doneCount > 0 && doneCount < total) setBubble(pickMessage(pct < 0.34 ? "mid_early" : pct < 0.75 ? "mid_mid" : "mid_late"));
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
  if (m === "deepseek") return generateAtomicStepsDeepseek(text, state.settings);
  return generateAtomicStepsLocal(text);
}

async function generateAtomicStepsDeepseek(text, settings) {
  const s = settings ?? defaultSettings();
  const payload = {
    model: s.model || "deepseek-chat",
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          '你是一个把“大任务”拆成“原子动作清单”的助手。每个步骤必须具体可执行，避免抽象词。每步写2到3条灰色小字说明。输出严格 JSON 数组，每个元素为对象：{"text":"步骤","note":["说明1","说明2","说明3"]}。不要 markdown，不要多余文字。',
      },
      { role: "user", content: String(text ?? "") },
    ],
  };

  const { url, headers, body } = buildDeepseekRequest({ payload, settings: s });
  const res = await fetch(url, { method: "POST", headers, body });
  const rawText = await res.text();
  if (!res.ok) throw new Error(rawText || `HTTP ${res.status}`);
  const data = rawText ? safeJsonParse(rawText) : null;
  const content =
    data?.choices?.[0]?.message?.content ?? data?.output_text ?? data?.text ?? data?.content ?? (typeof data === "string" ? data : "");
  return parseStepItemsFromText(content);
}

async function generateAtomicStepsLocal(text) {
  const t = String(text ?? "").trim();
  if (!t) return [];

  const fromTo = patternFromToAction(t);
  if (fromTo) return decorateSteps(localStepsForPattern(fromTo), t);

  if (/(浇花|浇水|给.*花浇水)/u.test(t)) {
    const steps = ["从床上坐起来", "去拿喷壶/水壶", "去水龙头装水", "走到阳台", "把水浇到花盆里"];
    return decorateSteps(steps, t);
  }

  const generic = ["停 3 秒，深呼吸一下", "把需要用的东西放到手边", "做“第一下动作”（例如打开/拿起/走过去）", "完成后给自己一句：我已经开始了"];
  return decorateSteps(generic, t);
}

function localStepsForPattern({ from, to, action }) {
  const a = normalizeAction(action);
  const steps = [];
  const place = String(to ?? "").trim();
  if (from) steps.push(`从${from}坐起来`);

  if (/(浇.*花|浇花|给.*花浇水|浇水)/u.test(a)) {
    steps.push("去拿喷壶/水壶");
    steps.push("去水龙头装水");
    if (place) steps.push(`走到${place}`);
    steps.push("把水浇到花盆里");
    return steps;
  }

  if (place) steps.push(`走到${place}`);
  if (a) steps.push(a);
  return steps;
}

function patternFromToAction(text) {
  const s = String(text ?? "").trim();
  const m = s.match(/从(.+?)去(.+)$/u);
  if (!m) return null;
  const from = String(m[1] || "").trim();
  const rest = String(m[2] || "").trim();
  if (!rest) return null;
  const { place, action } = splitPlaceAndAction(rest);
  return { from, to: place || rest, action };
}

function splitPlaceAndAction(rest) {
  const s = String(rest ?? "").trim();
  if (!s) return { place: "", action: "" };
  const verbs = ["浇", "拿", "装", "接", "洗", "收拾", "整理", "倒", "扔", "打开", "启动", "发送", "发", "写", "看", "做"];
  let best = -1;
  for (const v of verbs) {
    const idx = s.indexOf(v);
    if (idx <= 0) continue;
    if (best === -1 || idx < best) best = idx;
  }
  if (best === -1) return { place: s, action: "" };
  return { place: s.slice(0, best).trim(), action: s.slice(best).trim() };
}

function normalizeAction(action) {
  const cleaned = String(action ?? "").trim();
  if (!cleaned) return "";
  if (/(浇.*花|浇花|给.*花浇水|浇水)/u.test(cleaned)) return "把水浇到花盆里";
  return cleaned;
}

function decorateSteps(steps, taskText) {
  const arr = Array.isArray(steps) ? steps : [];
  return arr.map((s) => decorateStepText(s, taskText));
}

function decorateStepText(stepText, taskText) {
  const raw = String(stepText ?? "").trim();
  if (!raw) return "";
  const without = stripEmoji(raw).trim();
  const emoji = pickStepEmoji(without, taskText);
  return `${emoji} ${without}`.trim();
}

function stripEmoji(text) {
  const s = String(text ?? "");
  return s.replace(/^\s*[\p{Extended_Pictographic}\uFE0F\u200D]+\s*/u, "");
}

function normalizeNoteLines(notes) {
  const arr = Array.isArray(notes) ? notes : typeof notes === "string" ? [notes] : [];
  const lines = arr.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 3);
  return lines;
}

function describeStepLines(stepText, taskText) {
  const base = stripEmoji(stepText);
  const t = `${taskText ?? ""} ${base}`;
  if (/(喷壶|水壶|装水|水龙头)/u.test(t)) return ["目标很小：把东西拿到手里。", "拿到就停一下，别急着连做。", "卡住的话：先移动到水龙头旁。"];
  if (/(走到|走去|走)/u.test(base)) return ["走到就算赢。", "到了以后只做下一小步。", "不需要快，只要移动。"];
  if (/(坐起来|起身|站起来)/u.test(base)) return ["这是“启动动作”，不需要有动力。", "身体一动，下一步会更容易。"];
  return ["把目标缩到 10 秒能做完。", "做完就给自己一句：我已经开始了。"];
}

function pickStepEmoji(stepText, taskText) {
  const base = String(stepText ?? "").trim();
  const t = `${taskText ?? ""} ${base}`;
  if (/(站起来|站起|起身)/u.test(base)) return "\u{1F9CD}";
  if (/(走到|走去|去到|出发|往.*走|继续走|走)/u.test(base)) return "\u{1F6B6}";
  if (/(坐下|坐到|坐在|坐稳)/u.test(base)) return "🪑";
  if (/(停 3 秒|深呼吸)/u.test(base)) return "\u{1FAE7}";
  if (/(床|起床|坐起来)/u.test(t)) return "🛏️";
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
  return "🟣";
}

function shouldUseAi(settings) {
  const s = settings ?? defaultSettings();
  return Boolean(String(s.apiKey ?? "").trim()) && Boolean(String(s.baseUrl ?? "").trim());
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
        content: "你为每个步骤写2到3条灰色小字说明：更具体、更可执行、温柔但不空泛。只输出严格JSON数组，长度与输入步骤一致；每个元素是字符串数组（2到3条）。不要markdown。",
      },
      { role: "user", content: JSON.stringify({ task: String(taskText ?? ""), steps: stepTexts.map((x) => String(x ?? "")) }) },
    ],
  };

  const { url, headers, body } = buildDeepseekRequest({ payload, settings: s });
  const res = await fetch(url, { method: "POST", headers, body });
  const rawText = await res.text();
  if (!res.ok) throw new Error(rawText || `HTTP ${res.status}`);
  const data = rawText ? safeJsonParse(rawText) : null;
  const content =
    data?.choices?.[0]?.message?.content ?? data?.output_text ?? data?.text ?? data?.content ?? (typeof data === "string" ? data : "");
  const json = parseJsonFromText(content);
  if (!Array.isArray(json)) throw new Error("Invalid notes json");
  return json.map((x) => (Array.isArray(x) ? x : typeof x === "string" ? [x] : []));
}

async function generateSubSteps(stepText, taskText) {
  if (!shouldUseAi(state.settings)) return generateSubStepsLocal(stepText, taskText);
  return generateSubStepsDeepseek(stepText, taskText, state.settings);
}

async function generateSubStepsDeepseek(stepText, taskText, settings) {
  const s = settings ?? defaultSettings();
  const payload = {
    model: s.model || "deepseek-chat",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          '把输入的一条“主步骤”细化成3到6条更小的可执行子步骤，并为每条子步骤写2到3条说明。输出严格JSON数组，每个元素为对象：{"text":"子步骤","note":["说明1","说明2","说明3"]}。不要markdown，不要额外文字。',
      },
      { role: "user", content: JSON.stringify({ task: String(taskText ?? ""), step: String(stepText ?? "") }) },
    ],
  };

  const { url, headers, body } = buildDeepseekRequest({ payload, settings: s });
  const res = await fetch(url, { method: "POST", headers, body });
  const rawText = await res.text();
  if (!res.ok) throw new Error(rawText || `HTTP ${res.status}`);
  const data = rawText ? safeJsonParse(rawText) : null;
  const content =
    data?.choices?.[0]?.message?.content ?? data?.output_text ?? data?.text ?? data?.content ?? (typeof data === "string" ? data : "");
  return parseStepItemsFromText(content);
}

function generateSubStepsLocal(stepText, taskText) {
  const base = String(stepText ?? "").trim();
  if (!base) return [];
  const t = `${taskText ?? ""} ${base}`;
  if (/(喷壶|水壶)/u.test(t)) return ["找到喷壶/水壶放在哪里", "走过去", "把喷壶/水壶拿到手里", "放到一个顺手的位置"];
  if (/(装水|接水|水龙头)/u.test(t)) return ["走到水龙头旁", "打开水龙头", "把喷壶/水壶装到够用", "关掉水龙头"];
  if (/(走到|走去|去到|出发)/u.test(base)) return ["站起来", "走到门口/过道", "走到目的地", "停一下，确认下一步"];
  if (/(整理|收拾)/u.test(t)) return ["拿一个垃圾袋/收纳盒", "先收 3 件最明显的东西", "把它们放进同一个地方", "停一下：够了就结束"];
  return ["把目标缩到 10 秒", "做第一下动作", "做第二下动作", "停一下，确认是否继续"];
}

function buildDeepseekRequest({ payload, settings }) {
  const s = settings ?? defaultSettings();
  if (s.mode === "direct") {
    const url = resolveChatCompletionsUrl(s.baseUrl);
    return { url, headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` }, body: JSON.stringify(payload) };
  }
  const url = LLM_ENDPOINT;
  const body = JSON.stringify({ apiKey: s.apiKey, baseUrl: s.baseUrl, model: payload.model, temperature: payload.temperature, messages: payload.messages });
  return { url, headers: { "Content-Type": "application/json" }, body };
}

function resolveChatCompletionsUrl(baseUrl) {
  const raw = String(baseUrl ?? "").trim() || "https://api.deepseek.com";
  if (/\/chat\/completions$/i.test(raw)) return raw;
  const u = raw.replace(/\/+$/g, "");
  if (/\/v1$/i.test(u)) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}

function normalizeStepItems(raw) {
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? parseStepsFromText(raw) : [];
  const out = [];
  for (const item of arr) {
    if (typeof item === "string") out.push({ text: item, notes: [] });
    else if (item && typeof item === "object") out.push({ text: String(item.text ?? ""), notes: item.note ?? item.notes ?? [] });
  }
  return out;
}

function parseStepsFromText(content) {
  const s = String(content ?? "");
  const lines = s
    .split(/\r?\n/u)
    .map((x) => String(x).trim())
    .filter((x) => x && !/^(?:`{3}|json\b)/iu.test(x))
    .map((x) => x.replace(/^\d+\s*[.)、\-]\s*/u, "").trim())
    .filter(Boolean);
  return lines;
}

function parseJsonFromText(content) {
  const s = String(content ?? "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const fenceBody = fence?.[1] ? String(fence[1]).trim() : null;
  const direct = safeJsonParse(fenceBody || s);
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

function getProgress(steps) {
  const leaf = getLeafSteps(steps);
  const total = leaf.length;
  const doneCount = leaf.reduce((acc, s) => acc + (s.done ? 1 : 0), 0);
  const pct = total === 0 ? 0 : doneCount / total;
  return { total, doneCount, pct };
}

function pickMessage(key) {
  const pool = {
    idle: ["Pick one thing. Just one. 🧩 / 先选一件事就行。", "Tiny start, big win. ✨ / 小开始就是大胜利。", "No pressure. We do one step. 🫶 / 不急，我们只做一步。"],
    need_input: ["One sentence is enough. ✍️ / 一句话就够了。", "Give me a task, I’ll break it down. 🔧 / 说一句，我来拆。"],
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
    const normalized = normalizeLoadedSteps(rawSteps, taskText, 0);
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
