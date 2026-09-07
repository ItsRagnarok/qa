import { sessionEmail } from "./auth.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ldfpnnfagcvjhdmfzxhi.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const EMPTY = { projects: [], done: {}, log: [], start_date: null };

function json(res, status, body) {
  res.status(status).setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function headers() {
  return {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    "content-type": "application/json",
  };
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

/** Guards against one runaway client filling the row: the whole state is one JSON blob. */
function tooBig(value) {
  return JSON.stringify(value).length > 400_000;
}

export default async function handler(req, res) {
  if (!SERVICE_KEY) {
    return json(res, 500, {
      message: "Lipsește SUPABASE_SERVICE_ROLE_KEY din setările proiectului Vercel.",
    });
  }

  const email = sessionEmail(req);
  if (!email) return json(res, 401, { message: "Neautentificat." });

  const row = `${SUPABASE_URL}/rest/v1/project_tasks`;
  const mine = `${row}?owner=eq.${encodeURIComponent(email)}`;

  if (req.method === "GET") {
    try {
      // The 90-day plan is shared reference data; the user's ticks live per row.
      const [mineRes, planRes] = await Promise.all([
        fetch(`${mine}&select=projects,done,log,start_date&limit=1`, { headers: headers() }),
        fetch(`${SUPABASE_URL}/rest/v1/plan_template?id=eq.alpora90&select=stages,days&limit=1`, {
          headers: headers(),
        }),
      ]);
      if (!mineRes.ok || !planRes.ok) throw new Error("read");
      const [mineRows, planRows] = await Promise.all([mineRes.json(), planRes.json()]);
      const plan = planRows[0] || { stages: [], days: {} };
      return json(res, 200, {
        ...(mineRows[0] || EMPTY),
        stages: plan.stages,
        days: plan.days,
      });
    } catch {
      return json(res, 502, { message: "Nu am putut citi datele." });
    }
  }

  if (req.method === "POST") {
    const body = await readBody(req);
    const next = {
      owner: email,
      projects: Array.isArray(body.projects) ? body.projects : [],
      done: body.done && typeof body.done === "object" ? body.done : {},
      log: Array.isArray(body.log) ? body.log : [],
      start_date: body.start_date || null,
      updated_at: new Date().toISOString(),
    };
    if (tooBig(next)) return json(res, 413, { message: "Prea multe date de salvat." });

    try {
      // Upsert on the primary key, so the first save creates the row.
      const r = await fetch(row, {
        method: "POST",
        headers: { ...headers(), prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(next),
      });
      if (!r.ok) throw new Error(String(r.status));
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 502, { message: "Nu am putut salva." });
    }
  }

  return json(res, 405, { message: "Metodă nepermisă." });
}
