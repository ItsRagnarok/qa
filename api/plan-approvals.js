import { sessionEmail } from "./auth.js";

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
  if (!SERVICE_KEY) return json(res, 500, { message: "Lipsește configurarea serverului." });

  const email = await sessionEmail(req);
  if (!email) return json(res, 401, { message: "Neautentificat." });

  try {
    if (req.method === "GET") {
      const r = await fetch(
        `${base()}/plans?owner=eq.${encodeURIComponent(email)}&select=id,context,approvals`,
        { headers: headers() },
      );
      if (!r.ok) throw new Error("db");
      const rows = await r.json();
      const approvals = [];
      for (const row of rows) {
        for (const a of row.approvals || []) {
          approvals.push({ ...a, planId: row.id, planTitle: row.context });
        }
      }
      approvals.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return json(res, 200, { approvals });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      const byPlan = {};
      for (const it of items) {
        if (!it || !it.planId || !it.approvalId) continue;
        (byPlan[it.planId] ||= new Set()).add(it.approvalId);
      }
      for (const planId of Object.keys(byPlan)) {
        const r = await fetch(
          `${base()}/plans?id=eq.${encodeURIComponent(planId)}&owner=eq.${encodeURIComponent(email)}&select=approvals&limit=1`,
          { headers: headers() },
        );
        const rows = r.ok ? await r.json() : [];
        const row = rows[0];
        if (!row) continue;
        const ids = byPlan[planId];
        const nextApprovals = (row.approvals || []).map((a) => (ids.has(a.id) ? { ...a, seen: true } : a));
        await fetch(`${base()}/plans?id=eq.${encodeURIComponent(planId)}`, {
          method: "PATCH",
          headers: headers({ prefer: "return=minimal" }),
          body: JSON.stringify({ approvals: nextApprovals }),
        });
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { message: "Metodă nepermisă." });
  } catch {
    return json(res, 502, { message: "Nu am putut contacta baza de date." });
  }
}
