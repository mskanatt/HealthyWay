import "dotenv/config"
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Accept fairly large JSON bodies, since a base64 photo is bigger than the raw file.
app.use(express.json({ limit: "12mb" }));

// Serve the frontend (index.html, style.css, app.js) from /public
app.use(express.static(path.join(__dirname, "public")));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Gemini's model lineup changes over time. Keep this in one place, in .env,
// so you can bump it without touching code. Check https://ai.google.dev/gemini-api/docs/models
// for the current recommended vision-capable model name.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

if (!GEMINI_API_KEY) {
  console.warn(
    "WARNING: GEMINI_API_KEY is not set. Create a .env file (see .env.example)."
  );
}

// ---------- shared helpers ----------

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

/**
 * Calls Gemini with one image + one text prompt, and asks it to answer as JSON.
 * Returns the parsed JSON object, or throws an Error with a human-readable message.
 */
async function callGeminiForJson({ base64Image, mimeType, promptText }) {
  const body = {
    contents: [
      {
        parts: [
          { text: promptText },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Image,
            },
          },
        ],
      },
    ],
    generationConfig: {
      // Ask Gemini to return raw JSON instead of prose + markdown fences.
      response_mime_type: "application/json",
      temperature: 0.2,
    },
  };

  let response;
  try {
    response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Prevent a hung request from tying up the server forever.
      signal: AbortSignal.timeout(30000),
    });
  } catch (networkErr) {
    if (networkErr.name === "TimeoutError") {
      throw new Error("ИИ слишком долго отвечает. Попробуйте ещё раз.");
    }
    throw new Error("Не удалось связаться с сервисом ИИ. Проверьте подключение и попробуйте снова.");
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    console.error("Gemini API error:", response.status, errBody);
    if (response.status === 400) {
      throw new Error("Не удалось обработать это изображение. Попробуйте более чёткое фото.");
    }
    if (response.status === 429) {
      throw new Error("Слишком много запросов. Подождите немного и попробуйте снова.");
    }
    throw new Error("Проблема на стороне сервиса ИИ. Попробуйте ещё раз чуть позже.");
  }

  const data = await response.json();

  const textPart = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textPart) {
    // This happens sometimes if Gemini's safety filters block the image/response.
    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason === "SAFETY") {
      throw new Error("Это изображение отклонено фильтрами безопасности ИИ. Попробуйте другое фото.");
    }
    throw new Error("ИИ не вернул подходящий ответ. Попробуйте ещё раз.");
  }

  try {
    return JSON.parse(textPart);
  } catch {
    console.error("Failed to parse Gemini JSON output:", textPart);
    throw new Error("Ответ ИИ пришёл в неожиданном формате. Попробуйте ещё раз.");
  }
}

// ---------- /api/analyze-food ----------
// The prompts stay in English (the model follows them more reliably that way).
// JSON keys and the "low" | "medium" | "high" values stay in English too, so the
// frontend keeps working; only the human-readable text values are requested in Russian.

const FOOD_PROMPT = `
You are a nutrition estimation assistant. You will be shown one photo of a meal.

Identify the food and estimate its nutrition. Since you cannot weigh the food or see
ingredients hidden inside the dish (oil, butter, sauce, sugar), give your best-effort
approximate estimate rather than refusing.

Write every human-readable text value ("foodName", "portionDescription") in Russian.
Keep the JSON keys and the "confidence" values exactly as shown below (in English).

Respond with ONLY a JSON object in exactly this shape, no extra text, no markdown fences:

{
  "foodName": "short name of the dish in Russian, e.g. 'Куриная грудка на гриле с авокадо и зеленью'",
  "portionDescription": "one short sentence in Russian estimating portion size, e.g. 'Примерно 350 г, порция средняя'",
  "calories": <number, kcal for the whole visible portion>,
  "proteinGrams": <number>,
  "fatGrams": <number>,
  "carbsGrams": <number>,
  "confidence": "low" | "medium" | "high"
}

If the photo does not show food at all, set "foodName" to "На фото не найдена еда",
set all numeric fields to 0, and set "confidence" to "low".

Use "confidence": "low" whenever the dish, portion size, or hidden ingredients (like added oil
or sauce) are hard to judge from the image. Use "high" only for a simple, clearly visible,
commonly known dish with an obvious portion size.
`.trim();

app.post("/api/analyze-food", async (req, res) => {
  try {
    const { image, mimeType } = req.body || {};
    if (!image) return badRequest(res, "Изображение не передано.");
    if (!mimeType || !mimeType.startsWith("image/")) {
      return badRequest(res, "Этот файл не похож на изображение.");
    }

    const result = await callGeminiForJson({
      base64Image: image,
      mimeType,
      promptText: FOOD_PROMPT,
    });

    res.json(result);
  } catch (err) {
    console.error("analyze-food error:", err.message);
    res.status(502).json({ error: err.message || "Не удалось проанализировать блюдо." });
  }
});

// ---------- /api/analyze-body ----------
// Now takes the user's own height/weight along with the photo, so Gemini has
// real biometric context (rather than guessing scale purely from the image).

function buildBodyPrompt(heightCm, weightKg) {
  return `
You are a cautious fitness-education assistant. You will be shown one photo of a person's body.

The person has told you their own height and weight:
- Height: ${heightCm} cm
- Weight: ${weightKg} kg

Use these numbers together with the photo to sanity-check and refine your visual estimate
(e.g. cross-reference against BMI and typical body-fat ranges for that height/weight), but
the photo is still your primary evidence — don't just compute a number from BMI alone, since
BMI doesn't distinguish muscle from fat.

Give TWO rough, approximate percentage RANGES based on visible muscle definition,
visible vascularity, fat distribution, and the height/weight context above:
1. Body-fat percentage
2. Muscle-mass percentage (of total body weight)

This is for casual self-tracking only, never a medical or clinical measurement, and you
should treat it that way: give wide-enough ranges that you are not implying false precision.

Write every human-readable text value ("category", "muscleCategory") in Russian.
Keep the JSON keys and the "confidence" values exactly as shown below (in English).

Respond with ONLY a JSON object in exactly this shape, no extra text, no markdown fences:

{
  "rangeLow": <number, lower bound of estimated body fat percent>,
  "rangeHigh": <number, upper bound of estimated body fat percent>,
  "category": "one short phrase in Russian, e.g. 'Атлетичный диапазон' or 'Средний диапазон' — never a medical term",
  "muscleLow": <number, lower bound of estimated muscle-mass percent>,
  "muscleHigh": <number, upper bound of estimated muscle-mass percent>,
  "muscleCategory": "one short phrase in Russian, e.g. 'Ниже среднего', 'Средний', 'Выше среднего'",
  "confidence": "low" | "medium" | "high"
}

Keep each range at least 4 percentage points wide. If the photo doesn't clearly show a
person's body (too dark, too zoomed in, not a person, face-only, heavy clothing that hides
the body shape), respond with rangeLow: 0, rangeHigh: 0, category: "Не удалось оценить по
этому фото — попробуйте более чёткое фото в полный рост", muscleLow: 0, muscleHigh: 0,
muscleCategory: "", confidence: "low".

Never mention specific diseases, health risks, or give medical advice. Never comment on
attractiveness. Stay purely descriptive and neutral.
`.trim();
}

app.post("/api/analyze-body", async (req, res) => {
  try {
    const { image, mimeType, heightCm, weightKg } = req.body || {};
    if (!image) return badRequest(res, "Изображение не передано.");
    if (!mimeType || !mimeType.startsWith("image/")) {
      return badRequest(res, "Этот файл не похож на изображение.");
    }
    if (!heightCm || !weightKg) {
      return badRequest(res, "Для оценки состава тела нужны рост и вес.");
    }

    const result = await callGeminiForJson({
      base64Image: image,
      mimeType,
      promptText: buildBodyPrompt(heightCm, weightKg),
    });

    res.json(result);
  } catch (err) {
    console.error("analyze-body error:", err.message);
    res.status(502).json({ error: err.message || "Не удалось оценить состав тела." });
  }
});

// ---------- /api/workout-plan ----------
//
// Generates a 7-day workout plan from a body photo + height/weight/goal, and,
// when mode is "chronic", adapts the plan around the person's selected chronic
// conditions — even if that means deviating from their stated goal for safety.

const GOAL_LABELS = {
  lose: "снижение веса / жиросжигание",
  gain: "набор мышечной массы",
  maintain: "поддержание текущей формы",
};

function buildWorkoutPlanPrompt({ heightCm, weightKg, goal, mode, diseases }) {
  const goalLabel = GOAL_LABELS[goal] || GOAL_LABELS.maintain;
  const hasDiseases = mode === "chronic" && Array.isArray(diseases) && diseases.length > 0;

  const conditionsBlock = hasDiseases
    ? `The person has reported the following chronic condition(s): ${diseases.join(", ")}.
Safety around these conditions takes priority over the stated goal. Adapt exercise type,
intensity, volume, and impact level to what's actually safe for each condition. If the
stated goal isn't safely achievable as-is given these conditions, say so plainly in
"goalSummary" and build the closest safe alternative instead of ignoring the conditions.
Call out anything the person should avoid, and anything that needs medical clearance first,
in "cautions".`
    : `The person has not reported any chronic conditions — build a standard plan for a
generally healthy adult toward their stated goal. Leave "cautions" as an empty array.`;

  return `
You are a cautious fitness-planning assistant. You will be shown one photo of a person's
body (full body if possible), along with their height, weight, and goal.

- Height: ${heightCm} cm
- Weight: ${weightKg} kg
- Stated goal: ${goalLabel}

${conditionsBlock}

Use the photo only for general context (build, visible mobility or posture cues) — not to
diagnose anything. Never mention specific diseases as if you can see them in the photo, and
never comment on attractiveness.

Build a practical 7-day (Monday-Sunday) workout plan, including rest or active-recovery days
where appropriate. Every exercise name, note, and text field must be written in Russian.

Respond with ONLY a JSON object in exactly this shape, no extra text, no markdown fences:

{
  "planTitle": "short plan title in Russian",
  "goalSummary": "2-3 sentences in Russian explaining the approach, and explicitly noting any way the plan had to deviate from the stated goal because of a condition",
  "days": [
    {
      "day": "Понедельник",
      "focus": "short focus label, e.g. 'Верх тела' or 'Отдых'",
      "exercises": [
        { "name": "название упражнения", "details": "напр. 3 подхода по 10–12 повторений, умеренный темп" }
      ],
      "notes": "any condition-specific adjustment for this day, or empty string"
    }
    // ... one entry per day, Monday through Sunday
  ],
  "cautions": ["short safety notes in Russian — empty array if no conditions were reported"],
  "medicalDisclaimer": "one sentence in Russian reminding them this isn't medical advice and to get clearance from a doctor before starting, especially with a chronic condition"
}

If the photo doesn't clearly show a person, still build the plan from the height/weight/goal
alone, and note in "goalSummary" that the photo wasn't usable for context.
`.trim();
}

app.post("/api/workout-plan", async (req, res) => {
  try {
    const { image, mimeType, heightCm, weightKg, goal, mode, diseases } = req.body || {};
    if (!image) return badRequest(res, "Изображение не передано.");
    if (!mimeType || !mimeType.startsWith("image/")) {
      return badRequest(res, "Этот файл не похож на изображение.");
    }
    if (!heightCm || !weightKg) {
      return badRequest(res, "Для плана тренировок нужны рост и вес.");
    }
    if (!GOAL_LABELS[goal]) {
      return badRequest(res, "Не указана цель тренировок.");
    }
    if (mode === "chronic" && (!Array.isArray(diseases) || diseases.length === 0)) {
      return badRequest(res, "Выберите хотя бы одно заболевание, либо переключитесь на обычный план.");
    }

    const result = await callGeminiForJson({
      base64Image: image,
      mimeType,
      promptText: buildWorkoutPlanPrompt({
        heightCm,
        weightKg,
        goal,
        mode,
        diseases: mode === "chronic" ? diseases : [],
      }),
    });

    res.json(result);
  } catch (err) {
    console.error("workout-plan error:", err.message);
    res.status(502).json({ error: err.message || "Не удалось составить план тренировок." });
  }
});

// ---------- /api/chat ----------
//
// Free-form chat with photo support — e.g. "here's a restaurant menu, what should I order?"
// or "how many strength sessions vs cardio per week should I do?". Unlike the two routes
// above, this does NOT force JSON output: it's a normal back-and-forth conversation.

const CHAT_SYSTEM_INSTRUCTION = `
You are the "Coach" chat inside HealthyWay, a friendly nutrition and fitness assistant.

Always reply in Russian, unless the user clearly writes in another language.

You can be shown photos — most often a restaurant/cafe menu, or a plate of food — and asked
for a recommendation or opinion. When shown a menu photo, pick one or two specific items you'd
recommend and briefly say why (protein content, lighter option, etc.), rather than just
describing everything on the menu.

You also answer general training questions (e.g. how much cardio vs strength training per
week, how to structure a beginner routine, how to eat more protein). Give practical,
mainstream, evidence-based guidance (e.g. commonly cited public-health guidance is roughly
2-3 strength sessions and 150+ minutes of moderate cardio per week for general health) and
keep answers concise — a few short paragraphs or a short list, not an essay.

Boundaries:
- You are not a doctor, dietitian, or personal trainer, and you don't know this person's
  medical history. Say so briefly when it's relevant (e.g. before suggesting an intense
  training change), rather than in every single message.
- Never diagnose conditions, interpret symptoms, or recommend supplements/medications.
- If someone describes an injury, pain, disordered eating patterns, or a medical condition,
  gently redirect them to a doctor or physical therapist rather than prescribing a workaround.
- If a photo doesn't show food, a menu, or something fitness-related, say so plainly and ask
  what they'd like help with instead.
- Keep a warm, encouraging, non-judgmental tone — never comment on someone's body or shame
  food choices.
`.trim();

/**
 * Calls Gemini for a normal conversational reply (plain text, not JSON).
 * `messages` is an array of { role: "user"|"model", text, image?, mimeType? }.
 */
async function callGeminiForChat(messages) {
  const contents = messages.map((m) => {
    const parts = [];
    if (m.text) parts.push({ text: m.text });
    if (m.image && m.mimeType) {
      parts.push({ inline_data: { mime_type: m.mimeType, data: m.image } });
    }
    return { role: m.role === "model" ? "model" : "user", parts };
  });

  const body = {
    systemInstruction: { parts: [{ text: CHAT_SYSTEM_INSTRUCTION }] },
    contents,
    generationConfig: { temperature: 0.6, maxOutputTokens: 500 },
  };

  let response;
  try {
    response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (networkErr) {
    if (networkErr.name === "TimeoutError") {
      throw new Error("ИИ слишком долго отвечает. Попробуйте ещё раз.");
    }
    throw new Error("Не удалось связаться с сервисом ИИ. Проверьте подключение и попробуйте снова.");
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    console.error("Gemini chat API error:", response.status, errBody);
    if (response.status === 400) {
      throw new Error("Не удалось обработать это сообщение или фото.");
    }
    if (response.status === 429) {
      throw new Error("Слишком много запросов. Подождите немного и попробуйте снова.");
    }
    throw new Error("Проблема на стороне сервиса ИИ. Попробуйте ещё раз чуть позже.");
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p.text || "").join("").trim() : "";

  if (!text) {
    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason === "SAFETY") {
      throw new Error("Это сообщение или фото отклонено фильтрами безопасности ИИ.");
    }
    throw new Error("ИИ не вернул подходящий ответ. Попробуйте ещё раз.");
  }

  return text;
}

const MAX_CHAT_MESSAGES = 24; // caps how much conversation we forward per request

app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return badRequest(res, "Сообщение не передано.");
    }
    if (messages.length > MAX_CHAT_MESSAGES) {
      return badRequest(res, "Диалог стал слишком длинным — начните новый чат.");
    }
    for (const m of messages) {
      if (typeof m.text !== "string" && !m.image) {
        return badRequest(res, "В каждом сообщении должен быть текст или фото.");
      }
      if (m.image && (!m.mimeType || !m.mimeType.startsWith("image/"))) {
        return badRequest(res, "Прикреплённый файл не похож на изображение.");
      }
    }

    const reply = await callGeminiForChat(messages);
    res.json({ reply });
  } catch (err) {
    console.error("chat error:", err.message);
    res.status(502).json({ error: err.message || "Не удалось получить ответ в чате." });
  }
});

// ---------- start server ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HealthyWay server running at http://localhost:${PORT}`);
});