// HealthyWay backend
// Talks to Gemini on the frontend's behalf so the API key never reaches the browser.

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
      throw new Error("The AI took too long to respond. Please try again.");
    }
    throw new Error("Could not reach the AI service. Check your connection and try again.");
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    console.error("Gemini API error:", response.status, errBody);
    if (response.status === 400) {
      throw new Error("That image couldn't be processed. Try a clearer photo.");
    }
    if (response.status === 429) {
      throw new Error("Too many requests right now. Please wait a moment and try again.");
    }
    throw new Error("The AI service had a problem. Please try again shortly.");
  }

  const data = await response.json();

  const textPart = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textPart) {
    // This happens sometimes if Gemini's safety filters block the image/response.
    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason === "SAFETY") {
      throw new Error("This image was flagged by the AI's safety filters. Try a different photo.");
    }
    throw new Error("The AI didn't return a usable answer. Please try again.");
  }

  try {
    return JSON.parse(textPart);
  } catch {
    console.error("Failed to parse Gemini JSON output:", textPart);
    throw new Error("The AI's answer wasn't in the expected format. Please try again.");
  }
}

// ---------- /api/analyze-food ----------

const FOOD_PROMPT = `
You are a nutrition estimation assistant. You will be shown one photo of a meal.

Identify the food and estimate its nutrition. Since you cannot weigh the food or see
ingredients hidden inside the dish (oil, butter, sauce, sugar), give your best-effort
approximate estimate rather than refusing.

Respond with ONLY a JSON object in exactly this shape, no extra text, no markdown fences:

{
  "foodName": "short name of the dish, e.g. 'Grilled chicken with avocado and greens'",
  "portionDescription": "one short sentence estimating portion size, e.g. 'Approx. 350g plate, medium portion'",
  "calories": <number, kcal for the whole visible portion>,
  "proteinGrams": <number>,
  "fatGrams": <number>,
  "carbsGrams": <number>,
  "confidence": "low" | "medium" | "high"
}

If the photo does not show food at all, set "foodName" to "No food detected in this photo",
set all numeric fields to 0, and set "confidence" to "low".

Use "confidence": "low" whenever the dish, portion size, or hidden ingredients (like added oil
or sauce) are hard to judge from the image. Use "high" only for a simple, clearly visible,
commonly known dish with an obvious portion size.
`.trim();

app.post("/api/analyze-food", async (req, res) => {
  try {
    const { image, mimeType } = req.body || {};
    if (!image) return badRequest(res, "No image was provided.");
    if (!mimeType || !mimeType.startsWith("image/")) {
      return badRequest(res, "That file doesn't look like an image.");
    }

    const result = await callGeminiForJson({
      base64Image: image,
      mimeType,
      promptText: FOOD_PROMPT,
    });

    res.json(result);
  } catch (err) {
    console.error("analyze-food error:", err.message);
    res.status(502).json({ error: err.message || "Food analysis failed." });
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

Respond with ONLY a JSON object in exactly this shape, no extra text, no markdown fences:

{
  "rangeLow": <number, lower bound of estimated body fat percent>,
  "rangeHigh": <number, upper bound of estimated body fat percent>,
  "category": "one short phrase, e.g. 'Athletic range' or 'Average range' — never a medical term",
  "muscleLow": <number, lower bound of estimated muscle-mass percent>,
  "muscleHigh": <number, upper bound of estimated muscle-mass percent>,
  "muscleCategory": "one short phrase, e.g. 'Below average', 'Average', 'Above average'",
  "confidence": "low" | "medium" | "high"
}

Keep each range at least 4 percentage points wide. If the photo doesn't clearly show a
person's body (too dark, too zoomed in, not a person, face-only, heavy clothing that hides
the body shape), respond with rangeLow: 0, rangeHigh: 0, category: "Could not estimate from
this photo — try a clearer full-body photo", muscleLow: 0, muscleHigh: 0, muscleCategory: "",
confidence: "low".

Never mention specific diseases, health risks, or give medical advice. Never comment on
attractiveness. Stay purely descriptive and neutral.
`.trim();
}

app.post("/api/analyze-body", async (req, res) => {
  try {
    const { image, mimeType, heightCm, weightKg } = req.body || {};
    if (!image) return badRequest(res, "No image was provided.");
    if (!mimeType || !mimeType.startsWith("image/")) {
      return badRequest(res, "That file doesn't look like an image.");
    }
    if (!heightCm || !weightKg) {
      return badRequest(res, "Height and weight are required for a body estimate.");
    }

    const result = await callGeminiForJson({
      base64Image: image,
      mimeType,
      promptText: buildBodyPrompt(heightCm, weightKg),
    });

    res.json(result);
  } catch (err) {
    console.error("analyze-body error:", err.message);
    res.status(502).json({ error: err.message || "Body estimate failed." });
  }
});

// ---------- /api/chat ----------
//
// Free-form chat with photo support — e.g. "here's a restaurant menu, what should I order?"
// or "how many strength sessions vs cardio per week should I do?". Unlike the two routes
// above, this does NOT force JSON output: it's a normal back-and-forth conversation.

const CHAT_SYSTEM_INSTRUCTION = `
You are the "Coach" chat inside HealthyWay, a friendly nutrition and fitness assistant.

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
      throw new Error("The AI took too long to respond. Please try again.");
    }
    throw new Error("Could not reach the AI service. Check your connection and try again.");
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    console.error("Gemini chat API error:", response.status, errBody);
    if (response.status === 400) {
      throw new Error("That message or photo couldn't be processed.");
    }
    if (response.status === 429) {
      throw new Error("Too many requests right now. Please wait a moment and try again.");
    }
    throw new Error("The AI service had a problem. Please try again shortly.");
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p.text || "").join("").trim() : "";

  if (!text) {
    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason === "SAFETY") {
      throw new Error("That message or photo was flagged by the AI's safety filters.");
    }
    throw new Error("The AI didn't return a usable answer. Please try again.");
  }

  return text;
}

const MAX_CHAT_MESSAGES = 24; // caps how much conversation we forward per request

app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return badRequest(res, "No message was provided.");
    }
    if (messages.length > MAX_CHAT_MESSAGES) {
      return badRequest(res, "This conversation has gotten too long — please start a new chat.");
    }
    for (const m of messages) {
      if (typeof m.text !== "string" && !m.image) {
        return badRequest(res, "Each message needs text or a photo.");
      }
      if (m.image && (!m.mimeType || !m.mimeType.startsWith("image/"))) {
        return badRequest(res, "That attached file doesn't look like an image.");
      }
    }

    const reply = await callGeminiForChat(messages);
    res.json({ reply });
  } catch (err) {
    console.error("chat error:", err.message);
    res.status(502).json({ error: err.message || "Chat failed." });
  }
});

// ---------- start server ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HealthyWay server running at http://localhost:${PORT}`);
});