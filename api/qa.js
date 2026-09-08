import { sessionEmail } from "./auth.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ldfpnnfagcvjhdmfzxhi.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(res, status, body) {
  res.status(status).setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function headers(extra) {
  return {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    "content-type": "application/json",
    ...extra,
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

function clean(text, max) {
  return String(text || "").trim().slice(0, max);
}

export default async function handler(req, res) {
  if (!SERVICE_KEY) {
    return json(res, 500, {
      message: "Lipsește SUPABASE_SERVICE_ROLE_KEY din setările proiectului Vercel.",
    });
  }

  const email = sessionEmail(req);
  if (!email) return json(res, 401, { message: "Neautentificat." });

  const action = new URL(req.url, "http://x").searchParams.get("action");
  const base = `${SUPABASE_URL}/rest/v1`;

  try {
    if (action === "list" && req.method === "GET") {
      const projectsRes = await fetch(
        `${base}/qa_projects?owner=eq.${encodeURIComponent(email)}&select=id,name,url,slug,status,created_at,updated_at&order=updated_at.desc`,
        { headers: headers() },
      );
      if (!projectsRes.ok) throw new Error("read");
      const projects = await projectsRes.json();
      if (!projects.length) return json(res, 200, { projects: [] });

      const ids = projects.map((p) => p.id);
      const countsRes = await fetch(
        `${base}/qa_findings?project_id=in.(${ids.join(",")})&select=project_id,status`,
        { headers: headers() },
      );
      const findings = countsRes.ok ? await countsRes.json() : [];
      const counts = {};
      for (const f of findings) {
        counts[f.project_id] ||= { bug: 0, fixed: 0, ok: 0 };
        counts[f.project_id][f.status] = (counts[f.project_id][f.status] || 0) + 1;
      }
      return json(res, 200, {
        projects: projects.map((p) => ({ ...p, counts: counts[p.id] || { bug: 0, fixed: 0, ok: 0 } })),
      });
    }

    if (action === "project" && req.method === "GET") {
      const id = new URL(req.url, "http://x").searchParams.get("id");
      if (!id) return json(res, 400, { message: "Lipsește id-ul proiectului." });
      const [projectRes, findingsRes] = await Promise.all([
        fetch(`${base}/qa_projects?id=eq.${encodeURIComponent(id)}&owner=eq.${encodeURIComponent(email)}&select=*&limit=1`, {
          headers: headers(),
        }),
        fetch(`${base}/qa_findings?project_id=eq.${encodeURIComponent(id)}&select=*&order=created_at.asc`, {
          headers: headers(),
        }),
      ]);
      if (!projectRes.ok || !findingsRes.ok) throw new Error("read");
      const projectRows = await projectRes.json();
      if (!projectRows[0]) return json(res, 404, { message: "Proiectul nu există." });
      const findings = await findingsRes.json();
      return json(res, 200, { project: projectRows[0], findings });
    }

    if (action === "create-project" && req.method === "POST") {
      const body = await readBody(req);
      const name = clean(body.name, 140);
      if (!name) return json(res, 400, { message: "Numele proiectului e obligatoriu." });
      const url = clean(body.url, 300) || null;
      const r = await fetch(`${base}/qa_projects`, {
        method: "POST",
        headers: headers({ prefer: "return=representation" }),
        body: JSON.stringify({ owner: email, name, url }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const rows = await r.json();
      return json(res, 200, { project: rows[0] });
    }

    if (action === "close-project" && req.method === "POST") {
      const body = await readBody(req);
      const id = clean(body.id, 80);
      if (!id) return json(res, 400, { message: "Lipsește id-ul proiectului." });
      const status = body.status === "open" ? "open" : "closed";
      const r = await fetch(
        `${base}/qa_projects?id=eq.${encodeURIComponent(id)}&owner=eq.${encodeURIComponent(email)}`,
        { method: "PATCH", headers: headers({ prefer: "return=minimal" }), body: JSON.stringify({ status, updated_at: new Date().toISOString() }) },
      );
      if (!r.ok) throw new Error(String(r.status));
      return json(res, 200, { ok: true });
    }

    if (action === "delete-project" && req.method === "POST") {
      const body = await readBody(req);
      const id = clean(body.id, 80);
      if (!id) return json(res, 400, { message: "Lipsește id-ul proiectului." });
      const r = await fetch(
        `${base}/qa_projects?id=eq.${encodeURIComponent(id)}&owner=eq.${encodeURIComponent(email)}`,
        { method: "DELETE", headers: headers({ prefer: "return=minimal" }) },
      );
      if (!r.ok) throw new Error(String(r.status));
      return json(res, 200, { ok: true });
    }

    if (action === "add-finding" && req.method === "POST") {
      const body = await readBody(req);
      const projectId = clean(body.project_id, 80);
      const text = clean(body.text, 4000);
      if (!projectId || !text) return json(res, 400, { message: "Lipsesc date obligatorii." });
      const status = ["bug", "fixed", "ok"].includes(body.status) ? body.status : "bug";

      const ownRes = await fetch(
        `${base}/qa_projects?id=eq.${encodeURIComponent(projectId)}&owner=eq.${encodeURIComponent(email)}&select=id&limit=1`,
        { headers: headers() },
      );
      const ownRows = ownRes.ok ? await ownRes.json() : [];
      if (!ownRows[0]) return json(res, 404, { message: "Proiectul nu există." });

      const r = await fetch(`${base}/qa_findings`, {
        method: "POST",
        headers: headers({ prefer: "return=representation" }),
        body: JSON.stringify({ project_id: projectId, text, status }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const rows = await r.json();
      await fetch(`${base}/qa_projects?id=eq.${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: headers({ prefer: "return=minimal" }),
        body: JSON.stringify({ updated_at: new Date().toISOString() }),
      });
      return json(res, 200, { finding: rows[0] });
    }

    if (action === "update-finding" && req.method === "POST") {
      const body = await readBody(req);
      const id = clean(body.id, 80);
      if (!id) return json(res, 400, { message: "Lipsește id-ul." });
      const patch = { updated_at: new Date().toISOString() };
      if (typeof body.text === "string") patch.text = clean(body.text, 4000);
      if (["bug", "fixed", "ok"].includes(body.status)) patch.status = body.status;

      const findingRes = await fetch(
        `${base}/qa_findings?id=eq.${encodeURIComponent(id)}&select=project_id,qa_projects!inner(owner)&limit=1`,
        { headers: headers() },
      );
      const findingRows = findingRes.ok ? await findingRes.json() : [];
      if (!findingRows[0] || findingRows[0].qa_projects?.owner !== email) {
        return json(res, 404, { message: "Nu există." });
      }

      const r = await fetch(`${base}/qa_findings?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: headers({ prefer: "return=minimal" }),
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(String(r.status));
      return json(res, 200, { ok: true });
    }

    if (action === "delete-finding" && req.method === "POST") {
      const body = await readBody(req);
      const id = clean(body.id, 80);
      if (!id) return json(res, 400, { message: "Lipsește id-ul." });

      const findingRes = await fetch(
        `${base}/qa_findings?id=eq.${encodeURIComponent(id)}&select=project_id,qa_projects!inner(owner)&limit=1`,
        { headers: headers() },
      );
      const findingRows = findingRes.ok ? await findingRes.json() : [];
      if (!findingRows[0] || findingRows[0].qa_projects?.owner !== email) {
        return json(res, 404, { message: "Nu există." });
      }

      const r = await fetch(`${base}/qa_findings?id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: headers({ prefer: "return=minimal" }),
      });
      if (!r.ok) throw new Error(String(r.status));
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { message: "Acțiune necunoscută." });
  } catch {
    return json(res, 502, { message: "Nu am putut contacta baza de date." });
  }
}
