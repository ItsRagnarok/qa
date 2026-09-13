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

const EMPTY = { vehicles: [], alertEmails: [], limita: 15 };

function toClient(row) {
  if (!row) return { ...EMPTY };
  return {
    vehicles: Array.isArray(row.vehicles) ? row.vehicles : [],
    alertEmails: Array.isArray(row.alert_emails) ? row.alert_emails : [],
    limita: Number.isInteger(row.limita) ? row.limita : 15,
  };
}

export default async function handler(req, res) {
  if (!SERVICE_KEY) return json(res, 500, { message: "Lipsește SUPABASE_SERVICE_ROLE_KEY din setările proiectului Vercel." });

  const email = await sessionEmail(req);
  if (!email) return json(res, 401, { message: "Neautentificat." });

  try {
    if (req.method === "GET") {
      const r = await fetch(`${base()}/masini_state?owner=eq.${encodeURIComponent(email)}&select=*&limit=1`, { headers: headers() });
      if (!r.ok) throw new Error("db");
      const rows = await r.json();
      return json(res, 200, toClient(rows[0]));
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const next = {
        owner: email,
        vehicles: Array.isArray(body.vehicles) ? body.vehicles : [],
        alert_emails: Array.isArray(body.alertEmails) ? body.alertEmails : [],
        limita: Number.isInteger(body.limita) && body.limita > 0 ? body.limita : 15,
        updated_at: new Date().toISOString(),
      };
      if (JSON.stringify(next).length > 400_000) return json(res, 413, { message: "Prea multe date de salvat." });

      const r = await fetch(`${base()}/masini_state`, {
        method: "POST",
        headers: headers({ prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify(next),
      });
      if (!r.ok) throw new Error("db");
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { message: "Metodă nepermisă." });
  } catch {
    return json(res, 502, { message: "Nu am putut contacta baza de date." });
  }
}
