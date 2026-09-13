import { sessionEmail } from "./auth.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ldfpnnfagcvjhdmfzxhi.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const base = () => `${SUPABASE_URL}/rest/v1`;
const BACKUP_RETENTION = 20;

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

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function size(tasks, rawNotes, personalNotes) {
  const cps = arr(tasks).reduce((n, t) => n + arr(t.checkpoints).length, 0);
  return cps + arr(tasks).length + arr(rawNotes).length + arr(personalNotes).length;
}

async function fetchRow(id) {
  const r = await fetch(`${base()}/board_state?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, { headers: headers() });
  if (!r.ok) throw new Error("db");
  const rows = await r.json();
  return rows[0] || null;
}

async function pruneBackups(email) {
  const prefix = `backup~${email}~`;
  const r = await fetch(
    `${base()}/board_state?id=like.${encodeURIComponent(prefix + "*")}&select=id&order=id.desc&offset=${BACKUP_RETENTION}&limit=100`,
    { headers: headers() },
  );
  if (!r.ok) return;
  const rows = await r.json();
  for (const row of rows) {
    await fetch(`${base()}/board_state?id=eq.${encodeURIComponent(row.id)}`, {
      method: "DELETE",
      headers: headers({ prefer: "return=minimal" }),
    });
  }
}

export default async function handler(req, res) {
  if (!SERVICE_KEY) return json(res, 500, { message: "Lipsește SUPABASE_SERVICE_ROLE_KEY din setările proiectului Vercel." });
  if (req.method !== "POST") return json(res, 405, { message: "Metodă nepermisă." });

  const email = await sessionEmail(req);
  if (!email) return json(res, 401, { message: "Neautentificat." });

  const body = await readBody(req);
  const next = {
    id: email,
    contexts: arr(body.contexts),
    active_context: typeof body.activeContext === "string" ? body.activeContext : "",
    tasks: arr(body.tasks),
    raw_notes: arr(body.rawNotes),
    collaborations: arr(body.collaborations),
    context_collaboration: body.contextCollaboration && typeof body.contextCollaboration === "object" ? body.contextCollaboration : {},
    personal_notes: arr(body.personalNotes),
    work_sessions: arr(body.workSessions),
    updated_at: new Date().toISOString(),
  };

  try {
    const current = await fetchRow(email);

    if (current) {
      const currentSize = size(current.tasks, current.raw_notes, current.personal_notes);
      const nextSize = size(next.tasks, next.raw_notes, next.personal_notes);
      const stale = body.baseUpdatedAt && body.baseUpdatedAt !== current.updated_at;
      if (stale && nextSize < currentSize && !body.confirmShrink) {
        return json(res, 409, { message: "Datele s-au schimbat între timp." });
      }

      const backupId = `backup~${email}~${Date.now()}`;
      await fetch(`${base()}/board_state`, {
        method: "POST",
        headers: headers({ prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify({ ...current, id: backupId }),
      });
      pruneBackups(email).catch(() => {});
    }

    const r = await fetch(`${base()}/board_state`, {
      method: "POST",
      headers: headers({ prefer: "resolution=merge-duplicates,return=representation" }),
      body: JSON.stringify(next),
    });
    if (!r.ok) throw new Error("db");
    const rows = await r.json();
    return json(res, 200, { ok: true, updatedAt: rows[0] ? rows[0].updated_at : next.updated_at });
  } catch {
    return json(res, 502, { message: "Nu am putut salva." });
  }
}
