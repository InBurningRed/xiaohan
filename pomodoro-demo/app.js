const DEFAULTS = {
  focusSec: 25 * 60,
  breakSec: 5 * 60,
  longSec: 15 * 60,
};

const STORAGE_KEY = "pomodoroConfigV1";

function clampInt(v, min, max) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { focusSec: DEFAULTS.focusSec, breakSec: DEFAULTS.breakSec };
    const parsed = JSON.parse(raw);
    const focusMin = clampInt(parsed.focusMin, 1, 180);
    const breakMin = clampInt(parsed.breakMin, 1, 60);
    return { focusSec: focusMin * 60, breakSec: breakMin * 60 };
  } catch (e) {
    return { focusSec: DEFAULTS.focusSec, breakSec: DEFAULTS.breakSec };
  }
}

function saveConfig(next) {
  const payload = { focusMin: Math.round(next.focusSec / 60), breakMin: Math.round(next.breakSec / 60) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

const MODE_LABELS = {
  focus: "专注",
  short: "短休",
  long: "长休",
};

const appEl = document.querySelector(".app");
const tabsEl = document.querySelector(".tabs");
const timeEl = document.querySelector(".time");
const hintEl = document.querySelector(".hint");
const ringEl = document.querySelector(".ring");
const toggleBtn = document.querySelector('[data-action="toggle"]');
const resetBtn = document.querySelector('[data-action="reset"]');
const skipBtn = document.querySelector('[data-action="skip"]');
const notifyBtn = document.querySelector('[data-action="notify"]');
const settingsBtn = document.querySelector('[data-action="settings"]');
const settingsDialog = document.querySelector('[data-dialog="settings"]');
const settingsFocusInput = settingsDialog.querySelector('input[name="focusMinutes"]');
const settingsBreakInput = settingsDialog.querySelector('input[name="forcedBreakMinutes"]');
const settingsResetBtn = settingsDialog.querySelector('[data-action="settings-reset"]');
const settingsCancelBtn = settingsDialog.querySelector('[data-action="settings-cancel"]');
const settingsSaveBtn = settingsDialog.querySelector('[data-action="settings-save"]');
const roundEl = document.getElementById("round");
const todayEl = document.getElementById("today");
const toastEl = document.querySelector(".toast");

let config = loadConfig();

let mode = "focus";
let lock = null;
let pendingLong = false;

let running = false;
let remainingSec = config.focusSec;
let totalSec = config.focusSec;
let endAtMs = 0;
let timerId = null;

let focusRound = 1;
let todayFocusMin = 0;

let toastTimer = null;

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function setProgress() {
  const pct = totalSec === 0 ? 0 : ((totalSec - remainingSec) / totalSec) * 100;
  ringEl.style.setProperty("--p", `${pct}%`);
}

function setDocumentTitle() {
  const label = lock === "forced_break" ? "强制休息" : MODE_LABELS[mode] ?? "番茄钟";
  document.title = `${formatTime(remainingSec)} - ${label}`;
}

function getModeTotalSec(m) {
  if (m === "focus") return config.focusSec;
  if (m === "short") return config.breakSec;
  return DEFAULTS.longSec;
}

function updateUI() {
  timeEl.textContent = formatTime(remainingSec);
  setProgress();
  setDocumentTitle();
  toggleBtn.textContent = running ? "暂停" : remainingSec === totalSec ? "开始" : "继续";
  if (lock === "forced_break") {
    hintEl.textContent = running ? "强制休息中…" : "强制休息暂停";
  } else {
    hintEl.textContent = running ? `${MODE_LABELS[mode]}中…` : "准备开始";
  }
  appEl.dataset.mode = mode;
  Array.from(tabsEl.querySelectorAll(".tab")).forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.disabled = running || lock === "forced_break";
  });
  skipBtn.disabled = lock === "forced_break";
  roundEl.textContent = String(focusRound);
  todayEl.textContent = String(todayFocusMin);
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("is-show");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("is-show"), 2200);
}

function playBeep() {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = "sine";
  o.frequency.value = 880;
  g.gain.value = 0.0001;
  o.connect(g);
  g.connect(audioCtx.destination);
  o.start();

  const now = audioCtx.currentTime;
  g.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
  o.stop(now + 0.2);
  o.onended = () => audioCtx.close();
}

function notify(message) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  new Notification("番茄钟", { body: message });
}

function stopTimer() {
  if (timerId) window.clearInterval(timerId);
  timerId = null;
  running = false;
}

function tick() {
  const left = Math.max(0, Math.round((endAtMs - Date.now()) / 1000));
  remainingSec = left;
  if (remainingSec <= 0) {
    stopTimer();
    onComplete();
  }
  updateUI();
}

function startTimer() {
  if (running) return;
  running = true;
  endAtMs = Date.now() + remainingSec * 1000;
  if (timerId) window.clearInterval(timerId);
  timerId = window.setInterval(tick, 250);
  tick();
}

function toggleTimer() {
  if (running) {
    tick();
    stopTimer();
    updateUI();
    return;
  }
  startTimer();
}

function resetTimer() {
  stopTimer();
  totalSec = getModeTotalSec(mode);
  remainingSec = totalSec;
  updateUI();
}

function switchMode(nextMode) {
  lock = null;
  pendingLong = false;
  mode = nextMode;
  totalSec = getModeTotalSec(mode);
  remainingSec = totalSec;
  updateUI();
}

function onComplete() {
  try {
    playBeep();
  } catch (e) {}

  if (mode === "focus") {
    todayFocusMin += Math.round(totalSec / 60);
  }

  if (mode === "focus") {
    pendingLong = focusRound === 4;
    if (focusRound < 4) focusRound += 1;
    lock = "forced_break";
    mode = "short";
    totalSec = config.breakSec;
    remainingSec = totalSec;
    const message = `专注结束，强制休息 ${formatTime(config.breakSec)}`;
    toast(message);
    notify(message);
    updateUI();
    startTimer();
    return;
  }

  if (mode === "short" && lock === "forced_break") {
    lock = null;
    mode = pendingLong ? "long" : "focus";
    totalSec = getModeTotalSec(mode);
    remainingSec = totalSec;
    const message = pendingLong ? "强制休息结束，进入长休" : "强制休息结束，回到专注";
    pendingLong = false;
    toast(message);
    notify(message);
    updateUI();
    return;
  }

  if (mode === "long") {
    focusRound = 1;
    mode = "focus";
    totalSec = getModeTotalSec(mode);
    remainingSec = totalSec;
    const message = "长休结束，回到专注";
    toast(message);
    notify(message);
    updateUI();
    return;
  }

  if (mode === "short") {
    mode = "focus";
    totalSec = getModeTotalSec(mode);
    remainingSec = totalSec;
    const message = "休息结束，回到专注";
    toast(message);
    notify(message);
    updateUI();
  }
}

function skip() {
  if (lock === "forced_break") {
    toast("强制休息期间不能跳过");
    return;
  }
  stopTimer();
  remainingSec = 0;
  updateUI();
  onComplete();
}

tabsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  if (running) return;
  if (lock === "forced_break") {
    toast("强制休息未结束");
    return;
  }
  const next = btn.dataset.mode;
  if (!MODE_LABELS[next]) return;
  switchMode(next);
});

toggleBtn.addEventListener("click", toggleTimer);
resetBtn.addEventListener("click", resetTimer);
skipBtn.addEventListener("click", skip);

notifyBtn.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    toast("当前浏览器不支持通知");
    return;
  }
  if (Notification.permission === "granted") {
    toast("通知已启用");
    return;
  }
  if (Notification.permission === "denied") {
    toast("通知被禁用，请在浏览器设置中开启");
    return;
  }
  const r = await Notification.requestPermission();
  toast(r === "granted" ? "通知已启用" : "未启用通知");
});

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    toggleTimer();
  }
  if (e.key.toLowerCase() === "r") resetTimer();
});

updateUI();

function openSettings() {
  settingsFocusInput.value = String(Math.round(config.focusSec / 60));
  settingsBreakInput.value = String(Math.round(config.breakSec / 60));
  settingsDialog.showModal();
  settingsFocusInput.focus();
}

function closeSettings() {
  settingsDialog.close();
  settingsBtn.focus();
}

function applyConfigToCurrentTimer() {
  const newTotal = getModeTotalSec(mode);
  const elapsed = totalSec - remainingSec;
  totalSec = newTotal;
  remainingSec = Math.max(0, totalSec - elapsed);
  if (running) endAtMs = Date.now() + remainingSec * 1000;
  if (remainingSec <= 0) {
    stopTimer();
    onComplete();
    return;
  }
  updateUI();
}

settingsBtn.addEventListener("click", openSettings);
settingsCancelBtn.addEventListener("click", closeSettings);

settingsResetBtn.addEventListener("click", () => {
  settingsFocusInput.value = String(Math.round(DEFAULTS.focusSec / 60));
  settingsBreakInput.value = String(Math.round(DEFAULTS.breakSec / 60));
});

settingsSaveBtn.addEventListener("click", () => {
  const focusMin = clampInt(settingsFocusInput.value, 1, 180);
  const breakMin = clampInt(settingsBreakInput.value, 1, 60);
  config = { focusSec: focusMin * 60, breakSec: breakMin * 60 };
  saveConfig(config);
  applyConfigToCurrentTimer();
  toast("已保存");
  closeSettings();
});
