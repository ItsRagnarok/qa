import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { sessionEmail } from "./auth.js";
import { encryptSecret, decryptSecret } from "./_crypto.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ldfpnnfagcvjhdmfzxhi.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PAGE_SIZE = 25;

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

function clean(v, max) {
  return String(v || "").trim().slice(0, max);
}

const base = () => `${SUPABASE_URL}/rest/v1`;

async function listAccountRows(owner) {
  const r = await fetch(`${base()}/mail_accounts?owner=eq.${encodeURIComponent(owner)}&select=*&order=created_at.asc`, {
    headers: headers(),
  });
  if (!r.ok) throw new Error("db");
  return r.json();
}

async function getAccountRow(owner, id) {
  const r = await fetch(
    `${base()}/mail_accounts?owner=eq.${encodeURIComponent(owner)}&id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    { headers: headers() },
  );
  if (!r.ok) throw new Error("db");
  const rows = await r.json();
  return rows[0] || null;
}

async function getActiveRow(owner) {
  const rows = await listAccountRows(owner);
  if (!rows.length) return null;
  return rows.find((r) => r.active) || rows[0];
}

function toPublic(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name || "",
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    username: row.username,
  };
}

function imapClient(row) {
  return new ImapFlow({
    host: row.imap_host,
    port: row.imap_port,
    secure: row.imap_port === 993 || row.imap_port === 995,
    auth: { user: row.username, pass: decryptSecret(row.secret) },
    logger: false,
    tls: { rejectUnauthorized: false },
  });
}

function smtpTransport(row) {
  return nodemailer.createTransport({
    host: row.smtp_host,
    port: row.smtp_port,
    secure: row.smtp_port === 465,
    auth: { user: row.username, pass: decryptSecret(row.secret) },
    tls: { rejectUnauthorized: false },
  });
}

function addrText(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (v.text) return v.text;
  if (Array.isArray(v.value)) {
    return v.value.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
  }
  return "";
}

function fromText(env) {
  if (!env) return "";
  const from = env.from && env.from[0];
  if (!from) return "";
  return from.name ? `${from.name} <${from.address}>` : from.address;
}

async function findTrash(client) {
  const list = await client.list();
  const trash = list.find((m) => m.specialUse === "\\Trash") || list.find((m) => /trash|coș|cos|gunoi/i.test(m.name));
  return trash ? trash.path : null;
}

async function findFolder(client, re) {
  const list = await client.list();
  const m = list.find((x) => re.test(x.specialUse || "") || re.test(x.name));
  return m ? m.path : null;
}

export default async function handler(req, res) {
  if (!SERVICE_KEY) {
    return json(res, 500, { message: "Lipsește SUPABASE_SERVICE_ROLE_KEY din setările proiectului Vercel." });
  }
  if (req.method !== "POST") return json(res, 405, { message: "Metodă nepermisă." });

  const email = sessionEmail(req);
  if (!email) return json(res, 401, { message: "Neautentificat." });

  const body = await readBody(req);
  const op = body.op;

  try {
    if (op === "account-get") {
      const rows = await listAccountRows(email);
      const active = rows.find((r) => r.active) || rows[0];
      return json(res, 200, { accounts: rows.map(toPublic), activeId: active ? active.id : "" });
    }

    if (op === "account-save") {
      const idIn = clean(body.id, 80);
      const emailIn = clean(body.email, 200);
      const imapHost = clean(body.imapHost, 200);
      const smtpHost = clean(body.smtpHost, 200);
      const username = clean(body.username, 200) || emailIn;
      const imapPort = Number(body.imapPort) || 993;
      const smtpPort = Number(body.smtpPort) || 465;
      const name = clean(body.name, 120);
      if (!emailIn || !imapHost || !smtpHost) return json(res, 400, { message: "Completează adresa și serverele." });

      let existing = null;
      if (idIn) {
        existing = await getAccountRow(email, idIn);
        if (!existing) return json(res, 404, { message: "Adresa nu există." });
      }
      const password = body.password ? String(body.password) : "";
      if (!password && !existing) return json(res, 400, { message: "Completează parola căsuței." });
      const secret = password ? encryptSecret(password) : existing.secret;

      const testRow = { imap_host: imapHost, imap_port: imapPort, username, secret };
      const client = imapClient(testRow);
      try {
        await client.connect();
        await client.logout();
      } catch {
        try { client.close(); } catch {}
        return json(res, 400, { message: "Conectarea a eșuat. Verifică serverul, portul și parola." });
      }

      if (existing) {
        const r = await fetch(`${base()}/mail_accounts?id=eq.${encodeURIComponent(existing.id)}`, {
          method: "PATCH",
          headers: headers({ prefer: "return=representation" }),
          body: JSON.stringify({
            email: emailIn, name, imap_host: imapHost, imap_port: imapPort,
            smtp_host: smtpHost, smtp_port: smtpPort, username, secret,
            updated_at: new Date().toISOString(),
          }),
        });
        if (!r.ok) throw new Error("db");
        const rows = await r.json();
        return json(res, 200, { account: toPublic(rows[0]) });
      }

      const rows0 = await listAccountRows(email);
      const r = await fetch(`${base()}/mail_accounts`, {
        method: "POST",
        headers: headers({ prefer: "return=representation" }),
        body: JSON.stringify({
          owner: email, email: emailIn, name, imap_host: imapHost, imap_port: imapPort,
          smtp_host: smtpHost, smtp_port: smtpPort, username, secret, active: rows0.length === 0,
        }),
      });
      if (!r.ok) throw new Error("db");
      const rows = await r.json();
      return json(res, 200, { account: toPublic(rows[0]) });
    }

    if (op === "account-remove") {
      const id = clean(body.id, 80);
      const row = await getAccountRow(email, id);
      if (!row) return json(res, 404, { message: "Adresa nu există." });
      await fetch(`${base()}/mail_accounts?id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: headers({ prefer: "return=minimal" }),
      });
      if (row.active) {
        const rest = await listAccountRows(email);
        if (rest.length) {
          await fetch(`${base()}/mail_accounts?id=eq.${encodeURIComponent(rest[0].id)}`, {
            method: "PATCH",
            headers: headers({ prefer: "return=minimal" }),
            body: JSON.stringify({ active: true }),
          });
        }
      }
      return json(res, 200, { ok: true });
    }

    if (op === "account-activate") {
      const id = clean(body.id, 80);
      const row = await getAccountRow(email, id);
      if (!row) return json(res, 404, { message: "Adresa nu există." });
      await fetch(`${base()}/mail_accounts?owner=eq.${encodeURIComponent(email)}`, {
        method: "PATCH", headers: headers({ prefer: "return=minimal" }), body: JSON.stringify({ active: false }),
      });
      await fetch(`${base()}/mail_accounts?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH", headers: headers({ prefer: "return=minimal" }), body: JSON.stringify({ active: true }),
      });
      return json(res, 200, { ok: true });
    }

    // Everything below needs an active mail account.
    const account = await getActiveRow(email);
    if (!account) return json(res, 400, { message: "Conectează întâi o adresă de email." });

    if (op === "folders") {
      const client = imapClient(account);
      try {
        await client.connect();
        const list = await client.list();
        return json(res, 200, {
          folders: list.map((m) => ({ path: m.path, name: m.name, specialUse: m.specialUse || "" })),
        });
      } finally {
        try { await client.logout(); } catch {}
      }
    }

    if (op === "list" || op === "search") {
      const folder = clean(body.folder, 200) || "INBOX";
      const client = imapClient(account);
      try {
        await client.connect();
        const box = await client.mailboxOpen(folder, { readOnly: true });

        let uids;
        if (op === "search") {
          const q = clean(body.query, 200);
          if (!q) return json(res, 200, { messages: [], total: 0 });
          uids = await client.search({ or: [{ subject: q }, { from: q }, { body: q }] }, { uid: true });
          uids = uids.slice(-100).reverse();
        } else {
          const total = box.exists || 0;
          const page = Math.max(0, Number(body.page) || 0);
          const to = total - page * PAGE_SIZE;
          const from = Math.max(1, to - PAGE_SIZE + 1);
          if (to < 1) return json(res, 200, { messages: [], total });
          const seqs = [];
          for await (const m of client.fetch(`${from}:${to}`, { envelope: true, flags: true, uid: true })) {
            seqs.push(m);
          }
          seqs.reverse();
          return json(res, 200, {
            total,
            messages: seqs.map((m) => ({
              uid: m.uid,
              from: fromText(m.envelope),
              subject: (m.envelope && m.envelope.subject) || "(fără subiect)",
              date: m.envelope && m.envelope.date,
              seen: m.flags && m.flags.has("\\Seen"),
            })),
          });
        }

        const messages = [];
        for (const uid of uids) {
          const m = await client.fetchOne(uid, { envelope: true, flags: true }, { uid: true });
          if (!m) continue;
          messages.push({
            uid: m.uid,
            from: fromText(m.envelope),
            subject: (m.envelope && m.envelope.subject) || "(fără subiect)",
            date: m.envelope && m.envelope.date,
            seen: m.flags && m.flags.has("\\Seen"),
          });
        }
        return json(res, 200, { messages, total: messages.length });
      } finally {
        try { await client.logout(); } catch {}
      }
    }

    if (op === "message") {
      const folder = clean(body.folder, 200) || "INBOX";
      const uid = Number(body.uid);
      if (!uid) return json(res, 400, { message: "Lipsește mesajul." });
      const client = imapClient(account);
      try {
        await client.connect();
        await client.mailboxOpen(folder);
        const m = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        if (!m || !m.source) return json(res, 404, { message: "Mesajul nu a fost găsit." });
        const parsed = await simpleParser(m.source);
        try { await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); } catch {}
        return json(res, 200, {
          messageId: parsed.messageId || "",
          from: addrText(parsed.from) || fromText(m.envelope),
          to: addrText(parsed.to),
          cc: addrText(parsed.cc),
          subject: parsed.subject || (m.envelope && m.envelope.subject) || "(fără subiect)",
          date: parsed.date || (m.envelope && m.envelope.date),
          html: parsed.html || null,
          text: parsed.text || "",
          attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename || "atașament", size: a.size || 0 })),
        });
      } finally {
        try { await client.logout(); } catch {}
      }
    }

    if (op === "attachment") {
      const folder = clean(body.folder, 200) || "INBOX";
      const uid = Number(body.uid);
      const index = Number(body.index);
      const client = imapClient(account);
      try {
        await client.connect();
        await client.mailboxOpen(folder, { readOnly: true });
        const m = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!m || !m.source) return json(res, 404, { message: "Mesajul nu a fost găsit." });
        const parsed = await simpleParser(m.source);
        const att = (parsed.attachments || [])[index];
        if (!att) return json(res, 404, { message: "Atașamentul nu a fost găsit." });
        return json(res, 200, {
          data: att.content.toString("base64"),
          filename: att.filename || "atasament",
          type: att.contentType || "application/octet-stream",
        });
      } finally {
        try { await client.logout(); } catch {}
      }
    }

    if (op === "flag") {
      const folder = clean(body.folder, 200) || "INBOX";
      const uid = Number(body.uid);
      const client = imapClient(account);
      try {
        await client.connect();
        await client.mailboxOpen(folder);
        if (body.seen) await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        else await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
        return json(res, 200, { ok: true });
      } finally {
        try { await client.logout(); } catch {}
      }
    }

    if (op === "delete") {
      const folder = clean(body.folder, 200) || "INBOX";
      const uid = Number(body.uid);
      const client = imapClient(account);
      try {
        await client.connect();
        await client.mailboxOpen(folder);
        const trash = await findTrash(client);
        if (trash && trash !== folder) {
          await client.messageMove(uid, trash, { uid: true });
        } else {
          await client.messageFlagsAdd(uid, ["\\Deleted"], { uid: true });
          await client.mailboxClose();
        }
        return json(res, 200, { ok: true });
      } finally {
        try { await client.logout(); } catch {}
      }
    }

    if (op === "draft-save" || op === "send") {
      const to = clean(body.to, 500);
      const cc = clean(body.cc, 500);
      const subject = clean(body.subject, 500);
      const text = String(body.text || "");
      if (op === "send" && !to) return json(res, 400, { message: "Completează destinatarul." });

      const fromHeader = account.name ? `"${account.name}" <${account.email}>` : account.email;
      const buildTransport = nodemailer.createTransport({ streamTransport: true, newline: "unix", buffer: true });
      const built = await buildTransport.sendMail({
        from: fromHeader,
        to: to || account.email,
        cc: cc || undefined,
        subject: subject || "(fără subiect)",
        text,
        inReplyTo: body.inReplyTo || undefined,
        references: body.inReplyTo || undefined,
      });
      const raw = built.message;

      if (op === "send") {
        const transporter = smtpTransport(account);
        try {
          await transporter.sendMail({ raw, envelope: { from: account.email, to: [to, cc].filter(Boolean).join(",") } });
        } catch {
          return json(res, 502, { message: "Nu am putut trimite. Verifică setările serverului de trimitere." });
        }
        const client = imapClient(account);
        try {
          await client.connect();
          const sent = await findFolder(client, /\\Sent/i);
          if (sent) await client.append(sent, raw, ["\\Seen"]);
        } catch {
          // best-effort: message was sent even if we couldn't file a copy
        } finally {
          try { await client.logout(); } catch {}
        }
        return json(res, 200, { ok: true });
      }

      const client = imapClient(account);
      try {
        await client.connect();
        const drafts = (await findFolder(client, /\\Drafts/i)) || "Drafts";
        await client.append(drafts, raw, ["\\Draft"]);
        return json(res, 200, { ok: true });
      } catch {
        return json(res, 502, { message: "Nu am putut salva ciorna." });
      } finally {
        try { await client.logout(); } catch {}
      }
    }

    return json(res, 404, { message: "Acțiune necunoscută." });
  } catch (err) {
    return json(res, 502, { message: "Nu am putut contacta serverul de email." });
  }
}
