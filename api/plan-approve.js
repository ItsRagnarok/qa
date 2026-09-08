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
  if (!SERVICE_KEY) return json(res, 502, { error: "missing_supabase_env", message: "Lipsesc SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY." });
  if (req.method !== "POST") return json(res, 405, { message: "Metodă nepermisă." });

  const body = await readBody(req);
  const id = String(body.id || "");
  if (!id) return json(res, 400, { message: "Link invalid." });

  try {
    const r = await fetch(`${base()}/plans?id=eq.${encodeURIComponent(id)}&select=tasks,approvals&limit=1`, { headers: headers() });
    if (!r.ok) throw new Error("db");
    const rows = await r.json();
    const row = rows[0];
    if (!row) return json(res, 404, { message: "Planul nu (mai) există." });

    const checkpointIds = [];
    let doneCount = 0;
    for (const t of row.tasks || []) {
      for (const c of t.checkpoints || []) {
        checkpointIds.push(c.id);
        if (c.done) doneCount++;
      }
    }
    const approval = {
      id: shortId(12),
      seen: false,
      createdAt: new Date().toISOString(),
      doneCount,
      totalCount: checkpointIds.length,
      checkpointIds,
    };
    const nextApprovals = [...(row.approvals || []), approval];
    const pr = await fetch(`${base()}/plans?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: headers({ prefer: "return=minimal" }),
      body: JSON.stringify({ approvals: nextApprovals }),
    });
    if (!pr.ok) throw new Error("db");
    return json(res, 200, { approval });
  } catch {
    return json(res, 502, { message: "Nu am putut trimite aprobarea." });
  }
}
