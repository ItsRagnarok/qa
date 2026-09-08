import { sessionEmail } from "./auth.js";

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.0-flash";

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

function buildPrompt(body) {
  const { collaboration, startDate, endDate, stats, tasks } = body;
  const taskLines = (tasks || [])
    .map((t) => {
      const cps = (t.checkpoints || []).map((c) => `  - [${c.done ? "x" : " "}] ${c.text}`).join("\n");
      return `${t.date} · ${t.context || "—"} · ${t.title}\n${cps}`;
    })
    .join("\n\n");

  return [
    `Ești un asistent care scrie un rezumat de activitate pentru colaborarea „${collaboration}”, pentru perioada ${startDate} → ${endDate}.`,
    "",
    "Statistici din perioadă:",
    JSON.stringify(stats),
    "",
    "Task-urile și checkpoint-urile din perioadă:",
    taskLines || "(niciunul)",
    "",
    "Scrie un rezumat scurt, profesionist, în română, gata de trimis către angajator/client.",
    "Răspunde DOAR cu acest format, fără alt text:",
    "[REZUMAT]",
    "2-4 propoziții despre ce s-a lucrat.",
    "[RITM]",
    "1-2 propoziții despre ritmul de lucru și constanță.",
    "[VERDICT]",
    "O concluzie scurtă (1 propoziție).",
  ].join("\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { message: "Metodă nepermisă." });
  const email = sessionEmail(req);
  if (!email) return json(res, 401, { message: "Neautentificat." });

  if (!GEMINI_KEY) {
    return json(res, 400, {
      error: "missing_api_key",
      message: "Rezumatul AI necesită o cheie GEMINI_API_KEY (gratuită, de pe aistudio.google.com/apikey) setată în proiectul Vercel.",
    });
  }

  const body = await readBody(req);
  if (!body.collaboration || !body.startDate || !body.endDate) {
    return json(res, 400, { message: "Lipsesc date pentru rezumat." });
  }

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: buildPrompt(body) }] }] }),
      },
    );
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      const msg = errBody && errBody.error && errBody.error.message;
      return json(res, 502, { message: msg || "A apărut o eroare la generarea rezumatului." });
    }
    const data = await r.json();
    const text =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;
    if (!text) return json(res, 502, { message: "AI-ul nu a răspuns cu text util." });
    return json(res, 200, { text });
  } catch {
    return json(res, 502, { message: "Nu am putut contacta serviciul AI." });
  }
}
