import { sessionEmail } from "./auth.js";

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3.6-flash";

function json(res, status, body) {
  res.status(status).setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { message: "Metodă nepermisă." });
  const email = await sessionEmail(req);
  if (!email) return json(res, 401, { message: "Neautentificat." });

  if (!GEMINI_KEY) {
    return json(res, 400, {
      error: "missing_api_key",
      message: "Organizarea AI necesită o cheie GEMINI_API_KEY (gratuită, de pe aistudio.google.com/apikey) setată în proiectul Vercel.",
    });
  }

  const body = await readBody(req);
  const prompt = String(body.prompt || "");
  if (!prompt) return json(res, 400, { message: "Lipsește textul de organizat." });

  try {
    const { text, message } = await callGemini(prompt);
    if (!text) return json(res, 502, { message: message || "AI-ul nu a răspuns cu text util." });
    return json(res, 200, { text });
  } catch {
    return json(res, 502, { message: "Nu am putut contacta serviciul AI." });
  }
}

async function callGemini(prompt, attempt = 0) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    },
  );
  if (!r.ok) {
    const errBody = await r.json().catch(() => ({}));
    const msg = errBody && errBody.error && errBody.error.message;
    if (attempt < 1 && (r.status === 429 || r.status === 503)) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return callGemini(prompt, attempt + 1);
    }
    return { text: null, message: msg || "A apărut o eroare la organizarea cu AI." };
  }
  const data = await r.json();
  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.filter((p) => p && p.text && !p.thought).map((p) => p.text).join("\n").trim();
  return { text, message: null };
}
