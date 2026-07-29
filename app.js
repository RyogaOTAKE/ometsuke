/**
 * OMETSUKE — カメラで作業姿勢を見守るポモドーロ アプリのプロトタイプです。
 *
 * MediaPipe Face Landmarker をブラウザ内 (WASM) で動かし、顔の有無と顔の向きから
 * 「作業ゾーンにいるか」を毎秒判定します。映像は端末外へ一切送信しません。
 * 集中の中身そのものは測れないため、あくまで「作業姿勢の維持度」を測る設計です。
 */

/**
 * MediaPipe Tasks Vision の配布元です。お勤めを始めるときに動的に読み込みます。
 * 静的 import にすると、CDN に届かないときに画面そのものが動かなくなるためです。
 */
const TASKS_VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

/** 動作パラメータをまとめた設定です。しきい値の調整はここだけで済むようにしています。 */
const CONFIG = {
  // 基準姿勢からのずれの許容量 (度) です。これを超えると「よそ見」とみなします。
  yawToleranceDeg: 25,
  pitchToleranceDeg: 20,
  // ゾーン外が続いてもすぐ減点しない猶予 (ミリ秒) です。一瞬の首振りで減点しないためです。
  graceMs: 3000,
  // 検知結果がこの時間より古い場合は「検知が止まっている」= ゾーン外として扱います。
  staleMs: 2000,
  // 裏タブではタイマー遅延が起きやすいので、すぐ離席扱いにしない猶予を長めにします。
  backgroundStaleMs: 5000,
  calibrationMs: 3000,
  // 前面タブでは rAF で回しつつ、この間隔で推論を間引きます。
  detectionIntervalMs: 150,
  // 裏タブでは rAF が止まるため setInterval で回します (ブラウザの最低間隔はおおむね 1 秒です)。
  backgroundDetectionIntervalMs: 1000,
  timelineBucketSec: 30,
  breakMinutes: 5,
  historyMax: 30,
};

/** localStorage のキー名です。 */
const STORAGE_KEYS = {
  totalKoban: "ometsuke.totalKoban",
  history: "ometsuke.history",
  speechEnabled: "ometsuke.speechEnabled",
};

/**
 * 検知状態に応じたお目付け役のせりふです。同じ状態が続くあいだは同じせりふのまま、
 * 状態が変わったときに 1 つ選び直します (毎秒入れ替わるとうるさいためです)。
 */
const STATUS_LINES = {
  focused: ["うむ、励んでおるな。", "その調子じゃ、そのまま。", "よいよい、しかと見ておる。"],
  away: ["……よそ見をしておらぬか？", "こら、どこを見ておる。", "気が逸れておるぞ、戻れ戻れ。"],
  missing: ["席を外しておるのか？", "はて、姿が見えぬが……", "どこへ行った。戻られよ。"],
};

/** 検知状態と、お目付け役の表情 (data-mood) の対応です。 */
const STATE_MOOD = {
  focused: "watch",
  away: "doubt",
  missing: "search",
};

/** ホーム画面でお目付け役が言うあいさつです。 */
const HOME_LINES = [
  "うむ、来たか。今日も励むかの。",
  "支度はよいか。しかと見届けるぞ。",
  "さて、本日のお勤めはいかほどに？",
  "よう参った。まずは一勝負といこう。",
];

/** キャリブレーション直後、お勤め開始時のせりふです。 */
const START_LINES = [
  "うむ、はじめるぞ。励まれよ。",
  "しかと見届ける。その姿勢のまま参れ。",
  "よし、時を計る。集中じゃ。",
];

/** 休憩に入るときのせりふです。 */
const BREAK_LINES = [
  "わしも一服しておる。気を抜かれよ。",
  "ひと休みじゃ。肩の力を抜け。",
];

/**
 * 配列から 1 つを無作為に選びます。
 *
 * @param {Array<*>} items 選択肢の配列
 * @returns {*} 選ばれた要素
 */
function pickOne(items) {
  return items[Math.floor(Math.random() * items.length)];
}

// ---- DOM 要素 ----

const el = {
  screens: {
    home: document.getElementById("screen-home"),
    session: document.getElementById("screen-session"),
    result: document.getElementById("screen-result"),
    break: document.getElementById("screen-break"),
  },
  om: {
    home: document.getElementById("om-home"),
    session: document.getElementById("om-session"),
    result: document.getElementById("om-result"),
    break: document.getElementById("om-break"),
  },
  homeSpeech: document.getElementById("home-speech"),
  totalKoban: document.getElementById("total-koban"),
  historyList: document.getElementById("history-list"),
  btnStart: document.getElementById("btn-start"),
  homeError: document.getElementById("home-error"),
  video: document.getElementById("camera-video"),
  videoWrapper: document.querySelector(".video-wrapper"),
  sessionTimer: document.getElementById("session-timer"),
  sessionOverlay: document.getElementById("session-overlay"),
  overlayMessage: document.getElementById("overlay-message"),
  statusMessage: document.getElementById("status-message"),
  btnAbort: document.getElementById("btn-abort"),
  resultTitle: document.getElementById("result-title"),
  resultKoban: document.getElementById("result-koban"),
  resultKobanBox: document.querySelector(".result-koban"),
  resultComment: document.getElementById("result-comment"),
  resultRatio: document.getElementById("result-ratio"),
  resultFocusedTime: document.getElementById("result-focused-time"),
  timelineBars: document.getElementById("timeline-bars"),
  btnBreak: document.getElementById("btn-break"),
  btnHome: document.getElementById("btn-home"),
  breakTimer: document.getElementById("break-timer"),
  btnBreakEnd: document.getElementById("btn-break-end"),
  speechToggle: document.getElementById("speech-toggle"),
};

// ---- グローバル状態 ----

/** Face Landmarker のインスタンスです。初回セッション開始時に一度だけ生成します。 */
let faceLandmarker = null;

/** カメラの MediaStream です。セッション終了時に停止します。 */
let mediaStream = null;

/** 検知ループを止めるためのフラグです。 */
let detectionRunning = false;

/** 前面タブ用 requestAnimationFrame の ID です。 */
let detectionRafId = 0;

/** 裏タブ用 setInterval の ID です。 */
let detectionIntervalId = 0;

/** 直前に顔推論を実行した時刻 (performance.now) です。 */
let detectionLastRun = 0;

/**
 * 最新の検知結果です。検知ループが随時上書きし、毎秒の集計処理が参照します。
 * time は performance.now() 基準、yaw / pitch は度です。
 */
let latestDetection = { time: 0, faceFound: false, yaw: 0, pitch: 0 };

/** 進行中セッションの状態です。セッション外では null です。 */
let session = null;

/** setInterval / setTimeout の ID をまとめて管理し、画面遷移時に確実に止めます。 */
let timers = [];

/** 直前の検知状態です。状態が変わったときだけせりふを選び直すために持ちます。 */
let lastState = null;

/** Web Audio の AudioContext です。ユーザー操作をきっかけに生成・再開します。 */
let audioCtx = null;

/**
 * テスト用に、直近に鳴らした合図の名前を残します。
 * 本番の見た目には影響しません。
 */
const recentCues = [];

/**
 * テスト用に、直近に読み上げたせりふを残します。
 * 本番の見た目には影響しません。
 */
const recentSpeech = [];

/** 日本語向けに選んだ SpeechSynthesisVoice です。voiceschanged 後に入ります。 */
let preferredVoice = null;

/**
 * 読み上げ要求の世代番号です。
 * cancel 直後の speak が握りつぶされる環境向けに、古い予約を無効化します。
 */
let speakGeneration = 0;

// ---- 音声通知 ----

/**
 * AudioContext を用意し、停止中なら再開します。
 * ブラウザの自動再生制限を避けるため、クリックなどのユーザー操作の直後に呼びます。
 *
 * @returns {AudioContext|null} 利用可能な AudioContext。未対応環境では null
 */
function ensureAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    return null;
  }
  if (!audioCtx) {
    audioCtx = new Ctx();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {
      // 再開に失敗してもお勤め自体は続けます。
    });
  }
  return audioCtx;
}

/**
 * 短い単音を 1 つ鳴らします。
 *
 * @param {AudioContext} ctx 使用する AudioContext
 * @param {{freq: number, start: number, duration: number, gain?: number, type?: string}} opts 音の設定
 * @returns {void} 戻り値なし
 */
function playTone(ctx, opts) {
  const gain = opts.gain ?? 0.14;
  const type = opts.type ?? "sine";
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(opts.freq, opts.start);
  // 無音から急に立ち上げるとクリックノイズになるため、ごく短くフェードします。
  amp.gain.setValueAtTime(0.0001, opts.start);
  amp.gain.exponentialRampToValueAtTime(gain, opts.start + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.0001, opts.start + opts.duration);
  osc.connect(amp);
  amp.connect(ctx.destination);
  osc.start(opts.start);
  osc.stop(opts.start + opts.duration + 0.05);
}

/**
 * お勤めの節目を知らせる合図音を鳴らします。
 * 画面を隠して作業していても、開始と完走が耳で分かるようにします。
 *
 * @param {"start"|"complete"} kind 合図の種類
 * @returns {void} 戻り値なし
 */
function playCue(kind) {
  recentCues.push(kind);
  try {
    const ctx = ensureAudioContext();
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime + 0.01;
    if (kind === "start") {
      // 上がる二音で「はじめ」を知らせます。
      playTone(ctx, { freq: 523.25, start: t, duration: 0.18, gain: 0.12 });
      playTone(ctx, { freq: 659.25, start: t + 0.16, duration: 0.28, gain: 0.14 });
      return;
    }
    if (kind === "complete") {
      // 明るい三音で「完走」を知らせます。
      playTone(ctx, { freq: 523.25, start: t, duration: 0.15, gain: 0.12 });
      playTone(ctx, { freq: 659.25, start: t + 0.14, duration: 0.15, gain: 0.13 });
      playTone(ctx, { freq: 783.99, start: t + 0.28, duration: 0.42, gain: 0.15 });
    }
  } catch {
    // 音声が出せなくてもお勤めの進行は止めません。
  }
}

// ---- せりふの読み上げ (Web Speech API) ----

/**
 * せりふ読み上げの ON / OFF を読みます。未保存なら ON です。
 *
 * @returns {boolean} 読み上げるときは true
 */
function isSpeechEnabled() {
  const saved = localStorage.getItem(STORAGE_KEYS.speechEnabled);
  if (saved === null) {
    return true;
  }
  return saved === "1";
}

/**
 * せりふ読み上げの ON / OFF を保存し、トグル UI に反映します。
 *
 * @param {boolean} enabled 読み上げるときは true
 * @returns {void} 戻り値なし
 */
function setSpeechEnabled(enabled) {
  localStorage.setItem(STORAGE_KEYS.speechEnabled, enabled ? "1" : "0");
  if (el.speechToggle) {
    el.speechToggle.checked = enabled;
  }
  if (!enabled) {
    stopSpeaking();
  }
}

/**
 * 利用可能な声から日本語の声を選びます。
 * getVoices() は環境によって非同期で埋まるため、voiceschanged でも呼びます。
 *
 * @returns {void} 戻り値なし
 */
function refreshPreferredVoice() {
  if (!window.speechSynthesis) {
    preferredVoice = null;
    return;
  }
  const voices = window.speechSynthesis.getVoices();
  preferredVoice =
    voices.find((v) => v.lang === "ja-JP" && /male|男|otoya|ichiro|naoki/i.test(v.name)) ||
    voices.find((v) => v.lang.startsWith("ja")) ||
    null;
}

/**
 * 読み上げ中のせりふを止めます。
 *
 * @returns {void} 戻り値なし
 */
function stopSpeaking() {
  speakGeneration += 1;
  if (!window.speechSynthesis) {
    return;
  }
  try {
    window.speechSynthesis.cancel();
  } catch {
    // 止められなくても進行には影響しません。
  }
}

/**
 * お目付け役のせりふを声に出します。
 * ブラウザ標準の Speech Synthesis を使い、外部 API や音声ファイルは使いません。
 *
 * @param {string} text 読み上げる文言
 * @returns {void} 戻り値なし
 */
function speakLine(text) {
  const line = String(text || "").trim();
  if (!line) {
    return;
  }
  recentSpeech.push(line);
  if (!isSpeechEnabled() || !window.speechSynthesis) {
    return;
  }
  try {
    // 前のせりふが残っていると重なるため、いったん取り消します。
    const generation = ++speakGeneration;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(line);
    utterance.lang = "ja-JP";
    // 少し低め・控えめにして、お目付け役らしい落ち着きを出します。
    utterance.rate = 0.95;
    utterance.pitch = 0.85;
    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }
    // cancel 直後の speak が無視されるブラウザがあるため、短く間を置きます。
    setTimeout(() => {
      if (generation !== speakGeneration || !isSpeechEnabled()) {
        return;
      }
      try {
        window.speechSynthesis.speak(utterance);
      } catch {
        // 読み上げに失敗してもお勤め自体は続けます。
      }
    }, 40);
  } catch {
    // 読み上げに失敗してもお勤め自体は続けます。
  }
}

/**
 * 画面のせりふを更新し、設定が ON なら同時に読み上げます。
 *
 * @param {HTMLElement} node せりふを表示する要素
 * @param {string} text 表示・読み上げする文言
 * @returns {void} 戻り値なし
 */
function setCharacterSpeech(node, text) {
  node.textContent = text;
  speakLine(text);
}

// ---- お目付け役 (キャラクター) ----

/**
 * テンプレートの似顔絵を各画面のプレースホルダに複製します。
 *
 * @returns {void} 戻り値なし
 */
function renderMascots() {
  const template = document.getElementById("tpl-ometsuke");
  for (const node of Object.values(el.om)) {
    node.appendChild(template.content.cloneNode(true));
  }
}

/**
 * お目付け役の表情を切り替えます。表情ごとの見た目は CSS 側が持ちます。
 *
 * @param {HTMLElement} node 対象の .ometsuke 要素
 * @param {string} mood 表情名 ("idle" | "prep" | "watch" | "doubt" | "search" | "praise" | "gentle" | "rest")
 * @returns {void} 戻り値なし
 */
function setMood(node, mood) {
  node.dataset.mood = mood;
}

// ---- 画面遷移 ----

/**
 * 指定した画面だけを表示します。
 *
 * @param {string} name 表示する画面名 ("home" | "session" | "result" | "break")
 * @returns {void} 戻り値なし
 */
function showScreen(name) {
  for (const [key, screen] of Object.entries(el.screens)) {
    screen.hidden = key !== name;
  }
}

/**
 * 登録済みのタイマーをすべて解除します。
 *
 * @returns {void} 戻り値なし
 */
function clearTimers() {
  for (const id of timers) {
    clearInterval(id);
    clearTimeout(id);
  }
  timers = [];
}

// ---- 永続化 (localStorage) ----

/**
 * 累計小判枚数を読み込みます。
 *
 * @returns {number} 累計小判枚数 (未保存なら 0)
 */
function loadTotalKoban() {
  return Number(localStorage.getItem(STORAGE_KEYS.totalKoban)) || 0;
}

/**
 * 累計小判枚数を保存します。
 *
 * @param {number} total 保存する累計枚数
 * @returns {void} 戻り値なし
 */
function saveTotalKoban(total) {
  localStorage.setItem(STORAGE_KEYS.totalKoban, String(total));
}

/**
 * セッション履歴を読み込みます。
 *
 * @returns {Array<object>} 履歴の配列 (新しい順)。壊れている場合は空配列
 */
function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.history) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * セッション履歴の先頭に 1 件追加して保存します。
 *
 * @param {object} entry 追加する履歴 (date / durationMin / focusRatio / koban / completed)
 * @returns {void} 戻り値なし
 */
function pushHistory(entry) {
  const history = [entry, ...loadHistory()].slice(0, CONFIG.historyMax);
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(history));
}

// ---- ホーム画面の描画 ----

/**
 * 累計小判と履歴一覧を最新の保存内容で描画し直します。
 *
 * @param {{speak?: boolean}} [options] speak が true のとき、あいさつのせりふも読み上げます
 * @returns {void} 戻り値なし
 */
function renderHome(options = {}) {
  el.totalKoban.textContent = String(loadTotalKoban());
  const greeting = pickOne(HOME_LINES);
  if (options.speak) {
    setCharacterSpeech(el.homeSpeech, greeting);
  } else {
    el.homeSpeech.textContent = greeting;
  }
  setMood(el.om.home, "idle");
  if (el.speechToggle) {
    el.speechToggle.checked = isSpeechEnabled();
  }

  const history = loadHistory();
  el.historyList.innerHTML = "";
  if (history.length === 0) {
    const li = document.createElement("li");
    li.className = "history-empty";
    li.textContent = "まだ記録がありません。まずは一度、励んでみられよ。";
    el.historyList.appendChild(li);
    return;
  }
  for (const entry of history) {
    const li = document.createElement("li");
    const date = document.createElement("span");
    date.className = "history-date";
    date.textContent = entry.date;
    const body = document.createElement("span");
    const ratioText = `${Math.round(entry.focusRatio * 100)}%`;
    body.textContent = entry.completed
      ? `${entry.durationMin}分 集中率${ratioText} 🪙+${entry.koban}`
      : `${entry.durationMin}分 (中断)`;
    li.append(date, body);
    el.historyList.appendChild(li);
  }
}

// ---- カメラと顔検知 ----

/**
 * Face Landmarker を初期化します。2 回目以降は生成済みインスタンスを返します。
 *
 * @returns {Promise<object>} 初期化済みの Face Landmarker
 */
async function initFaceLandmarker() {
  if (faceLandmarker) {
    return faceLandmarker;
  }
  let FaceLandmarker;
  let FilesetResolver;
  try {
    ({ FaceLandmarker, FilesetResolver } = await import(TASKS_VISION_URL));
  } catch {
    throw new Error("見守りの仕掛けを取り寄せられませんでした。通信の具合をお確かめくだされ。");
  }
  const fileset = await FilesetResolver.forVisionTasks(`${TASKS_VISION_URL}/wasm`);
  faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    // 顔の向き (回転行列) を得るために変換行列の出力を有効にします。
    outputFacialTransformationMatrixes: true,
  });
  return faceLandmarker;
}

/**
 * カメラを起動して video 要素に接続します。
 *
 * @returns {Promise<void>} 再生開始まで待つ Promise
 */
async function startCamera() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: "user" },
    audio: false,
  });
  el.video.srcObject = mediaStream;
  await new Promise((resolve) => {
    el.video.onloadedmetadata = () => resolve();
  });
}

/**
 * カメラを停止して video 要素を切り離します。
 *
 * @returns {void} 戻り値なし
 */
function stopCamera() {
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
    mediaStream = null;
  }
  el.video.srcObject = null;
}

/**
 * 顔の変換行列から顔の向き (ヨー・ピッチ) を求めます。
 *
 * 行列は列優先の 4x4 で、第 3 列が顔の正面方向ベクトルです。正面ベクトルの
 * 水平成分からヨーを、垂直成分からピッチを計算します。符号の向きは環境に
 * よって揺れるため、絶対値ではなく基準姿勢との差分で使う前提です。
 *
 * @param {Float32Array} m 列優先 4x4 の顔変換行列 (長さ 16)
 * @returns {{yaw: number, pitch: number}} ヨーとピッチ (度)
 */
function extractHeadAngles(m) {
  const fx = m[8];
  const fy = m[9];
  const fz = m[10];
  const yaw = (Math.atan2(fx, fz) * 180) / Math.PI;
  const pitch = (Math.atan2(fy, Math.hypot(fx, fz)) * 180) / Math.PI;
  return { yaw, pitch };
}

/**
 * いまの表示状態に応じた検知間隔を返します。
 *
 * @returns {number} 推論の最小間隔 (ミリ秒)
 */
function currentDetectionIntervalMs() {
  return document.hidden ? CONFIG.backgroundDetectionIntervalMs : CONFIG.detectionIntervalMs;
}

/**
 * いまの表示状態に応じた「検知が古い」判定の閾値を返します。
 *
 * @returns {number} 古いとみなす経過時間 (ミリ秒)
 */
function currentStaleMs() {
  return document.hidden ? CONFIG.backgroundStaleMs : CONFIG.staleMs;
}

/**
 * video から顔を 1 回だけ推論し、latestDetection を更新します。
 *
 * @returns {void} 戻り値なし
 */
function runDetectionOnce() {
  if (!detectionRunning || !faceLandmarker) {
    return;
  }
  if (el.video.readyState < 2) {
    return;
  }
  const now = performance.now();
  if (now - detectionLastRun < currentDetectionIntervalMs()) {
    return;
  }
  detectionLastRun = now;
  try {
    const result = faceLandmarker.detectForVideo(el.video, now);
    const matrix = result.facialTransformationMatrixes?.[0]?.data;
    if (matrix) {
      const { yaw, pitch } = extractHeadAngles(matrix);
      latestDetection = { time: now, faceFound: true, yaw, pitch };
    } else {
      latestDetection = { time: now, faceFound: false, yaw: 0, pitch: 0 };
    }
  } catch {
    // 一時的な推論失敗では直前の結果を残し、次の周期に任せます。
  }
}

/**
 * 前面 / 裏タブ用の検知スケジューラをすべて外します。
 *
 * @returns {void} 戻り値なし
 */
function clearDetectionSchedulers() {
  if (detectionRafId) {
    cancelAnimationFrame(detectionRafId);
    detectionRafId = 0;
  }
  if (detectionIntervalId) {
    clearInterval(detectionIntervalId);
    detectionIntervalId = 0;
  }
}

/**
 * タブの表示状態に合わせて検知ループの回し方を選び直します。
 * 前面は requestAnimationFrame、裏は setInterval です。
 *
 * @returns {void} 戻り値なし
 */
function scheduleDetectionLoop() {
  clearDetectionSchedulers();
  if (!detectionRunning) {
    return;
  }

  if (document.hidden) {
    // 裏タブでは rAF が止まるため、タイマーで検知を続けます。
    detectionIntervalId = setInterval(runDetectionOnce, CONFIG.backgroundDetectionIntervalMs);
    runDetectionOnce();
    return;
  }

  const step = () => {
    if (!detectionRunning || document.hidden) {
      return;
    }
    runDetectionOnce();
    detectionRafId = requestAnimationFrame(step);
  };
  detectionRafId = requestAnimationFrame(step);
}

/**
 * 顔検知ループを開始します。
 * 前面タブでは rAF、裏タブでは setInterval で推論します。
 *
 * @returns {void} 戻り値なし
 */
function startDetectionLoop() {
  detectionRunning = true;
  detectionLastRun = 0;
  scheduleDetectionLoop();
}

/**
 * 顔検知ループを停止します。
 *
 * @returns {void} 戻り値なし
 */
function stopDetectionLoop() {
  detectionRunning = false;
  clearDetectionSchedulers();
}

/**
 * タブの表示 / 非表示が切り替わったときに、検知の回し方を張り直します。
 *
 * @returns {void} 戻り値なし
 */
function onVisibilityChange() {
  if (!detectionRunning) {
    return;
  }
  scheduleDetectionLoop();
}

// ---- キャリブレーション ----

/**
 * 数秒間の顔の向きを平均して基準姿勢を求めます。
 *
 * 作業中の自然な姿勢 (手元の本を見る、画面を見るなど) を基準にすることで、
 * カメラの設置角度や座り方の個人差を吸収します。
 *
 * @returns {Promise<{yaw: number, pitch: number}>} 基準姿勢。顔が見つからなければ reject
 */
function calibrate() {
  return new Promise((resolve, reject) => {
    const samples = [];
    const started = performance.now();

    const id = setInterval(() => {
      if (latestDetection.faceFound && latestDetection.time > started) {
        samples.push({ yaw: latestDetection.yaw, pitch: latestDetection.pitch });
      }
      const remaining = Math.ceil((started + CONFIG.calibrationMs - performance.now()) / 1000);
      el.overlayMessage.textContent =
        `その姿勢、しかと覚えるゆえ動くでないぞ… (${Math.max(remaining, 0)})`;

      if (performance.now() - started >= CONFIG.calibrationMs) {
        clearInterval(id);
        if (samples.length < 5) {
          reject(new Error("顔が見つかりませんでした。明るさとカメラの向きを確かめてください。"));
          return;
        }
        const avg = (key) => samples.reduce((sum, s) => sum + s[key], 0) / samples.length;
        resolve({ yaw: avg("yaw"), pitch: avg("pitch") });
      }
    }, 100);
    timers.push(id);
  });
}

// ---- セッション本体 ----

/**
 * 秒数を「m:ss」形式の文字列にします。
 *
 * 小数や負の値が渡っても表示が崩れないよう、整数に丸めて 0 で下げ止めます。
 *
 * @param {number} totalSec 変換する秒数
 * @returns {string} 「m:ss」形式の文字列
 */
function formatTime(totalSec) {
  const safeSec = Math.max(0, Math.round(totalSec));
  const min = Math.floor(safeSec / 60);
  const sec = safeSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

/**
 * お勤め (作業セッション) を開始します。カメラ・モデルの準備、
 * キャリブレーション、タイマーと毎秒の集計の起動までを行います。
 *
 * @param {number} durationMin セッションの長さ (分)
 * @returns {Promise<void>} セッションが動き出すまで待つ Promise
 */
async function startSession(durationMin) {
  el.homeError.hidden = true;
  el.btnStart.disabled = true;

  try {
    showScreen("session");
    setMood(el.om.session, "prep");
    lastState = null;
    el.sessionTimer.textContent = formatTime(durationMin * 60);
    setCharacterSpeech(el.statusMessage, "しばし待たれよ。支度をしておる…");
    el.sessionOverlay.hidden = false;
    // カウントダウン表示は頻繁に変わるため、読み上げず文字だけにします。
    el.overlayMessage.textContent = "お目付け役、ただいま参上仕る…";

    await startCamera();
    await initFaceLandmarker();
    startDetectionLoop();

    const baseline = await calibrate();
    el.sessionOverlay.hidden = true;

    session = {
      durationSec: durationMin * 60,
      remainingSec: durationMin * 60,
      focusedSec: 0,
      totalSec: 0,
      outZoneMs: 0,
      baseline,
      buckets: [{ focused: 0, total: 0 }],
    };

    // キャリブレーション直後 = タイマー開始の合図です。画面を隠しても耳で分かります。
    playCue("start");
    setCharacterSpeech(el.statusMessage, pickOne(START_LINES));
    // 直後の onSessionTick で同じ focused せりふを重ねないよう、開始直後は focused 扱いです。
    lastState = "focused";
    setMood(el.om.session, STATE_MOOD.focused);

    const id = setInterval(onSessionTick, 1000);
    timers.push(id);
  } catch (err) {
    cleanupSession();
    showScreen("home");
    el.homeError.textContent = `開始できませんでした: ${err.message}`;
    el.homeError.hidden = false;
  } finally {
    el.btnStart.disabled = false;
  }
}

/**
 * 毎秒呼ばれる集計処理です。検知結果から集中判定を行い、
 * タイマー表示と状態表示を更新します。
 *
 * @returns {void} 戻り値なし
 */
function onSessionTick() {
  if (!session) {
    return;
  }
  const now = performance.now();

  // 検知が古い (処理落ちや、ブラウザが裏タブのタイマーを大きく遅らせた場合) と
  // 顔が無い場合は離席扱いにします。裏タブ中は閾値を長めに取ります。
  const stale = now - latestDetection.time > currentStaleMs();
  const faceFound = !stale && latestDetection.faceFound;
  const inZone =
    faceFound &&
    Math.abs(latestDetection.yaw - session.baseline.yaw) <= CONFIG.yawToleranceDeg &&
    Math.abs(latestDetection.pitch - session.baseline.pitch) <= CONFIG.pitchToleranceDeg;

  // ゾーン外の継続時間を数え、猶予以内なら集中扱いのままにします。
  session.outZoneMs = inZone ? 0 : session.outZoneMs + 1000;
  const focused = session.outZoneMs <= CONFIG.graceMs;

  session.totalSec += 1;
  session.remainingSec -= 1;
  if (focused) {
    session.focusedSec += 1;
  }

  // タイムライン用に 30 秒刻みで集計します。
  let bucket = session.buckets[session.buckets.length - 1];
  if (bucket.total >= CONFIG.timelineBucketSec) {
    bucket = { focused: 0, total: 0 };
    session.buckets.push(bucket);
  }
  bucket.total += 1;
  if (focused) {
    bucket.focused += 1;
  }

  // 表示を更新します。
  el.sessionTimer.textContent = formatTime(session.remainingSec);
  const state = !faceFound ? "missing" : inZone ? "focused" : "away";
  el.videoWrapper.classList.remove("state-focused", "state-away", "state-missing");
  el.videoWrapper.classList.add(`state-${state}`);
  if (state !== lastState) {
    lastState = state;
    setMood(el.om.session, STATE_MOOD[state]);
    setCharacterSpeech(el.statusMessage, pickOne(STATUS_LINES[state]));
  }

  if (session.remainingSec <= 0) {
    finishSession(true);
  }
}

/**
 * 集中率に応じた小判の枚数を決めます。
 *
 * 完走そのものを主報酬 (3 枚) にし、集中率はボーナス扱いです。
 * スコア稼ぎ競争になりにくくするための設計です。
 *
 * @param {number} ratio 集中率 (0〜1)
 * @returns {number} 授与する小判の枚数
 */
function computeReward(ratio) {
  let koban = 3;
  if (ratio >= 0.9) {
    koban += 2;
  } else if (ratio >= 0.7) {
    koban += 1;
  }
  return koban;
}

/**
 * セッションを終了して結果画面を表示します。
 *
 * @param {boolean} completed 完走したかどうか (false は中断)
 * @returns {void} 戻り値なし
 */
function finishSession(completed) {
  const finished = session;
  cleanupSession();
  if (!finished) {
    return;
  }

  const ratio = finished.totalSec > 0 ? finished.focusedSec / finished.totalSec : 0;
  const koban = completed ? computeReward(ratio) : 0;
  const durationMin = Math.round(finished.durationSec / 60);

  // 完走したときだけ完了音を鳴らします。中断は静かに結果へ移ります。
  if (completed) {
    playCue("complete");
  }

  saveTotalKoban(loadTotalKoban() + koban);
  pushHistory({
    date: new Date().toLocaleDateString("sv-SE"),
    durationMin,
    focusRatio: ratio,
    koban,
    completed,
  });

  // 結果画面を組み立てます。
  const title = completed ? "お勤め、大儀であった。" : "今日はここまでか。";
  const comment = completed
    ? ratio >= 0.9
      ? "見事な精進ぶり。褒美を取らせる。"
      : ratio >= 0.7
        ? "なかなかの励みであった。"
        : "完走は立派。次はもう少し落ち着いて参ろう。"
    : "途中でやめても咎めはせぬ。また参られよ。";
  el.resultTitle.textContent = title;
  el.resultKoban.textContent = `+${koban}`;
  el.resultRatio.textContent = `${Math.round(ratio * 100)}%`;
  el.resultFocusedTime.textContent = formatTime(finished.focusedSec);
  el.resultComment.textContent = comment;
  // 結果のせりふはタイトルと感想を続けて読み、完走を耳でも伝えます。
  speakLine(`${title} ${comment}`);

  // 完走したときだけ喜ばせ、中断のときは穏やかな顔にします。
  setMood(el.om.result, completed ? "praise" : "gentle");
  // アニメーションを付け直すため、いったん外してから再度付けます。
  el.resultKobanBox.classList.remove("pop");
  void el.resultKobanBox.offsetWidth;
  el.resultKobanBox.classList.add("pop");

  el.timelineBars.innerHTML = "";
  for (const bucket of finished.buckets) {
    if (bucket.total === 0) {
      continue;
    }
    const bar = document.createElement("div");
    bar.className = "bar";
    const bucketRatio = bucket.focused / bucket.total;
    bar.style.height = `${Math.max(bucketRatio * 100, 6)}%`;
    bar.style.opacity = String(0.35 + bucketRatio * 0.65);
    el.timelineBars.appendChild(bar);
  }

  showScreen("result");
}

/**
 * セッションに関わるリソース (タイマー・検知ループ・カメラ) を後始末します。
 *
 * @returns {void} 戻り値なし
 */
function cleanupSession() {
  clearTimers();
  stopDetectionLoop();
  stopCamera();
  stopSpeaking();
  el.videoWrapper.classList.remove("state-focused", "state-away", "state-missing");
  lastState = null;
  session = null;
}

// ---- 休憩 ----

/**
 * 休憩タイマーを開始します。カメラは使いません。
 *
 * @returns {void} 戻り値なし
 */
function startBreak() {
  showScreen("break");
  setMood(el.om.break, "rest");
  speakLine(pickOne(BREAK_LINES));
  let remaining = CONFIG.breakMinutes * 60;
  el.breakTimer.textContent = formatTime(remaining);

  const id = setInterval(() => {
    remaining -= 1;
    el.breakTimer.textContent = formatTime(remaining);
    if (remaining <= 0) {
      clearInterval(id);
      renderHome({ speak: true });
      showScreen("home");
    }
  }, 1000);
  timers.push(id);
}

// ---- イベント登録と初期化 ----

el.btnStart.addEventListener("click", () => {
  // 自動再生制限を避けるため、クリック直後に AudioContext と声の一覧を起こします。
  ensureAudioContext();
  refreshPreferredVoice();
  const checked = document.querySelector('input[name="duration"]:checked');
  startSession(Number(checked.value));
});

if (el.speechToggle) {
  el.speechToggle.checked = isSpeechEnabled();
  el.speechToggle.addEventListener("change", () => {
    setSpeechEnabled(el.speechToggle.checked);
  });
}

if (window.speechSynthesis) {
  refreshPreferredVoice();
  window.speechSynthesis.addEventListener("voiceschanged", refreshPreferredVoice);
}

// テストから合図音・読み上げの発火を確認できるようにします。
window.__ometsukeTest = {
  /**
   * 直近に鳴らした合図の一覧を返します。
   *
   * @returns {string[]} 合図名の配列 ("start" / "complete")
   */
  getRecentCues() {
    return [...recentCues];
  },
  /**
   * 記録した合図を空にします。
   *
   * @returns {void} 戻り値なし
   */
  clearRecentCues() {
    recentCues.length = 0;
  },
  /**
   * 直近に読み上げたせりふの一覧を返します。
   *
   * @returns {string[]} せりふの配列
   */
  getRecentSpeech() {
    return [...recentSpeech];
  },
  /**
   * 記録したせりふを空にします。
   *
   * @returns {void} 戻り値なし
   */
  clearRecentSpeech() {
    recentSpeech.length = 0;
  },
  /**
   * 最新の顔検知時刻 (performance.now) を返します。
   *
   * @returns {number} 検知時刻
   */
  getLatestDetectionTime() {
    return latestDetection.time;
  },
  /**
   * 裏タブ用の setInterval 検知が張られているかを返します。
   *
   * @returns {boolean} 裏タブ用スケジューラ動作中なら true
   */
  isBackgroundDetectionScheduled() {
    return detectionIntervalId !== 0;
  },
};

document.addEventListener("visibilitychange", onVisibilityChange);

el.btnAbort.addEventListener("click", () => {
  if (session) {
    finishSession(false);
    return;
  }
  // 準備・キャリブレーション中の中断です。startSession 内の await が
  // 再開しないままになるため、開始ボタンの有効化までここで面倒を見ます。
  cleanupSession();
  el.btnStart.disabled = false;
  renderHome({ speak: true });
  showScreen("home");
});

el.btnBreak.addEventListener("click", () => {
  clearTimers();
  startBreak();
});

el.btnHome.addEventListener("click", () => {
  clearTimers();
  stopSpeaking();
  renderHome({ speak: true });
  showScreen("home");
});

el.btnBreakEnd.addEventListener("click", () => {
  clearTimers();
  stopSpeaking();
  renderHome({ speak: true });
  showScreen("home");
});

renderMascots();
renderHome();
showScreen("home");
