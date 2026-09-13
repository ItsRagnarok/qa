import { scrypt, timingSafeEqual, createHmac, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ldfpnnfagcvjhdmfzxhi.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const base = () => `${SUPABASE_URL}/rest/v1`;

const COOKIE = "yv_session";
const MAX_AGE = 60 * 60 * 24 * 30;
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function json(res, status, body) {
  res.status(status).setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function dbHeaders(extra) {
  return { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", ...extra };
}

function signingKey() {
  return createHmac("sha256", SERVICE_KEY).update("your-voice-session-v1").digest();
}

function sign(email, expires, pwVersion) {
  const payload = `${email}|${expires}|${pwVersion || 0}`;
  const mac = createHmac("sha256", signingKey()).update(payload).digest("hex");
  return `${Buffer.from(payload).toString("base64url")}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== "string") return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  let payload;
  try {
    payload = Buffer.from(body, "base64url").toString();
  } catch {
    return null;
  }
  const expected = createHmac("sha256", signingKey()).update(payload).digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [email, expires, pwVersion] = payload.split("|");
  if (!email || !expires || Number(expires) < Date.now()) return null;
  return { email, pwVersion: Number(pwVersion) || 0 };
}

function setSessionCookie(res, email, pwVersion) {
  const expires = Date.now() + MAX_AGE * 1000;
  res.setHeader("set-cookie", [
    `${COOKIE}=${encodeURIComponent(sign(email, expires, pwVersion))}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
    `qavb_ok=1; Path=/; Max-Age=${MAX_AGE}; Secure; SameSite=Lax`,
  ]);
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/**
 * Shared by every other function in this project: the session cookie's email for the
 * current request, or null. Also checked against the account's current password_version,
 * so a password reset invalidates any cookie signed before it (that's the one extra query
 * this adds per request — fine at this app's scale).
 */
export async function sessionEmail(req) {
  const parsed = verify(readCookie(req, COOKIE));
  if (!parsed) return null;
  let user;
  try {
    user = await findUser(parsed.email);
  } catch {
    return null;
  }
  if (!user || (user.password_version || 0) !== parsed.pwVersion) return null;
  return parsed.email;
}

async function findUser(email) {
  const url = `${base()}/app_users?select=email,password_hash,must_change,is_admin,password_version&email=eq.${encodeURIComponent(email)}&limit=1`;
  const r = await fetch(url, { headers: dbHeaders() });
  if (!r.ok) throw new Error(`Supabase ${r.status}`);
  const rows = await r.json();
  return rows[0] || null;
}

/** Format written by the account's original auth: scrypt$<N>$<salt hex>$<key hex>. */
async function passwordMatches(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  if (!Number.isInteger(N) || N < 2) return false;
  const salt = Buffer.from(parts[2], "hex");
  const expected = Buffer.from(parts[3], "hex");
  if (!salt.length || !expected.length) return false;
  const got = await scryptAsync(password, salt, expected.length, { N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const N = 16384;
  const key = await scryptAsync(password, salt, 64, { N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${salt.toString("hex")}$${key.toString("hex")}`;
}

function genPassword() {
  const bytes = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  return out;
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

async function requireAdmin(req) {
  const email = await sessionEmail(req);
  if (!email) return { email: null, isAdmin: false };
  const user = await findUser(email);
  return { email, isAdmin: !!(user && user.is_admin) };
}

async function handleAdmin(req, res) {
  const { email: me, isAdmin } = await requireAdmin(req);
  if (!me) return json(res, 401, { message: "Neautentificat." });
  if (!isAdmin) return json(res, 403, { message: "Nu ai drepturi de administrator." });

  const body = await readBody(req);
  const op = body.op;

  if (op === "list") {
    const r = await fetch(`${base()}/app_users?select=email,is_admin,must_change,created_at,last_login_at`, { headers: dbHeaders() });
    if (!r.ok) return json(res, 502, { message: "Nu am putut încărca lista." });
    const users = await r.json();
    const withCounts = await Promise.all(
      users.map(async (u) => {
        const pr = await fetch(
          `${base()}/plans?owner=eq.${encodeURIComponent(u.email)}&select=id`,
          { headers: dbHeaders() },
        );
        const plans = pr.ok ? await pr.json() : [];
        return {
          email: u.email,
          isAdmin: !!u.is_admin,
          mustChange: !!u.must_change,
          createdAt: u.created_at,
          lastLoginAt: u.last_login_at,
          plans: plans.length,
        };
      }),
    );
    return json(res, 200, { users: withCounts });
  }

  if (op === "create") {
    const addr = String(body.email || "").trim().toLowerCase();
    if (!addr) return json(res, 400, { message: "Completează adresa de email." });
    const existing = await findUser(addr);
    if (existing) return json(res, 400, { message: "Există deja un cont cu acest email." });
    const password = String(body.password || "").trim() || genPassword();
    if (password.length < 8) return json(res, 400, { message: "Parola trebuie să aibă cel puțin 8 caractere." });
    const hash = await hashPassword(password);
    const r = await fetch(`${base()}/app_users`, {
      method: "POST",
      headers: dbHeaders({ prefer: "return=minimal" }),
      body: JSON.stringify({
        email: addr, password_hash: hash, is_admin: !!body.isAdmin,
        must_change: body.mustChange !== false,
      }),
    });
    if (!r.ok) return json(res, 502, { message: "Nu am putut crea contul." });
    return json(res, 200, { email: addr, password });
  }

  if (op === "reset") {
    const addr = String(body.email || "").trim().toLowerCase();
    const target = await findUser(addr);
    if (!target) return json(res, 404, { message: "Contul nu există." });
    const password = String(body.password || "").trim() || genPassword();
    if (password.length < 8) return json(res, 400, { message: "Parola trebuie să aibă cel puțin 8 caractere." });
    const hash = await hashPassword(password);
    const r = await fetch(`${base()}/app_users?email=eq.${encodeURIComponent(addr)}`, {
      method: "PATCH",
      headers: dbHeaders({ prefer: "return=minimal" }),
      body: JSON.stringify({
        password_hash: hash, must_change: !!body.mustChange,
        password_version: (target.password_version || 0) + 1,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!r.ok) return json(res, 502, { message: "Nu am putut schimba parola." });
    return json(res, 200, { email: addr, password });
  }

  if (op === "set-admin") {
    const addr = String(body.email || "").trim().toLowerCase();
    if (addr === me) return json(res, 400, { message: "Nu-ți poți schimba singur statutul de administrator." });
    const target = await findUser(addr);
    if (!target) return json(res, 404, { message: "Contul nu există." });
    const r = await fetch(`${base()}/app_users?email=eq.${encodeURIComponent(addr)}`, {
      method: "PATCH",
      headers: dbHeaders({ prefer: "return=minimal" }),
      body: JSON.stringify({ is_admin: !!body.isAdmin, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) return json(res, 502, { message: "Nu am putut schimba drepturile." });
    return json(res, 200, { ok: true });
  }

  if (op === "delete") {
    const addr = String(body.email || "").trim().toLowerCase();
    if (addr === me) return json(res, 400, { message: "Nu-ți poți șterge singur contul." });
    const target = await findUser(addr);
    if (!target) return json(res, 404, { message: "Contul nu există." });
    await fetch(`${base()}/app_users?email=eq.${encodeURIComponent(addr)}`, { method: "DELETE", headers: dbHeaders({ prefer: "return=minimal" }) });
    await fetch(`${base()}/board_state?id=eq.${encodeURIComponent(addr)}`, { method: "DELETE", headers: dbHeaders({ prefer: "return=minimal" }) });
    await fetch(`${base()}/plans?owner=eq.${encodeURIComponent(addr)}`, { method: "DELETE", headers: dbHeaders({ prefer: "return=minimal" }) });
    await fetch(`${base()}/mail_accounts?owner=eq.${encodeURIComponent(addr)}`, { method: "DELETE", headers: dbHeaders({ prefer: "return=minimal" }) });
    await fetch(`${base()}/project_tasks?owner=eq.${encodeURIComponent(addr)}`, { method: "DELETE", headers: dbHeaders({ prefer: "return=minimal" }) });
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { message: "Acțiune necunoscută." });
}

export default async function handler(req, res) {
  if (!SERVICE_KEY) {
    return json(res, 500, {
      message: "Lipsește SUPABASE_SERVICE_ROLE_KEY din setările proiectului Vercel.",
    });
  }

  const action = new URL(req.url, "http://x").searchParams.get("action");

  if (action === "me") {
    const email = await sessionEmail(req);
    if (!email) return json(res, 200, { authenticated: false, email: null });
    let user = null;
    try {
      user = await findUser(email);
    } catch {
      return json(res, 200, { authenticated: true, email });
    }
    return json(res, 200, {
      authenticated: true,
      email,
      isAdmin: !!(user && user.is_admin),
      mustChange: !!(user && user.must_change),
    });
  }

  if (action === "logout") {
    res.setHeader("set-cookie", [
      `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      `qavb_ok=; Path=/; Max-Age=0; Secure; SameSite=Lax`,
    ]);
    return json(res, 200, { ok: true });
  }

  if (action === "admin") {
    if (req.method !== "POST") return json(res, 405, { message: "Metodă nepermisă." });
    return handleAdmin(req, res);
  }

  if (action === "password") {
    if (req.method !== "POST") return json(res, 405, { message: "Metodă nepermisă." });
    const email = await sessionEmail(req);
    if (!email) return json(res, 401, { message: "Neautentificat." });
    const { currentPassword, newPassword } = await readBody(req);
    if (!newPassword || String(newPassword).length < 8) {
      return json(res, 400, { message: "Parola nouă trebuie să aibă cel puțin 8 caractere." });
    }
    let user;
    try {
      user = await findUser(email);
    } catch {
      return json(res, 502, { message: "Nu am putut contacta baza de date." });
    }
    if (!user) return json(res, 404, { message: "Contul nu există." });
    if (!user.must_change) {
      const ok = await passwordMatches(currentPassword || "", user.password_hash);
      if (!ok) return json(res, 401, { message: "Parola actuală este greșită." });
    }
    const hash = await hashPassword(String(newPassword));
    const nextVersion = (user.password_version || 0) + 1;
    const r = await fetch(`${base()}/app_users?email=eq.${encodeURIComponent(email)}`, {
      method: "PATCH",
      headers: dbHeaders({ prefer: "return=minimal" }),
      body: JSON.stringify({ password_hash: hash, must_change: false, password_version: nextVersion, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) return json(res, 502, { message: "Nu am putut schimba parola." });
    // Changing your own password bumps password_version, which would otherwise invalidate
    // the very cookie this request is using — reissue it so this session stays logged in.
    setSessionCookie(res, email, nextVersion);
    return json(res, 200, { ok: true });
  }

  if (action !== "login") return json(res, 404, { message: "Acțiune necunoscută." });
  if (req.method !== "POST") return json(res, 405, { message: "Metodă nepermisă." });

  const { email, password } = await readBody(req);
  const addr = String(email || "").trim().toLowerCase();
  if (!addr || !password) return json(res, 400, { message: "Completează emailul și parola." });

  let user;
  try {
    user = await findUser(addr);
  } catch {
    return json(res, 502, { message: "Nu am putut contacta baza de date." });
  }

  const ok = user
    ? await passwordMatches(password, user.password_hash)
    : (await scryptAsync(password, randomBytes(16), 64, { N: 16384, r: 8, p: 1 }), false);

  if (!ok) return json(res, 401, { message: "Email sau parolă greșite." });

  fetch(`${base()}/app_users?email=eq.${encodeURIComponent(user.email)}`, {
    method: "PATCH",
    headers: dbHeaders({ prefer: "return=minimal" }),
    body: JSON.stringify({ last_login_at: new Date().toISOString() }),
  }).catch(() => {});

  setSessionCookie(res, user.email, user.password_version || 0);
  return json(res, 200, { ok: true, email: user.email });
}
