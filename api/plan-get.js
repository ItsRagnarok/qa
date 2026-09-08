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
  if (!SERVICE_KEY) return json(res, 502, { error: "missing_supabase_env", message: "Lipsesc SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY." });
  if (req.method !== "GET") return json(res, 405, { message: "Metodă nepermisă." });

  const id = (new URL(req.url, "http://x").searchParams.get("id") || "").trim();
  if (!id) return json(res, 400, { message: "Link invalid." });

  try {
    const r = await fetch(`${base()}/plans?id=eq.${encodeURIComponent(id)}&select=context,tasks,approvals,work_time&limit=1`, {
      headers: headers(),
    });
    if (!r.ok) throw new Error("db");
    const rows = await r.json();
    const row = rows[0];
    if (!row) return json(res, 404, { message: "Planul nu (mai) există." });
    return json(res, 200, {
      context: row.context,
      tasks: row.tasks || [],
      approvals: row.approvals || [],
      work_time: row.work_time || null,
    });
  } catch {
    return json(res, 502, { message: "Nu am putut încărca planul." });
  }
}
