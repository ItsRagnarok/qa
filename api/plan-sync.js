import { sessionEmail } from "./auth.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ldfpnnfagcvjhdmfzxhi.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const base = () => `${SUPABASE_URL}/rest/v1`;

function json(res, status, body) {
  res.status(status).setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function headers() {
  return { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` };
}

export default async function handler(req, res) {
  if (!SERVICE_KEY) return json(res, 500, { message: "Lipsește configurarea serverului." });
  if (req.method !== "GET") return json(res, 405, { message: "Metodă nepermisă." });

  const email = await sessionEmail(req);
  if (!email) return json(res, 401, { message: "Neautentificat." });

  try {
    const r = await fetch(
      `${base()}/plans?owner=eq.${encodeURIComponent(email)}&select=id,context,tasks`,
      { headers: headers() },
    );
    if (!r.ok) throw new Error("db");
    const rows = await r.json();
    const plans = rows.map((row) => {
      const cps = {};
      for (const t of row.tasks || []) {
        for (const c of t.checkpoints || []) cps[c.id] = !!c.done;
      }
      return { planId: row.id, title: row.context, cps };
    });
    return json(res, 200, { plans });
  } catch {
    return json(res, 502, { message: "Nu am putut sincroniza." });
  }
}
