"use strict";

const APP_VERSION = "1.0.0";
const STATE_KEY = "fp2-pwa-state-v1";
const QUESTIONS_KEY = "fp2-pwa-questions-v1";
const CATEGORY_ORDER = [
  "金融資産運用",
  "不動産",
  "ライフプランニングと資金計画",
  "リスク管理",
  "タックスプランニング",
  "相続・事業承継",
  "実技・計算"
];
const PRIORITY = {
  "金融資産運用": 3,
  "不動産": 3,
  "ライフプランニングと資金計画": 2,
  "リスク管理": 2,
  "実技・計算": 2,
  "タックスプランニング": 1,
  "相続・事業承継": 1
};
const MODE_LABELS = {
  weak: "弱点集中",
  random: "ランダム",
  mock: "模擬試験（短縮版）",
  wrong: "間違えた問題",
  favorites: "お気に入り"
};

let questions = [];
let state = loadState();
let currentSession = state.session;
let timerHandle = null;
let deferredInstallPrompt = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function defaultState() {
  return {
    version: APP_VERSION,
    examDate: "2026-11-30",
    theme: "light",
    selectedCategories: [...CATEGORY_ORDER],
    favorites: [],
    history: {},
    totalAnswers: 0,
    currentStreak: 0,
    bestStreak: 0,
    lastMode: "weak",
    session: null
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY));
    return { ...defaultState(), ...saved };
  } catch (error) {
    console.warn("学習履歴を読み込めませんでした。", error);
    return defaultState();
  }
}

function saveState() {
  state.version = APP_VERSION;
  state.session = currentSession;
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

async function loadQuestions() {
  const custom = localStorage.getItem(QUESTIONS_KEY);
  if (custom) {
    try {
      const parsed = JSON.parse(custom);
      validateQuestions(parsed);
      questions = parsed;
      return;
    } catch (error) {
      console.warn("保存済み問題データが不正なため初期データを使います。", error);
      localStorage.removeItem(QUESTIONS_KEY);
    }
  }
  const response = await fetch("questions.json");
  if (!response.ok) throw new Error(`questions.json: ${response.status}`);
  const parsed = await response.json();
  validateQuestions(parsed);
  questions = parsed;
}

function validateQuestions(data) {
  if (!Array.isArray(data) || data.length === 0) throw new Error("問題配列がありません。");
  const ids = new Set();
  data.forEach((q, index) => {
    const required = ["id", "category", "difficulty", "type", "prompt", "answer", "explanation", "formula", "trap", "basisDate", "sources"];
    required.forEach((key) => {
      if (q[key] === undefined || q[key] === null || q[key] === "") throw new Error(`${index + 1}問目の${key}がありません。`);
    });
    if (ids.has(q.id)) throw new Error(`問題ID ${q.id} が重複しています。`);
    ids.add(q.id);
    if (!CATEGORY_ORDER.includes(q.category)) throw new Error(`${q.id} の分野が不正です。`);
    if (!['choice', 'number'].includes(q.type)) throw new Error(`${q.id} のtypeが不正です。`);
    if (q.type === "choice" && (!Array.isArray(q.choices) || q.choices.length !== 4)) throw new Error(`${q.id} の選択肢は4件必要です。`);
    if (!Array.isArray(q.sources) || q.sources.some((s) => !s.url || !s.title || !s.checkedAt)) throw new Error(`${q.id} の出典情報が不正です。`);
  });
}

function initCategories() {
  const counts = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, questions.filter((q) => q.category === c).length]));
  const grid = $("#categoryGrid");
  grid.innerHTML = "";
  CATEGORY_ORDER.forEach((category) => {
    const label = document.createElement("label");
    label.className = "category-option";
    const checked = state.selectedCategories.includes(category) ? "checked" : "";
    label.innerHTML = `<input type="checkbox" value="${category}" ${checked}><span><span>${category}${PRIORITY[category] >= 2 ? `<em class="priority-mark">重点${"★".repeat(PRIORITY[category] - 1)}</em>` : ""}</span><small>${counts[category]}問</small></span>`;
    grid.appendChild(label);
  });
  $$("#categoryGrid input").forEach((input) => input.addEventListener("change", () => {
    state.selectedCategories = $$("#categoryGrid input:checked").map((el) => el.value);
    updateSelectAllLabel();
    saveState();
  }));
  updateSelectAllLabel();
}

function updateSelectAllLabel() {
  const allSelected = $$("#categoryGrid input:checked").length === CATEGORY_ORDER.length;
  $("#selectAllButton").textContent = allSelected ? "すべて解除" : "すべて選択";
}

function selectedQuestions() {
  const selected = state.selectedCategories;
  return questions.filter((q) => selected.includes(q.category));
}

function historyFor(id) {
  return state.history[id] || { attempts: 0, correct: 0, wrong: 0, lastAnsweredAt: null, lastCorrect: null };
}

function questionWeight(question, mode) {
  const h = historyFor(question.id);
  const accuracy = h.attempts ? h.correct / h.attempts : 0.5;
  const priorityBonus = PRIORITY[question.category] || 1;
  if (mode === "weak") return 1 + h.wrong * 5 + (1 - accuracy) * 4 + priorityBonus * 2;
  if (mode === "random") return 1 + h.wrong * 1.5 + priorityBonus * 0.35;
  return 1;
}

function weightedSample(items, count, mode) {
  const pool = [...items];
  const result = [];
  while (pool.length && result.length < count) {
    const weights = pool.map((q) => questionWeight(q, mode));
    const total = weights.reduce((a, b) => a + b, 0);
    let target = Math.random() * total;
    let selectedIndex = 0;
    for (let i = 0; i < weights.length; i += 1) {
      target -= weights[i];
      if (target <= 0) { selectedIndex = i; break; }
    }
    result.push(pool.splice(selectedIndex, 1)[0]);
  }
  return result;
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function buildQueue(mode) {
  let candidates = selectedQuestions();
  if (mode === "wrong") candidates = candidates.filter((q) => historyFor(q.id).wrong > 0);
  if (mode === "favorites") candidates = candidates.filter((q) => state.favorites.includes(q.id));
  if (!candidates.length) return [];
  if (mode === "mock") return shuffle(candidates).slice(0, Math.min(20, candidates.length));
  if (mode === "wrong" || mode === "favorites") return weightedSample(candidates, candidates.length, "weak");
  return weightedSample(candidates, Math.min(10, candidates.length), mode);
}

function startSession(mode, resume = false) {
  if (!resume) {
    if (!state.selectedCategories.length) {
      showDataMessage("分野を1つ以上選択してください。", true);
      return;
    }
    const queue = buildQueue(mode);
    if (!queue.length) {
      const reason = mode === "wrong" ? "選択分野に誤答履歴がありません。" : mode === "favorites" ? "選択分野にお気に入りがありません。" : "出題できる問題がありません。";
      showDataMessage(reason, true);
      return;
    }
    currentSession = {
      mode,
      queue: queue.map((q) => q.id),
      index: 0,
      answers: [],
      startedAt: new Date().toISOString(),
      timerEnd: mode === "mock" ? Date.now() + 40 * 60 * 1000 : null,
      answeredCurrent: false
    };
  } else {
    currentSession = state.session;
  }
  saveState();
  switchView("quizView");
  startTimerIfNeeded();
  renderQuestion();
}

function currentQuestion() {
  if (!currentSession) return null;
  return questions.find((q) => q.id === currentSession.queue[currentSession.index]);
}

function renderQuestion() {
  const q = currentQuestion();
  if (!q) { finishSession(); return; }
  currentSession.answeredCurrent = false;
  saveState();
  $("#feedbackCard").hidden = true;
  $("#feedbackCard").className = "card feedback-card";
  $("#answerForm").hidden = false;
  $("#modeLabel").textContent = MODE_LABELS[currentSession.mode];
  $("#progressLabel").textContent = `${currentSession.index + 1} / ${currentSession.queue.length}`;
  $("#quizProgress").max = currentSession.queue.length;
  $("#quizProgress").value = currentSession.index;
  $("#categoryBadge").textContent = q.category;
  $("#difficultyBadge").textContent = `難易度：${q.difficulty}`;
  $("#questionId").textContent = q.id;
  $("#questionText").textContent = q.prompt;
  const favorite = state.favorites.includes(q.id);
  $("#favoriteButton").textContent = favorite ? "★" : "☆";
  $("#favoriteButton").setAttribute("aria-pressed", String(favorite));
  $("#choiceArea").innerHTML = "";
  $("#numericAnswer").value = "";
  $("#numericHint").hidden = true;
  $("#choiceArea").hidden = q.type !== "choice";
  $("#numericArea").hidden = q.type !== "number";

  if (q.type === "choice") {
    q.choices.forEach((choice, index) => {
      const label = document.createElement("label");
      label.className = "choice-item";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "answer";
      input.value = String(index);
      const span = document.createElement("span");
      const key = document.createElement("b");
      key.className = "choice-key";
      key.textContent = String.fromCharCode(65 + index);
      const text = document.createElement("span");
      text.textContent = choice;
      span.append(key, text);
      label.append(input, span);
      $("#choiceArea").appendChild(label);
    });
  } else {
    $("#numericUnit").textContent = q.numeric.unit || "";
    $("#numericAnswer").step = q.numeric.step || "any";
    $("#numericHint").textContent = q.numeric.instruction;
    $("#numericHint").hidden = false;
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function submitAnswer(event) {
  event.preventDefault();
  if (!currentSession || currentSession.answeredCurrent) return;
  const q = currentQuestion();
  let userAnswer;
  if (q.type === "choice") {
    const selected = document.querySelector('input[name="answer"]:checked');
    if (!selected) { alert("選択肢を1つ選んでください。"); return; }
    userAnswer = Number(selected.value);
  } else {
    const raw = $("#numericAnswer").value.trim();
    if (raw === "" || Number.isNaN(Number(raw))) { alert("数値を入力してください。"); return; }
    userAnswer = Number(raw);
  }
  const correct = q.type === "choice"
    ? userAnswer === Number(q.answer)
    : Math.abs(userAnswer - Number(q.answer)) <= Number(q.numeric.tolerance || 0);

  currentSession.answeredCurrent = true;
  currentSession.answers.push({ questionId: q.id, userAnswer, correct, answeredAt: new Date().toISOString() });
  const h = historyFor(q.id);
  h.attempts += 1;
  h.correct += correct ? 1 : 0;
  h.wrong += correct ? 0 : 1;
  h.lastAnsweredAt = new Date().toISOString();
  h.lastCorrect = correct;
  state.history[q.id] = h;
  state.totalAnswers += 1;
  state.currentStreak = correct ? state.currentStreak + 1 : 0;
  state.bestStreak = Math.max(state.bestStreak, state.currentStreak);
  saveState();
  showFeedback(q, correct);
}

function showFeedback(q, correct) {
  $("#answerForm").hidden = true;
  const card = $("#feedbackCard");
  card.hidden = false;
  card.classList.add(correct ? "correct" : "incorrect");
  $("#resultHeading").textContent = correct ? "正解です" : "不正解です";
  const answerText = q.type === "choice"
    ? `${String.fromCharCode(65 + Number(q.answer))}. ${q.choices[Number(q.answer)]}`
    : `${q.answer}${q.numeric.unit || ""}（許容差：±${q.numeric.tolerance || 0}${q.numeric.unit || ""}）`;
  $("#correctAnswerText").textContent = `正解：${answerText}`;
  $("#explanationText").textContent = q.explanation;
  $("#formulaText").textContent = q.formula;
  $("#trapText").textContent = q.trap;
  $("#basisText").textContent = q.basisDate;
  const sources = $("#sourcesList");
  sources.innerHTML = "";
  q.sources.forEach((source) => {
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `出典：${source.title}（確認日 ${source.checkedAt}）`;
    sources.appendChild(link);
  });
  $("#nextButton").textContent = currentSession.index + 1 >= currentSession.queue.length ? "結果を見る" : "次の問題";
  card.scrollIntoView({ behavior: "smooth", block: "start" });
}

function nextQuestion() {
  if (!currentSession?.answeredCurrent) return;
  currentSession.index += 1;
  if (currentSession.index >= currentSession.queue.length) finishSession();
  else renderQuestion();
}

function finishSession() {
  if (!currentSession) return;
  stopTimer();
  const finished = currentSession;
  state.lastMode = finished.mode;
  const total = finished.answers.length;
  const correct = finished.answers.filter((a) => a.correct).length;
  const percent = total ? Math.round(correct / total * 100) : 0;
  $("#sessionScore").textContent = `${correct} / ${total}問正解（${percent}%）`;
  const breakdown = CATEGORY_ORDER.map((category) => {
    const ids = new Set(questions.filter((q) => q.category === category).map((q) => q.id));
    const answers = finished.answers.filter((a) => ids.has(a.questionId));
    if (!answers.length) return "";
    const ok = answers.filter((a) => a.correct).length;
    return `<tr><td>${category}</td><td>${ok}/${answers.length}</td><td>${Math.round(ok / answers.length * 100)}%</td></tr>`;
  }).join("");
  $("#sessionBreakdown").innerHTML = `<table><thead><tr><th>分野</th><th>正解数</th><th>正答率</th></tr></thead><tbody>${breakdown}</tbody></table>`;
  state.session = null;
  currentSession = null;
  saveState();
  renderDashboard();
  switchView("resultView");
}

function startTimerIfNeeded() {
  stopTimer();
  if (!currentSession?.timerEnd) { $("#timer").hidden = true; return; }
  $("#timer").hidden = false;
  const update = () => {
    const left = Math.max(0, currentSession.timerEnd - Date.now());
    const minutes = Math.floor(left / 60000);
    const seconds = Math.floor((left % 60000) / 1000);
    $("#timer").textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    if (left <= 0) finishSession();
  };
  update();
  timerHandle = setInterval(update, 1000);
}
function stopTimer() { if (timerHandle) clearInterval(timerHandle); timerHandle = null; }

function toggleFavorite() {
  const q = currentQuestion();
  if (!q) return;
  if (state.favorites.includes(q.id)) state.favorites = state.favorites.filter((id) => id !== q.id);
  else state.favorites.push(q.id);
  saveState();
  const active = state.favorites.includes(q.id);
  $("#favoriteButton").textContent = active ? "★" : "☆";
  $("#favoriteButton").setAttribute("aria-pressed", String(active));
}

function renderDashboard() {
  $("#examDate").value = state.examDate;
  renderCountdown();
  const attempts = Object.values(state.history).reduce((sum, h) => sum + (h.attempts || 0), 0);
  const correct = Object.values(state.history).reduce((sum, h) => sum + (h.correct || 0), 0);
  $("#overallAccuracy").textContent = attempts ? `${Math.round(correct / attempts * 100)}%` : "—";
  $("#totalAnswers").textContent = state.totalAnswers;
  $("#currentStreak").textContent = state.currentStreak;
  $("#bestStreak").textContent = state.bestStreak;
  const rows = CATEGORY_ORDER.map((category) => {
    const ids = questions.filter((q) => q.category === category).map((q) => q.id);
    const records = ids.map(historyFor);
    const a = records.reduce((sum, h) => sum + h.attempts, 0);
    const c = records.reduce((sum, h) => sum + h.correct, 0);
    const rate = a ? Math.round(c / a * 100) : null;
    const weak = a > 0 && rate < 60;
    return `<tr class="${weak ? "weak-row" : ""}"><td>${category}</td><td>${rate === null ? "未回答" : `${rate}%`}</td><td>${a}</td><td>${ids.filter((id) => state.favorites.includes(id)).length}</td></tr>`;
  }).join("");
  $("#categoryStats").innerHTML = `<table><thead><tr><th>分野</th><th>正答率</th><th>回答数</th><th>お気に入り</th></tr></thead><tbody>${rows}</tbody></table>`;
  renderResumeButton();
}

function renderCountdown() {
  const value = state.examDate;
  if (!value) { $("#countdown").textContent = "未設定"; $("#examDateLabel").textContent = ""; return; }
  const exam = new Date(`${value}T00:00:00`);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.ceil((exam - today) / 86400000);
  $("#countdown").textContent = days >= 0 ? `${days}日` : `${Math.abs(days)}日経過`;
  $("#examDateLabel").textContent = new Intl.DateTimeFormat("ja-JP", { dateStyle: "long" }).format(exam);
}

function renderResumeButton() {
  document.querySelector("#resumeButton")?.remove();
  if (!state.session || !state.session.queue?.length) return;
  const button = document.createElement("button");
  button.id = "resumeButton";
  button.className = "primary";
  button.textContent = `前回の途中から再開（${state.session.index + 1}/${state.session.queue.length}問）`;
  button.addEventListener("click", () => startSession(state.session.mode, true));
  $(".mode-grid").after(button);
}

function switchView(viewId) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === viewId));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function exportData() {
  const payload = {
    schema: "fp2-pwa-backup-v1",
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    questions,
    state: { ...state, session: currentSession }
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `fp2-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showDataMessage("問題データと学習履歴をエクスポートしました。");
}

async function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const importedQuestions = Array.isArray(payload) ? payload : payload.questions;
    validateQuestions(importedQuestions);
    questions = importedQuestions;
    localStorage.setItem(QUESTIONS_KEY, JSON.stringify(questions));
    if (payload.state && typeof payload.state === "object") {
      state = { ...defaultState(), ...payload.state, session: null };
      currentSession = null;
    }
    saveState();
    initCategories();
    renderDashboard();
    showDataMessage(`${questions.length}問をインポートしました。`);
  } catch (error) {
    console.error(error);
    showDataMessage(`インポート失敗：${error.message}`, true);
  } finally {
    event.target.value = "";
  }
}

function resetHistory() {
  if (!confirm("学習履歴・正答率・連続正解・途中経過をリセットします。お気に入りと問題データは残します。よろしいですか？")) return;
  state.history = {};
  state.totalAnswers = 0;
  state.currentStreak = 0;
  state.bestStreak = 0;
  state.session = null;
  currentSession = null;
  saveState();
  renderDashboard();
  showDataMessage("学習履歴をリセットしました。");
}

function showDataMessage(message, isError = false) {
  const el = $("#dataMessage");
  el.textContent = message;
  el.style.color = isError ? "var(--danger)" : "var(--success)";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("#themeButton").textContent = theme === "dark" ? "☀️" : "🌙";
}

function updateNetworkStatus() {
  const online = navigator.onLine;
  $("#networkStatus").textContent = online ? "オンライン" : "オフライン利用中";
  $("#networkStatus").classList.toggle("offline", !online);
}

function bindEvents() {
  $$(".mode-card").forEach((button) => button.addEventListener("click", () => startSession(button.dataset.mode)));
  $("#answerForm").addEventListener("submit", submitAnswer);
  $("#nextButton").addEventListener("click", nextQuestion);
  $("#favoriteButton").addEventListener("click", toggleFavorite);
  $("#quitButton").addEventListener("click", () => {
    if (!currentSession || confirm("途中経過を保存してホームへ戻りますか？")) {
      stopTimer(); saveState(); renderDashboard(); switchView("dashboardView");
    }
  });
  $("#examDate").addEventListener("change", (event) => { state.examDate = event.target.value; saveState(); renderCountdown(); });
  $("#themeButton").addEventListener("click", () => { state.theme = state.theme === "dark" ? "light" : "dark"; applyTheme(state.theme); saveState(); });
  $("#selectAllButton").addEventListener("click", () => {
    const shouldSelect = $$("#categoryGrid input:checked").length !== CATEGORY_ORDER.length;
    $$("#categoryGrid input").forEach((input) => { input.checked = shouldSelect; });
    state.selectedCategories = shouldSelect ? [...CATEGORY_ORDER] : [];
    saveState();
    updateSelectAllLabel();
  });
  $("#exportButton").addEventListener("click", exportData);
  $("#importInput").addEventListener("change", importData);
  $("#resetButton").addEventListener("click", resetHistory);
  $("#homeButton").addEventListener("click", () => { renderDashboard(); switchView("dashboardView"); });
  $("#retryButton").addEventListener("click", () => startSession(state.lastMode || "weak"));
  window.addEventListener("online", updateNetworkStatus);
  window.addEventListener("offline", updateNetworkStatus);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $("#installButton").hidden = false;
  });
  $("#installButton").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $("#installButton").hidden = true;
  });
  window.addEventListener("appinstalled", () => { $("#installButton").hidden = true; });
}

async function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("service-worker.js"); }
    catch (error) { console.warn("Service Workerを登録できませんでした。", error); }
  }
}

async function init() {
  applyTheme(state.theme);
  updateNetworkStatus();
  bindEvents();
  try {
    await loadQuestions();
    initCategories();
    renderDashboard();
    await registerServiceWorker();
  } catch (error) {
    console.error(error);
    document.body.innerHTML = `<main><section class="card"><h1>読み込みエラー</h1><p>${error.message}</p><p>Webサーバー経由で開き、questions.jsonが同じフォルダーにあるか確認してください。</p></section></main>`;
  }
}

document.addEventListener("DOMContentLoaded", init);
