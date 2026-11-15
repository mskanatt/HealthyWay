// HealthyWay — Тренер по технике
//
// Камера -> MediaPipe Pose Landmarker (работает прямо в браузере, видео никуда не отправляется)
// -> углы суставов -> подсчёт повторов + проверка техники + голосовые подсказки.
//
// Поддерживаются: приседания (угол колена, наклон корпуса) и отжимания (угол локтя, прямая линия тела).
// Снимать нужно СБОКУ, чтобы всё тело было в кадре.

(function () {
  "use strict";

  const panel = document.getElementById("tab-trainer");
  if (!panel) return; // разметка тренера не добавлена на страницу

  // ---------- настройки (можно менять) ----------

  // Библиотека MediaPipe грузится с CDN. Если вдруг не грузится — смените версию (напр. на 0.10.14).
  const MP_VERSION = "0.10.3";
  const TASKS_VISION_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
  const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;

  // Сначала пробуем локальный файл модели (public/models/...), потом запасной адрес Google.
  const LOCAL_MODEL_URL = "/models/pose_landmarker_lite.task";
  const REMOTE_MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

  // Пороги углов (в градусах). Их стоит подбирать опытным путём.
  const CFG = {
    squat: { downEnter: 130, upExit: 160, depth: 105, leanMax: 55 },
    pushup: { downEnter: 120, upExit: 155, depth: 95, bodyMin: 150 },
  };

  const VIS_MIN = 0.5; // минимальная «видимость» точки, чтобы ей доверять
  const EMA = 0.4; // сглаживание углов (0..1, больше = быстрее реагирует, но дрожит сильнее)
  const BAD_FRAMES = 6; // сколько кадров подряд плохая форма, чтобы выдать замечание
  const STORAGE_KEY = "hw_trainer_sessions";

  const L = {
    left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 },
    right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 },
  };
  const NEED = {
    squat: ["shoulder", "hip", "knee", "ankle"],
    pushup: ["shoulder", "elbow", "wrist", "hip", "ankle"],
  };
  const CONNECTIONS = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24],
    [23, 25], [25, 27], [24, 26], [26, 28],
    [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
  ];
  const EXERCISE_NAME = { squat: "Приседания", pushup: "Отжимания" };
  const ANGLE_LABEL = { squat: "угол колена", pushup: "угол локтя" };

  // ---------- элементы страницы ----------

  const $ = (id) => document.getElementById(id);
  const stage = $("trainer-stage");
  const video = $("trainer-video");
  const canvas = $("trainer-canvas");
  const ctx = canvas.getContext("2d");
  const exerciseSel = $("trainer-exercise");
  const voiceCb = $("trainer-voice");
  const hud = $("trainer-hud");
  const repsEl = $("trainer-reps");
  const angleEl = $("trainer-angle");
  const angleLabelEl = $("trainer-angle-label");
  const cueEl = $("trainer-cue");
  const placeholder = $("trainer-placeholder");
  const startBtn = $("trainer-start-btn");
  const flipBtn = $("trainer-flip-btn");
  const stopBtn = $("trainer-stop-btn");
  const resetBtn = $("trainer-reset-btn");
  const statusEl = $("trainer-status");
  const summaryEl = $("trainer-summary");
  const summaryTextEl = $("trainer-summary-text");
  const aiBtn = $("trainer-ai-btn");
  const aiTextEl = $("trainer-ai-text");
  const historyEl = $("trainer-history");

  // ---------- состояние ----------

  let landmarker = null;
  let stream = null;
  let running = false;
  let rafId = 0;
  let lastVideoTime = -1;
  let facingMode = "user";
  let side = "left";
  let session = null;
  let tracker = null;
  let smoothMain = null;
  let smoothForm = null;
  let lastRecord = null;

  // ---------- математика ----------

  /** Угол в точке b (в градусах) между лучами b->a и b->c. Точки в пикселях. */
  function angle(a, b, c) {
    const v1x = a.x - b.x, v1y = a.y - b.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (!m) return null;
    const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / m));
    return (Math.acos(cos) * 180) / Math.PI;
  }

  /** Наклон корпуса от вертикали: 0° = плечо строго над тазом, 90° = корпус горизонтально. */
  function leanFromVertical(shoulder, hip) {
    const dx = shoulder.x - hip.x;
    const dy = hip.y - shoulder.y; // положительно, если плечо выше таза
    return (Math.abs(Math.atan2(dx, dy)) * 180) / Math.PI;
  }

  function avg(arr) {
    return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  }

  function plural(n, forms) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  // ---------- подсчёт повторов (конечный автомат) ----------

  function createTracker(exercise) {
    const c = CFG[exercise];
    let phase = "unknown"; // unknown -> up <-> down
    let minAngle = 999;
    let badFrames = 0;
    let flaggedForm = false;
    let cuedDepth = false;
    const stats = { reps: 0, partial: 0, cleanReps: 0, formIssues: 0, minAngles: [] };

    return {
      stats,
      get phase() { return phase; },
      update(m) {
        const events = [];
        const formBad = exercise === "squat" ? m.form > c.leanMax : m.form < c.bodyMin;

        // Пока человек не встал в исходное положение — ничего не считаем.
        if (phase === "unknown") {
          if (m.main > c.upExit) phase = "up";
          return { events, formBad: false };
        }

        if (phase === "up") {
          if (m.main < c.downEnter) {
            phase = "down";
            minAngle = m.main;
            badFrames = 0;
            flaggedForm = false;
            cuedDepth = false;
          }
          return { events, formBad };
        }

        // phase === "down"
        minAngle = Math.min(minAngle, m.main);

        if (formBad) {
          badFrames++;
          if (badFrames === BAD_FRAMES && !flaggedForm) {
            flaggedForm = true;
            events.push({ type: exercise === "squat" ? "lean" : "body" });
          }
        } else {
          badFrames = 0;
        }

        // Начал вставать, а до нужной глубины не дошёл.
        if (!cuedDepth && minAngle > c.depth && m.main - minAngle > 15) {
          cuedDepth = true;
          events.push({ type: "deeper" });
        }

        if (m.main > c.upExit) {
          phase = "up";
          if (minAngle <= c.depth) {
            stats.reps++;
            if (!flaggedForm) stats.cleanReps++;
            stats.minAngles.push(minAngle);
            events.push({ type: "rep", count: stats.reps, clean: !flaggedForm });
          } else {
            stats.partial++;
            events.push({ type: "partial" });
          }
          if (flaggedForm) stats.formIssues++;
        }
        return { events, formBad };
      },
    };
  }

  // ---------- подсказки: текст на экране + голос ----------

  let cueTimer = 0;
  let lastSpeechAt = 0;
  const spokenAt = {};

  function showCue(text, kind) {
    cueEl.textContent = text;
    cueEl.className = "trainer-cue trainer-cue-" + (kind || "ok");
    cueEl.hidden = false;
    clearTimeout(cueTimer);
    cueTimer = setTimeout(() => { cueEl.hidden = true; }, 1600);
  }

  let voicesCache = [];
  let currentUtterance = null; // держим ссылку: иначе Chrome может «потерять» фразу и промолчать

  function loadVoices() {
    if (!("speechSynthesis" in window)) return;
    voicesCache = speechSynthesis.getVoices() || [];
  }
  if ("speechSynthesis" in window) {
    loadVoices();
    // В Chrome список голосов подгружается с задержкой
    speechSynthesis.addEventListener("voiceschanged", loadVoices);
  }

  function pickVoice() {
    if (!voicesCache.length) loadVoices();
    return (
      voicesCache.find((v) => /^ru/i.test(v.lang)) ||
      voicesCache.find((v) => /russian|рус/i.test(v.name)) ||
      null
    );
  }

  function speak(text, opts) {
    const { priority = false, minGap = 5000 } = opts || {};
    if (!voiceCb.checked || !("speechSynthesis" in window)) return;
    const now = Date.now();
    if (spokenAt[text] && now - spokenAt[text] < minGap) return;
    if (!priority && (speechSynthesis.speaking || now - lastSpeechAt < 800)) return;

    lastSpeechAt = now;
    spokenAt[text] = now;

    const say = () => {
      try {
        speechSynthesis.resume(); // Chrome иногда «зависает» в паузе
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "ru-RU";
        u.rate = 1.05;
        u.volume = 1;
        const v = pickVoice();
        if (v) u.voice = v;
        u.onerror = (ev) => console.warn("speech error:", ev.error);
        currentUtterance = u;
        speechSynthesis.speak(u);
      } catch (err) {
        console.warn("speech failed:", err);
      }
    };

    if (priority && (speechSynthesis.speaking || speechSynthesis.pending)) {
      speechSynthesis.cancel(); // замечание важнее номера повтора
      // Chrome теряет фразу, если speak() вызвать сразу после cancel(), поэтому небольшая пауза
      setTimeout(say, 120);
    } else {
      say();
    }
  }

  function warmUpSpeech() {
    // Браузеры разрешают голос только после действия пользователя (клик на «Включить камеру»).
    // Здороваемся сразу: так слышно, что голос работает.
    if (!("speechSynthesis" in window)) {
      setStatus("Этот браузер не поддерживает голосовые подсказки.", "warn");
      return;
    }
    loadVoices();
    speak("Начинаем. Встаньте боком к камере.", { priority: true, minGap: 0 });
  }

  function handleEvent(e) {
    const ex = session.exercise;
    switch (e.type) {
      case "rep":
        showCue("Повтор " + e.count, "ok");
        speak(String(e.count));
        break;
      case "lean":
        showCue("Спину ровнее", "warn");
        speak("Спину ровнее", { priority: true });
        break;
      case "body":
        showCue("Корпус прямее", "warn");
        speak("Корпус прямее", { priority: true });
        break;
      case "deeper":
        showCue("Ниже", "warn");
        speak("Ниже", { priority: true });
        break;
      case "partial":
        showCue("Неполный повтор (не засчитан)", "warn");
        break;
    }
  }

  function setStatus(text, kind) {
    statusEl.textContent = text || "";
    statusEl.dataset.kind = kind || "";
  }

  // ---------- рисование скелета ----------

  function vis(p) {
    return p && (p.visibility === undefined || p.visibility > 0.3);
  }

  function drawSkeleton(lms, ex, idx, mode) {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = Math.max(3, W / 200);
    ctx.lineCap = "round";

    ctx.strokeStyle = "rgba(238,241,238,0.35)";
    for (const [a, b] of CONNECTIONS) {
      const p = lms[a], q = lms[b];
      if (!vis(p) || !vis(q)) continue;
      ctx.beginPath();
      ctx.moveTo(p.x * W, p.y * H);
      ctx.lineTo(q.x * W, q.y * H);
      ctx.stroke();
    }

    const color = mode === "ok" ? "#6be37b" : mode === "bad" ? "#e37b6b" : "#e3b06b";
    const chains = ex === "squat"
      ? [["shoulder", "hip", "knee", "ankle"]]
      : [["shoulder", "elbow", "wrist"], ["shoulder", "hip", "ankle"]];

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(4, W / 150);
    for (const chain of chains) {
      ctx.beginPath();
      chain.forEach((k, i) => {
        const p = lms[idx[k]];
        if (i === 0) ctx.moveTo(p.x * W, p.y * H);
        else ctx.lineTo(p.x * W, p.y * H);
      });
      ctx.stroke();
      chain.forEach((k) => {
        const p = lms[idx[k]];
        ctx.beginPath();
        ctx.arc(p.x * W, p.y * H, Math.max(5, W / 110), 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  // ---------- обработка кадра ----------

  function chooseSide(lms, ex) {
    const sum = (s) => NEED[ex].reduce((a, k) => a + (lms[L[s][k]].visibility || 0), 0);
    const l = sum("left"), r = sum("right");
    if (side === "left" && r > l + 0.4) side = "right";
    else if (side === "right" && l > r + 0.4) side = "left";
  }

  function updateHud() {
    repsEl.textContent = tracker ? tracker.stats.reps : 0;
    angleEl.textContent = smoothMain == null ? "--" : Math.round(smoothMain) + "°";
    angleLabelEl.textContent = session ? ANGLE_LABEL[session.exercise] : "угол";
  }

  function onNoPose() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    smoothMain = smoothForm = null;
    updateHud();
    setStatus("Вас не видно. Отойдите от камеры на 2–3 метра и встаньте боком.", "warn");
  }

  function onPose(lms) {
    if (!session || !tracker) return;
    const W = video.videoWidth, H = video.videoHeight;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    const ex = session.exercise;
    chooseSide(lms, ex);
    const idx = L[side];
    const visible = NEED[ex].every((k) => (lms[idx[k]].visibility ?? 1) >= VIS_MIN);

    if (!visible) {
      drawSkeleton(lms, ex, idx, "warn");
      smoothMain = smoothForm = null;
      updateHud();
      setStatus("Встаньте боком так, чтобы всё тело было в кадре.", "warn");
      speak("Встаньте боком, чтобы всё тело было в кадре", { minGap: 15000 });
      return;
    }

    const P = (k) => ({ x: lms[idx[k]].x * W, y: lms[idx[k]].y * H }); // в пикселях, чтобы углы не искажались
    let main, form;
    if (ex === "squat") {
      main = angle(P("hip"), P("knee"), P("ankle"));
      form = leanFromVertical(P("shoulder"), P("hip"));
    } else {
      main = angle(P("shoulder"), P("elbow"), P("wrist"));
      form = angle(P("shoulder"), P("hip"), P("ankle"));
    }
    if (main == null || form == null) return;

    smoothMain = smoothMain == null ? main : smoothMain + EMA * (main - smoothMain);
    smoothForm = smoothForm == null ? form : smoothForm + EMA * (form - smoothForm);

    const out = tracker.update({ main: smoothMain, form: smoothForm });
    drawSkeleton(lms, ex, idx, out.formBad ? "bad" : "ok");
    updateHud();
    out.events.forEach(handleEvent);

    if (tracker.phase === "unknown") {
      setStatus(ex === "squat" ? "Встаньте прямо — и начинайте приседания." : "Примите упор лёжа на прямых руках — и начинайте.", "");
    } else {
      setStatus("Следим за техникой…", "ok");
    }
  }

  function loop() {
    if (!running) return;
    if (video.readyState >= 2 && video.videoWidth && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      try {
        const result = landmarker.detectForVideo(video, performance.now());
        const lms = result && result.landmarks && result.landmarks[0];
        if (lms) onPose(lms);
        else onNoPose();
      } catch (err) {
        console.error("Pose detection error:", err);
      }
    }
    rafId = requestAnimationFrame(loop);
  }

  // ---------- загрузка модели ----------

  async function loadLandmarker() {
    if (landmarker) return landmarker;
    let lastErr;
    try {
      const { PoseLandmarker, FilesetResolver } = await import(TASKS_VISION_URL);
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      for (const modelAssetPath of [LOCAL_MODEL_URL, REMOTE_MODEL_URL]) {
        for (const delegate of ["GPU", "CPU"]) {
          try {
            landmarker = await PoseLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetPath, delegate },
              runningMode: "VIDEO",
              numPoses: 1,
              minPoseDetectionConfidence: 0.5,
              minPosePresenceConfidence: 0.5,
              minTrackingConfidence: 0.5,
            });
            return landmarker;
          } catch (err) {
            lastErr = err;
          }
        }
      }
    } catch (err) {
      lastErr = err;
    }
    console.error("Не удалось загрузить MediaPipe:", lastErr);
    const e = new Error("model");
    e.name = "ModelLoadError";
    throw e;
  }

  // ---------- камера ----------

  function friendlyError(err) {
    switch (err && err.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Доступ к камере запрещён. Разрешите камеру в настройках браузера и попробуйте снова.";
      case "NotFoundError":
        return "Камера не найдена.";
      case "NotReadableError":
        return "Камера занята другим приложением. Закройте его и попробуйте снова.";
      case "ModelLoadError":
        return "Не удалось загрузить модель ИИ. Проверьте интернет или положите файл модели в public/models/.";
      default:
        return "Не удалось запустить камеру: " + ((err && err.message) || "неизвестная ошибка");
    }
  }

  function openStream() {
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 960 }, height: { ideal: 720 } },
      audio: false,
    });
  }

  async function waitForVideoSize() {
    if (video.videoWidth) return;
    await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
  }

  async function startCamera() {
    if (running) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("Камера недоступна: откройте сайт по https:// или на localhost.", "error");
      return;
    }
    startBtn.disabled = true;
    try {
      setStatus("Загружаем модель ИИ (в первый раз может занять 10–20 секунд)…");
      await loadLandmarker();
      setStatus("Запрашиваем доступ к камере…");
      stream = await openStream();
      video.srcObject = stream;
      await video.play();
      await waitForVideoSize();

      stage.classList.toggle("mirrored", facingMode === "user");
      video.hidden = false;
      placeholder.hidden = true;
      hud.hidden = false;
      summaryEl.hidden = true;
      startBtn.hidden = true;
      stopBtn.hidden = false;
      flipBtn.hidden = false;
      resetBtn.hidden = false;

      running = true;
      lastVideoTime = -1;
      beginSession();
      warmUpSpeech();
      setStatus("Встаньте боком к камере так, чтобы было видно всё тело.");
      loop();
    } catch (err) {
      console.error(err);
      stopCamera();
      setStatus(friendlyError(err), "error");
    } finally {
      startBtn.disabled = false;
    }
  }

  function stopCamera() {
    const wasRunning = running;
    running = false;
    cancelAnimationFrame(rafId);
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.srcObject = null;
    video.hidden = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    placeholder.hidden = false;
    hud.hidden = true;
    cueEl.hidden = true;
    startBtn.hidden = false;
    stopBtn.hidden = true;
    flipBtn.hidden = true;
    resetBtn.hidden = true;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (wasRunning) {
      finishSession();
      setStatus("");
    }
  }

  async function flipCamera() {
    if (!running) return;
    const prev = facingMode;
    facingMode = facingMode === "user" ? "environment" : "user";
    try {
      stream.getTracks().forEach((t) => t.stop());
      stream = await openStream();
      video.srcObject = stream;
      await video.play();
      stage.classList.toggle("mirrored", facingMode === "user");
      lastVideoTime = -1;
    } catch (err) {
      console.error(err);
      facingMode = prev;
      setStatus("Не удалось переключить камеру.", "error");
    }
  }

  // ---------- сессии и история ----------

  function beginSession() {
    session = { exercise: exerciseSel.value, startedAt: Date.now() };
    tracker = createTracker(session.exercise);
    smoothMain = smoothForm = null;
    updateHud();
  }

  function finishSession() {
    if (!session || !tracker) return;
    const st = tracker.stats;
    if (st.reps + st.partial > 0) {
      const rec = {
        ts: Date.now(),
        exercise: session.exercise,
        reps: st.reps,
        partial: st.partial,
        cleanReps: st.cleanReps,
        formIssues: st.formIssues,
        avgMinAngle: Math.round(avg(st.minAngles)),
        durationSec: Math.round((Date.now() - session.startedAt) / 1000),
      };
      saveSession(rec);
      showSummary(rec);
    }
    session = null;
    tracker = null;
  }

  function loadSessions() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function saveSession(rec) {
    try {
      const all = loadSessions();
      all.unshift(rec);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all.slice(0, 30)));
    } catch {
      /* хранилище недоступно — не страшно */
    }
    renderHistory();
  }

  function repsLabel(n) {
    return n + " " + plural(n, ["повтор", "повтора", "повторов"]);
  }

  function showSummary(rec) {
    lastRecord = rec;
    const parts = [
      EXERCISE_NAME[rec.exercise] + ": " + repsLabel(rec.reps),
      "без замечаний по форме: " + rec.cleanReps,
    ];
    if (rec.partial) parts.push("неполных (не засчитано): " + rec.partial);
    if (rec.formIssues) parts.push("с замечаниями по форме: " + rec.formIssues);
    if (rec.avgMinAngle) parts.push("средний угол в нижней точке: " + rec.avgMinAngle + "°");
    summaryTextEl.textContent = parts.join(" · ");
    aiTextEl.hidden = true;
    aiTextEl.textContent = "";
    aiBtn.disabled = false;
    summaryEl.hidden = false;
  }

  function renderHistory() {
    historyEl.textContent = "";
    const all = loadSessions().slice(0, 8);
    if (!all.length) return;
    const title = document.createElement("h3");
    title.className = "trainer-history-title";
    title.textContent = "Последние тренировки";
    historyEl.appendChild(title);
    all.forEach((s) => {
      const row = document.createElement("div");
      row.className = "trainer-history-row";
      const name = document.createElement("span");
      name.textContent = (EXERCISE_NAME[s.exercise] || s.exercise) + " — " + repsLabel(s.reps || 0);
      const date = document.createElement("span");
      date.className = "trainer-history-date";
      date.textContent = new Date(s.ts).toLocaleString("ru-RU", {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      });
      row.appendChild(name);
      row.appendChild(date);
      historyEl.appendChild(row);
    });
  }

  // ---------- совет от ИИ (нужен эндпоинт /api/trainer-feedback в server.js) ----------

  aiBtn.addEventListener("click", async () => {
    if (!lastRecord) return;
    aiBtn.disabled = true;
    aiTextEl.hidden = false;
    aiTextEl.textContent = "ИИ анализирует тренировку…";
    try {
      const res = await fetch("/api/trainer-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lastRecord),
      });
      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error("Сервер вернул неожиданный ответ (добавлен ли /api/trainer-feedback в server.js?).");
      }
      if (!res.ok) throw new Error(data.error || "Не удалось получить совет.");
      aiTextEl.textContent = data.feedback;
    } catch (err) {
      aiTextEl.textContent = err.message || "Не удалось получить совет.";
    } finally {
      aiBtn.disabled = false;
    }
  });

  // ---------- события интерфейса ----------

  startBtn.addEventListener("click", startCamera);
  stopBtn.addEventListener("click", stopCamera);
  flipBtn.addEventListener("click", flipCamera);
  resetBtn.addEventListener("click", () => {
    if (!running || !session) return;
    tracker = createTracker(session.exercise);
    session.startedAt = Date.now();
    updateHud();
    showCue("Счётчик сброшен", "ok");
  });

  exerciseSel.addEventListener("change", () => {
    if (!running) return;
    finishSession();
    beginSession();
  });

  // Переключение вкладок: наш обработчик срабатывает после основного (скрипт подключён последним).
  const nav = document.getElementById("bottom-nav");
  if (nav) {
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tab]");
      if (!btn) return;
      if (btn.dataset.tab === "trainer") {
        document.querySelectorAll("[data-tab-panel]").forEach((p) => {
          p.hidden = p.dataset.tabPanel !== "trainer";
        });
        nav.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b === btn));
        renderHistory();
      } else {
        panel.hidden = true;
        stopCamera(); // уходим с вкладки — выключаем камеру
      }
    });
  }

  window.addEventListener("pagehide", stopCamera);

  renderHistory();
  updateHud();
})();
