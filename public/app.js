"use strict";

// Reihenfolge muss mit STEPS in src/worker.js übereinstimmen.
const STEPS = ["captcha", "confirm1", "confirm2", "upsell", "trap", "queue", "data", "hold", "final", "error", "done"];
const STORE = "bp_state";
const TEAM_STORE = "bp_team";
const MAX_AGE = 3 * 60 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let state = { run: null, team: "", screen: "home" };
let current = "home";
let cleanup = null;

// ---------- Speicher ----------

function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ ...state, screen: current, ts: Date.now() })); } catch {}
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || "null");
    if (s && Date.now() - s.ts < MAX_AGE) return s;
  } catch {}
  return null;
}

function clearRun() {
  state.run = null;
  state.team = "";
  try { localStorage.removeItem(STORE); } catch {}
}

// ---------- Server ----------

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function sendStep(step, attempt = 0) {
  const idx = STEPS.indexOf(step);
  try {
    let res = await api("/api/step", { run: state.run, step });
    if (res.status === 409) {
      for (let i = res.data.have + 1; i < idx; i++) await api("/api/step", { run: state.run, step: STEPS[i] });
      res = await api("/api/step", { run: state.run, step });
    } else if (res.status === 404 && state.team) {
      const started = await api("/api/start", { team: state.team });
      if (started.status !== 200) return started;
      state.run = started.data.run;
      save();
      for (let i = 0; i < idx; i++) await api("/api/step", { run: state.run, step: STEPS[i] });
      res = await api("/api/step", { run: state.run, step });
    }
    if (res.status === 403) showClosed();
    return res;
  } catch {
    if (attempt < 4) {
      await sleep(1000 * (attempt + 1));
      return sendStep(step, attempt + 1);
    }
    return { status: 0, data: {} };
  }
}

let chain = Promise.resolve();
function track(step) {
  if (!state.run) return Promise.resolve({ status: 0, data: {} });
  const job = chain.then(() => sendStep(step));
  chain = job.catch(() => {});
  return job;
}

function abortRun() {
  if (!state.run) return;
  const run = state.run;
  fetch("/api/abort", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run }),
    keepalive: true,
  }).catch(() => {});
}

function showClosed() {
  clearRun();
  enter("home");
  let box = $("closed-banner");
  if (!box) {
    box = document.createElement("div");
    box.id = "closed-banner";
    box.className = "notice error";
    box.textContent = "Das BonusPortal ist geschlossen. Der Bonuspunkt ist leider verfallen.";
    $("screen-home").prepend(box);
  }
}

// ---------- Navigation ----------

function enter(screen) {
  if (cleanup) { cleanup(); cleanup = null; }
  current = screen;
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === "screen-" + screen));
  window.scrollTo(0, 0);

  const showChip = state.team && STEPS.includes(screen);
  $("team-chip").hidden = !showChip;
  $("team-chip").textContent = state.team;
  document.querySelectorAll("[data-team]").forEach((el) => { el.textContent = state.team; });

  save();
  if (STEPS.includes(screen)) track(screen);
  if (hooks[screen]) cleanup = hooks[screen]() || null;
}

function lose() {
  abortRun();
  clearRun();
  enter("keep");
}

function goHome() {
  if (state.run && current !== "done") abortRun();
  clearRun();
  enter("home");
}

// ---------- Login ----------

async function login() {
  const input = $("team-input");
  const err = $("login-error");
  const name = input.value.replace(/\s+/g, " ").trim();
  err.hidden = true;
  input.classList.remove("invalid");
  if (name.length < 2) {
    input.classList.add("invalid");
    err.textContent = "Bitte gebt euren Teamnamen ein.";
    err.hidden = false;
    input.focus();
    return;
  }
  const btn = $("login-btn");
  btn.disabled = true;
  btn.textContent = "Prüfe Zugangsdaten …";
  try {
    // Nur der Teamname wird übertragen. Das Passwortfeld wird nie ausgelesen.
    const res = await api("/api/start", { team: name });
    if (res.status === 200) {
      state.run = res.data.run;
      state.team = res.data.team;
      try { localStorage.setItem(TEAM_STORE, state.team); } catch {}
      resetCaptcha();
      enter("captcha");
      return;
    }
    err.textContent = res.status === 403
      ? "Das BonusPortal ist geschlossen. Der Bonuspunkt ist leider verfallen."
      : "Dieser Teamname wird nicht akzeptiert. Bitte versucht einen anderen.";
  } catch {
    err.textContent = "Keine Verbindung zum Server. Bitte prüft euer Netz und versucht es erneut.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Einloggen";
  }
  err.hidden = false;
}

// ---------- Captcha ----------

let captchaAttempts = 0;
const captchaErrors = [
  "Falsch! Bitte achtet penibel auf die Groß-/Kleinschreibung.",
  "Sitzung abgelaufen (Timeout). Ein neues Captcha wurde generiert.",
  "Fehler! Wir haben verdächtige Mausbewegungen festgestellt. Versucht es erneut.",
  "Eure IP-Adresse wirkt ungewöhnlich. Seid ihr wirklich Menschen?",
];
const captchaTexts = ["W7pQ2L", "mB4v9Z", "8kTwP1", "gR5nLx", "Q1wE6r"];

function resetCaptcha() {
  captchaAttempts = 0;
  const text = $("captcha-text");
  text.textContent = captchaTexts[0];
  text.style.transform = "";
  text.style.filter = "";
  $("captcha-input").value = "";
  $("captcha-error").hidden = true;
}

function verifyCaptcha() {
  const error = $("captcha-error");
  const text = $("captcha-text");
  if (captchaAttempts < 4) {
    error.textContent = captchaErrors[captchaAttempts];
    error.hidden = false;
    captchaAttempts++;
    text.textContent = captchaTexts[captchaAttempts];
    $("captcha-input").value = "";
    text.style.transform = `skewX(${12 + captchaAttempts * 10}deg) rotate(${-3 + captchaAttempts * 5}deg)`;
    text.style.filter = `blur(${1 + captchaAttempts * 0.5}px)`;
  } else {
    error.hidden = true;
    enter("confirm1");
  }
}

// ---------- Warteschlange ----------

function enterQueue() {
  const START = 17;
  let pos = START;
  let jumped1 = false;
  let jumped2 = false;
  let hiddenAt = 0;
  const posEl = $("queue-pos");
  const bar = $("queue-bar");
  const msg = $("queue-msg");
  const idle = [
    "Bitte verlasst diese Seite nicht, sonst verliert ihr euren Platz.",
    "Wir bearbeiten Anfragen in der Reihenfolge ihres Eingangs. Meistens.",
    "Eure Anfrage ist uns wichtig. Eure Wartezeit leider weniger.",
  ];

  function render(text, warn) {
    posEl.textContent = pos;
    bar.style.width = Math.max(4, ((START - pos) / START) * 100) + "%";
    if (text) { msg.textContent = text; msg.classList.toggle("warn", !!warn); }
  }
  render(idle[0]);

  const timer = setInterval(() => {
    pos--;
    if (pos === 9 && !jumped1) {
      jumped1 = true;
      pos = 13;
      render("Ein Premium-Kunde hat sich vorgedrängt. Wir bitten um Verständnis.", true);
    } else if (pos === 4 && !jumped2) {
      jumped2 = true;
      pos = 9;
      render("Serverwartung: Die Positionen wurden neu berechnet.", true);
    } else if (pos <= 0) {
      clearInterval(timer);
      enter("data");
    } else {
      render(pos % 4 === 0 ? idle[(pos / 4) % idle.length] : null, false);
    }
  }, 800);

  const onVis = () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 2000 && pos < 11) {
      pos = 11;
      render("Ihr habt die Seite verlassen und euren Platz verloren. Neue Position:", true);
    }
    hiddenAt = 0;
  };
  document.addEventListener("visibilitychange", onVis);
  return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
}

// ---------- Identitätsprüfung ----------

function fillField(input) {
  let value = input.dataset.fill;
  if (value === "@reverse") value = [...state.team].reverse().join("");
  input.value = value;
  input.classList.add("filled");
}

function submitData() {
  const fields = [...document.querySelectorAll("#screen-data [data-fill]")];
  const ok = fields.every((f) => f.value);
  $("data-error").hidden = ok;
  if (ok) enter("hold");
}

// ---------- Gedrückt halten ----------

function enterHold() {
  const HOLD_MS = 5000;
  const FAKE_FAIL_MS = 3800;
  const CIRC = 628;
  const btn = $("hold-btn");
  const ring = $("hold-prog");
  const msg = $("hold-msg");
  const label = $("hold-label");
  const hints = ["Bleibt dran …", "Nicht loslassen!", "Gleich geschafft …", "Noch ein bisschen …", "Fast da …"];
  let attempts = 0;
  let pressing = false;
  let locked = false;
  let start = 0;
  let timer = 0;

  const setMsg = (text, warn) => { msg.textContent = text; msg.classList.toggle("warn", !!warn); };
  const setRing = (p) => { ring.style.strokeDashoffset = String(CIRC * (1 - p)); };
  setRing(0);
  setMsg("");
  label.textContent = "Gedrückt halten";

  function reset() {
    clearInterval(timer);
    pressing = false;
    btn.classList.remove("pressing");
    setRing(0);
    label.textContent = "Gedrückt halten";
  }

  function frame() {
    if (!pressing) return;
    const t = performance.now() - start;
    setRing(Math.min(1, t / HOLD_MS));
    if (attempts === 0 && t >= FAKE_FAIL_MS) {
      attempts++;
      locked = true;
      reset();
      setMsg("Verbindung kurz unterbrochen. Bitte erneut gedrückt halten.", true);
      if (navigator.vibrate) navigator.vibrate(200);
      return;
    }
    if (t >= HOLD_MS) {
      reset();
      locked = true;
      enter("final");
      return;
    }
    label.textContent = "Halten …";
    setMsg(hints[Math.min(hints.length - 1, Math.floor(t / 1000))], false);
  }

  const down = (e) => {
    if (pressing || locked) return;
    e.preventDefault();
    pressing = true;
    start = performance.now();
    btn.classList.add("pressing");
    try { btn.setPointerCapture(e.pointerId); } catch {}
    timer = setInterval(frame, 40);
  };
  const up = () => {
    if (pressing) {
      reset();
      setMsg("Zu früh losgelassen! Bitte von vorn.", true);
    }
    locked = false;
  };
  const block = (e) => e.preventDefault();

  btn.addEventListener("pointerdown", down);
  btn.addEventListener("pointerup", up);
  btn.addEventListener("pointercancel", up);
  btn.addEventListener("contextmenu", block);
  btn.addEventListener("selectstart", block);
  return () => {
    clearInterval(timer);
    btn.removeEventListener("pointerdown", down);
    btn.removeEventListener("pointerup", up);
    btn.removeEventListener("pointercancel", up);
    btn.removeEventListener("contextmenu", block);
    btn.removeEventListener("selectstart", block);
  };
}

// ---------- Flüchtender Button ----------

let runawayClicks = 0;
let lastSpot = null;

function resetRunaway() {
  runawayClicks = 0;
  lastSpot = null;
  const btn = $("runaway-btn");
  btn.classList.remove("fleeing");
  btn.style.left = btn.style.top = "";
}

function flee() {
  const btn = $("runaway-btn");
  if (!btn.classList.contains("fleeing")) {
    const r = btn.getBoundingClientRect();
    btn.style.left = r.left + "px";
    btn.style.top = r.top + "px";
    btn.classList.add("fleeing");
    lastSpot = { x: r.left, y: r.top };
    void btn.offsetWidth;
  }
  const w = btn.offsetWidth;
  const h = btn.offsetHeight;
  const minTop = 64 + 8;
  const maxX = Math.max(8, window.innerWidth - w - 8);
  const maxY = Math.max(minTop, window.innerHeight - h - 12);
  let x, y;
  for (let i = 0; i < 12; i++) {
    x = 8 + Math.random() * (maxX - 8);
    y = minTop + Math.random() * (maxY - minTop);
    if (!lastSpot || Math.hypot(x - lastSpot.x, y - lastSpot.y) > 140) break;
  }
  lastSpot = { x, y };
  btn.style.left = x + "px";
  btn.style.top = y + "px";
}

function onRunawayClick() {
  runawayClicks++;
  if (runawayClicks >= 3) {
    enter("error");
    return;
  }
  flee();
}

// ---------- Ziel ----------

function confetti() {
  const icons = ["🎉", "🪙", "⭐", "🍺", "🏆", "✨"];
  for (let i = 0; i < 36; i++) {
    const el = document.createElement("span");
    el.className = "confetti";
    el.textContent = icons[i % icons.length];
    el.style.left = Math.random() * 100 + "vw";
    el.style.fontSize = 18 + Math.random() * 18 + "px";
    el.style.animationDuration = 2.4 + Math.random() * 2.2 + "s";
    el.style.animationDelay = Math.random() * 0.8 + "s";
    el.addEventListener("animationend", () => el.remove());
    document.body.appendChild(el);
  }
}

const pad = (n) => String(n).padStart(2, "0");

function renderResult(res) {
  const meta = $("done-meta");
  const stateEl = $("done-state");
  const retry = $("done-retry");
  if (res.status === 200 && res.data.finished_at) {
    const d = new Date(res.data.finished_at);
    const secs = Math.round(res.data.duration_ms / 1000);
    meta.textContent = `Platz ${res.data.rank} im Ziel · ${Math.floor(secs / 60)}:${pad(secs % 60)} min · ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} Uhr`;
    stateEl.textContent = "✓ Vom Server bestätigt";
    retry.hidden = true;
  } else {
    meta.innerHTML = "&nbsp;";
    stateEl.textContent = "Das Ergebnis konnte nicht übermittelt werden. Bitte prüft eure Verbindung.";
    retry.hidden = false;
  }
}

function enterDone() {
  $("done-state").textContent = "Ergebnis wird übermittelt …";
  $("done-retry").hidden = true;
  confetti();
  track("done").then(renderResult);
}

const hooks = { queue: enterQueue, hold: enterHold, final: resetRunaway, done: enterDone };

// ---------- Events ----------

const actions = {
  login,
  captcha: verifyCaptcha,
  lose,
  home: goHome,
  "data-submit": submitData,
  "modal-open": () => $("modal").classList.add("show"),
  "modal-ok": () => { $("modal").classList.remove("show"); lose(); },
  "done-retry": () => { $("done-state").textContent = "Ergebnis wird übermittelt …"; track("done").then(renderResult); },
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-goto], [data-action], [data-fill]");
  if (!el) return;
  if (el.dataset.fill) return fillField(el);
  if (el.dataset.goto) return enter(el.dataset.goto);
  actions[el.dataset.action]?.();
});

$("runaway-btn").addEventListener("click", onRunawayClick);

$("team-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("pw-input").focus(); });
$("pw-input").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
$("captcha-input").addEventListener("keydown", (e) => { if (e.key === "Enter") verifyCaptcha(); });
$("team-input").addEventListener("input", () => {
  $("team-input").classList.remove("invalid");
  try { localStorage.setItem(TEAM_STORE, $("team-input").value); } catch {}
});

// ---------- Start ----------

if (new URLSearchParams(location.search).has("reset")) {
  try { localStorage.removeItem(STORE); localStorage.removeItem(TEAM_STORE); } catch {}
  history.replaceState(null, "", location.pathname);
}

try { $("team-input").value = localStorage.getItem(TEAM_STORE) || ""; } catch {}

const saved = load();
if (saved && saved.run && STEPS.includes(saved.screen)) {
  state.run = saved.run;
  state.team = saved.team;
  if (saved.screen === "captcha") resetCaptcha();
  enter(saved.screen);
} else if (saved && saved.screen === "login") {
  enter("login");
}
