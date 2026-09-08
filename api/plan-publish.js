import { sessionEmail } from "./auth.js";
import { shortId } from "./_ids.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ldfpnnfagcvjhdmfzxhi.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const base = () => `${SUPABASE_URL}/rest/v1`;

function json(res, status, body) {
  res.status(status).setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function headers(extra) {
  return { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", ...extra };
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
  if (!SERVICE_KEY) return json(res, 502, { error: "missing_supabase_env", message: "Lipsesc SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY în proiectul Vercel." });
  if (req.method !== "POST") return json(res, 405, { message: "Metodă nepermisă." });

  const email = sessionEmail(req);
  if (!email) return json(res, 401, { message: "Neautentificat." });

  const body = await readBody(req);
  const title = String(body.title || "Plan de testare").slice(0, 200);
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];
  const workTime = body.workTime || null;
  const planId = body.planId ? String(body.planId) : null;

  try {
    if (planId) {
      const ownRes = await fetch(
        `${base()}/plans?id=eq.${encodeURIComponent(planId)}&owner=eq.${encodeURIComponent(email)}&select=id&limit=1`,
        { headers: headers() },
      );
      const ownRows = ownRes.ok ? await ownRes.json() : [];
      if (!ownRows[0]) return json(res, 404, { message: "Planul nu există." });

      const r = await fetch(`${base()}/plans?id=eq.${encodeURIComponent(planId)}`, {
        method: "PATCH",
        headers: headers({ prefer: "return=minimal" }),
        body: JSON.stringify({ context: title, tasks, work_time: workTime, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) throw new Error("db");
      return json(res, 200, { planId });
    }

    const id = shortId(12);
    const r = await fetch(`${base()}/plans`, {
      method: "POST",
      headers: headers({ prefer: "return=minimal" }),
      body: JSON.stringify({ id, owner: email, context: title, tasks, work_time: workTime, approvals: [] }),
    });
    if (!r.ok) throw new Error("db");
    return json(res, 200, { planId: id });
  } catch {
    return json(res, 502, { message: "Exportul a eșuat — încearcă din nou." });
  }
}
