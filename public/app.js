// HealthyWay frontend
// This file never talks to Gemini directly. It only talks to OUR backend
// (server.js), which holds the real Gemini API key. See README.md for why.

const BACKEND_URL = ""; // same-origin. If backend runs elsewhere, e.g. "https://your-backend.onrender.com"

const MAX_FILE_MB = 8;
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

// ---------- generic helpers ----------

function bytesToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result looks like "data:image/jpeg;base64,AAAA..."
      const base64 = reader.result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
}

function validateImageFile(file) {
  if (!file) return "No file selected.";
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return "Please choose a JPG, PNG, or WEBP image.";
  }
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    return `That image is over ${MAX_FILE_MB}MB — please choose a smaller one.`;
  }
  return null; // valid
}

async function postImageToBackend(endpoint, base64Image, mimeType) {
  const res = await fetch(BACKEND_URL + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64Image, mimeType }),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("The server sent back something unexpected. Please try again.");
  }

  if (!res.ok) {
    // backend sends { error: "human readable message" }
    throw new Error(data.error || "The request failed. Please try again.");
  }

  return data;
}

// ---------- generic upload-widget wiring ----------
// Both features share the same UI pattern, so one function wires up each one.

function setupUploadWidget({ prefix, endpoint, onResult }) {
  const dropzone = document.getElementById(`${prefix}-dropzone`);
  const input = document.getElementById(`${prefix}-input`);
  const emptyState = document.getElementById(`${prefix}-empty`);
  const previewImg = document.getElementById(`${prefix}-preview`);
  const analyzeBtn = document.getElementById(`${prefix}-analyze-btn`);
  const resetBtn = document.getElementById(`${prefix}-reset-btn`);

  const idleEl = document.getElementById(`${prefix}-idle`);
  const loadingEl = document.getElementById(`${prefix}-loading`);
  const errorEl = document.getElementById(`${prefix}-error`);
  const errorTextEl = document.getElementById(`${prefix}-error-text`);
  const retryBtn = document.getElementById(`${prefix}-retry-btn`);
  const resultEl = document.getElementById(`${prefix}-result`);
  const savedNoteEl = document.getElementById(`${prefix}-saved-note`);

  let currentFile = null;

  function showState(state) {
    idleEl.hidden = state !== "idle";
    loadingEl.hidden = state !== "loading";
    errorEl.hidden = state !== "error";
    resultEl.hidden = state !== "result";
  }

  function setFile(file) {
    const problem = validateImageFile(file);
    if (problem) {
      showState("error");
      errorTextEl.textContent = problem;
      return;
    }
    currentFile = file;
    const url = URL.createObjectURL(file);
    previewImg.src = url;
    previewImg.hidden = false;
    emptyState.hidden = true;
    analyzeBtn.disabled = false;
    resetBtn.hidden = false;
    if (savedNoteEl) savedNoteEl.hidden = true;
    showState("idle");
  }

  function reset() {
    currentFile = null;
    previewImg.hidden = true;
    previewImg.src = "";
    emptyState.hidden = false;
    analyzeBtn.disabled = true;
    resetBtn.hidden = true;
    input.value = "";
    showState("idle");
  }

  // file picked via click
  input.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) setFile(e.target.files[0]);
  });

  // drag and drop
  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag-over");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag-over");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) setFile(file);
  });

  resetBtn.addEventListener("click", reset);
  retryBtn.addEventListener("click", () => showState("idle"));

  analyzeBtn.addEventListener("click", async () => {
    if (!currentFile) return;
    showState("loading");
    try {
      const base64 = await bytesToBase64(currentFile);
      const data = await postImageToBackend(endpoint, base64, currentFile.type);
      onResult(data, currentFile);
      showState("result");
    } catch (err) {
      showState("error");
      errorTextEl.textContent = err.message || "Something went wrong. Please try again.";
    }
  });
}

// ---------- food result rendering ----------

setupUploadWidget({
  prefix: "food",
  endpoint: "/api/analyze-food",
  onResult(data, file) {
    // expected shape from backend:
    // { foodName, portionDescription, calories, proteinGrams, fatGrams, carbsGrams, confidence }
    document.getElementById("food-name").textContent = data.foodName || "Unrecognized dish";
    document.getElementById("food-portion").textContent = data.portionDescription || "";
    document.getElementById("food-cal").textContent = Math.round(data.calories ?? 0);
    document.getElementById("food-protein").textContent = `${Math.round(data.proteinGrams ?? 0)}g`;
    document.getElementById("food-fat").textContent = `${Math.round(data.fatGrams ?? 0)}g`;
    document.getElementById("food-carbs").textContent = `${Math.round(data.carbsGrams ?? 0)}g`;
    document.getElementById("food-confidence").textContent = data.confidence
      ? `Confidence: ${data.confidence}`
      : "";

    // Save this scan to the Profile tab's history (see history.js).
    if (window.HealthyWayHistory) {
      window.HealthyWayHistory.addEntry("food", data, file).then(() => {
        const note = document.getElementById("food-saved-note");
        if (note) note.hidden = false;
      });
    }
  },
});

// ---------- body-fat result rendering ----------

setupUploadWidget({
  prefix: "body",
  endpoint: "/api/analyze-body",
  onResult(data, file) {
    // expected shape from backend:
    // { rangeLow, rangeHigh, category, muscleLow, muscleHigh, muscleCategory, confidence }
    document.getElementById("body-range-low").textContent = data.rangeLow ?? "--";
    document.getElementById("body-range-high").textContent = data.rangeHigh ?? "--";
    document.getElementById("body-category").textContent = data.category || "";
    document.getElementById("body-muscle-low").textContent = data.muscleLow ?? "--";
    document.getElementById("body-muscle-high").textContent = data.muscleHigh ?? "--";
    document.getElementById("body-muscle-category").textContent = data.muscleCategory || "";
    document.getElementById("body-confidence").textContent = data.confidence
      ? `Confidence: ${data.confidence}`
      : "";

    // Reset the recommendation panel for this fresh result.
    resetRecommendationPanel();
    currentBodyFatRange = { low: Number(data.rangeLow) || 0, high: Number(data.rangeHigh) || 0 };

    // Save this scan to the Profile tab's history (see history.js).
    if (window.HealthyWayHistory) {
      window.HealthyWayHistory.addEntry("body", data, file).then(() => {
        const note = document.getElementById("body-saved-note");
        if (note) note.hidden = false;
      });
    }
  },
});

// ---------- calorie & macro recommendation (plain formula, not AI) ----------

let currentBodyFatRange = null; // set from the most recent body-scan result

function resetRecommendationPanel() {
  document.getElementById("reco-form").hidden = true;
  document.getElementById("reco-result").hidden = true;
  document.getElementById("reco-minor-notice").hidden = true;
  document.getElementById("reco-toggle-btn").hidden = false;
  document.getElementById("reco-form").reset();
}

document.getElementById("reco-toggle-btn").addEventListener("click", () => {
  document.getElementById("reco-form").hidden = false;
  document.getElementById("reco-toggle-btn").hidden = true;
});

/** Mifflin-St Jeor BMR, the standard formula used by most fitness calculators. */
function calcBMR({ weightKg, heightCm, age, sex }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === "male" ? base + 5 : base - 161;
}

document.getElementById("reco-form").addEventListener("submit", (e) => {
  e.preventDefault();

  const weightKg = parseFloat(document.getElementById("reco-weight").value);
  const heightCm = parseFloat(document.getElementById("reco-height").value);
  const age = parseInt(document.getElementById("reco-age").value, 10);
  const sex = document.getElementById("reco-sex").value;
  const activityMultiplier = parseFloat(document.getElementById("reco-activity").value);

  if (!weightKg || !heightCm || !age) return; // basic guard; the form's own validation covers most of this

  // Growing bodies have different nutritional needs — don't hand out a diet target here.
  if (age < 18) {
    document.getElementById("reco-form").hidden = true;
    document.getElementById("reco-minor-notice").hidden = false;
    return;
  }

  const bmr = calcBMR({ weightKg, heightCm, age, sex });
  const tdee = bmr * activityMultiplier;

  const fatMid = currentBodyFatRange
    ? (currentBodyFatRange.low + currentBodyFatRange.high) / 2
    : null;

  let goalTitle, goalSub, calories, proteinPerKg, fatPerKg;

  if (fatMid !== null && fatMid > 20) {
    // Cutting: moderate deficit, higher protein to preserve muscle.
    goalTitle = "Suggested target: gradual fat loss";
    goalSub = "Based on your estimated body-fat range being above 20%.";
    calories = tdee * 0.8; // ~20% deficit — a commonly used, sustainable range
    proteinPerKg = 2.0;
    fatPerKg = 0.8;
  } else if (fatMid !== null && fatMid < 12) {
    // Lean: modest surplus to support muscle gain.
    goalTitle = "Suggested target: lean muscle gain";
    goalSub = "Based on your estimated body-fat range being on the leaner side.";
    calories = tdee * 1.12; // ~12% surplus
    proteinPerKg = 1.8;
    fatPerKg = 0.9;
  } else {
    goalTitle = "Suggested target: maintenance";
    goalSub = "Your estimated body-fat range is in a middle zone — this keeps your intake near what you burn.";
    calories = tdee;
    proteinPerKg = 1.6;
    fatPerKg = 0.9;
  }

  // Safety floor: never suggest an unreasonably low number regardless of the math above.
  const floor = sex === "male" ? 1500 : 1200;
  calories = Math.max(calories, floor);

  const proteinGrams = proteinPerKg * weightKg;
  const fatGrams = fatPerKg * weightKg;
  const proteinCals = proteinGrams * 4;
  const fatCals = fatGrams * 9;
  const carbsGrams = Math.max(0, (calories - proteinCals - fatCals) / 4);

  document.getElementById("reco-goal-title").textContent = goalTitle;
  document.getElementById("reco-goal-sub").textContent = goalSub;
  document.getElementById("reco-cal").textContent = Math.round(calories);
  document.getElementById("reco-protein").textContent = `${Math.round(proteinGrams)}g`;
  document.getElementById("reco-fat").textContent = `${Math.round(fatGrams)}g`;
  document.getElementById("reco-carbs").textContent = `${Math.round(carbsGrams)}g`;

  document.getElementById("reco-minor-notice").hidden = true;
  document.getElementById("reco-result").hidden = false;
});