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

const EMPTY = {
  contexts: [], activeContext: "", tasks: [], rawNotes: [], collaborations: [],
  contextCollaboration: {}, personalNotes: [], workSessions: [],
};

function countCheckpoints(tasks) {
  return (tasks || []).reduce((n, t) => n + (Array.isArray(t.checkpoints) ? t.checkpoints.length : 0), 0);
}

async function fetchRow(id) {
  const r = await fetch(`${base()}/board_state?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, { headers: headers() });
  if (!r.ok) throw new Error("db");
  const rows = await r.json();
  return rows[0] || null;
}

function toClient(row) {
  if (!row) return { ...EMPTY };
  return {
    contexts: row.contexts || [],
    activeContext: row.active_context || "",
    tasks: row.tasks || [],
    rawNotes: row.raw_notes || [],
    collaborations: row.collaborations || [],
    contextCollaboration: row.context_collaboration || {},
    personalNotes: row.personal_notes || [],
    workSessions: row.work_sessions || [],
  };
}

export default async function handler(req, res) {
  if (!SERVICE_KEY) return json(res, 500, { message: "Lipsește SUPABASE_SERVICE_ROLE_KEY din setările proiectului Vercel." });

  const email = await sessionEmail(req);
  if (!email) return json(res, 401, { message: "Neautentificat." });

  try {
    if (req.method === "POST") {
      const body = await readBody(req);

      if (body.op === "backups") {
        const prefix = `backup~${email}~`;
        const r = await fetch(
          `${base()}/board_state?id=like.${encodeURIComponent(prefix + "*")}&select=id,updated_at,contexts,tasks&order=id.desc&limit=30`,
          { headers: headers() },
        );
        if (!r.ok) throw new Error("db");
        const rows = await r.json();
        return json(res, 200, {
          backups: rows.map((row) => ({
            id: row.id,
            savedAt: row.updated_at,
            contexts: (row.contexts || []).length,
            tasks: (row.tasks || []).length,
            checkpoints: countCheckpoints(row.tasks),
          })),
        });
      }

      if (body.op === "restore") {
        const id = String(body.id || "");
        if (!id.startsWith(`backup~${email}~`)) return json(res, 404, { message: "Copia de siguranță nu există." });
        const backup = await fetchRow(id);
        if (!backup) return json(res, 404, { message: "Copia de siguranță nu există." });

        const current = await fetchRow(email);
        if (current) {
          const snapId = `backup~${email}~${Date.now()}`;
          await fetch(`${base()}/board_state`, {
            method: "POST",
            headers: headers({ prefer: "resolution=merge-duplicates,return=minimal" }),
            body: JSON.stringify({ ...current, id: snapId }),
          });
        }

        const restored = { ...backup, id: email, updated_at: new Date().toISOString() };
        const r = await fetch(`${base()}/board_state`, {
          method: "POST",
          headers: headers({ prefer: "resolution=merge-duplicates,return=minimal" }),
          body: JSON.stringify(restored),
        });
        if (!r.ok) throw new Error("db");
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { message: "Acțiune necunoscută." });
    }

    const row = await fetchRow(email);
    return json(res, 200, { ...toClient(row), email, updatedAt: row ? row.updated_at : null });
  } catch {
    return json(res, 502, { message: "Nu am putut contacta baza de date." });
  }
}
