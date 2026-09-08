const SUPABASE_URL = process.env.SUPABASE_URL || "https://ldfpnnfagcvjhdmfzxhi.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(res, status, body) {
  res.status(status).setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function headers() {
  return { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` };
}

export default async function handler(req, res) {
  if (!SERVICE_KEY) {
    return json(res, 500, { message: "Lipsește configurarea serverului." });
  }
  if (req.method !== "GET") return json(res, 405, { message: "Metodă nepermisă." });

  const slug = (new URL(req.url, "http://x").searchParams.get("slug") || "").trim();
  if (!slug || slug.length > 64) return json(res, 400, { message: "Link invalid." });

  const base = `${SUPABASE_URL}/rest/v1`;
  try {
    const projectRes = await fetch(
      `${base}/qa_projects?slug=eq.${encodeURIComponent(slug)}&select=id,name,url,status,updated_at&limit=1`,
      { headers: headers() },
    );
    if (!projectRes.ok) throw new Error("read");
    const rows = await projectRes.json();
    const project = rows[0];
    if (!project) return json(res, 404, { message: "Acest link nu (mai) există." });

    const findingsRes = await fetch(
      `${base}/qa_findings?project_id=eq.${encodeURIComponent(project.id)}&select=text,status,created_at&order=created_at.asc`,
      { headers: headers() },
    );
    const findings = findingsRes.ok ? await findingsRes.json() : [];

    return json(res, 200, {
      name: project.name,
      url: project.url,
      status: project.status,
      updated_at: project.updated_at,
      findings,
    });
  } catch {
    return json(res, 502, { message: "Nu am putut încărca raportul." });
  }
}
