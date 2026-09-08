import { scrypt, timingSafeEqual, createHmac, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ldfpnnfagcvjhdmfzxhi.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const COOKIE = "yv_session";
const MAX_AGE = 60 * 60 * 24 * 30;

function json(res, status, body) {
  res.status(status).setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function signingKey() {
  return createHmac("sha256", SERVICE_KEY).update("your-voice-session-v1").digest();
}

function sign(email, expires) {
  const payload = `${email}|${expires}`;
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
  const [email, expires] = payload.split("|");
  if (!email || !expires || Number(expires) < Date.now()) return null;
  return email;
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

/** Shared by every other function in this project: the session cookie for the current request, or null. */
export function sessionEmail(req) {
  return verify(readCookie(req, COOKIE));
}

async function findUser(email) {
  const url =
    `${SUPABASE_URL}/rest/v1/app_users` +
    `?select=email,password_hash&email=eq.${encodeURIComponent(email)}&limit=1`;
  const r = await fetch(url, {
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
  });
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
  const got = await scryptAsync(password, salt, expected.length, {
    N,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });
  return got.length === expected.length && timingSafeEqual(got, expected);
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
  if (!SERVICE_KEY) {
    return json(res, 500, {
      message: "Lipsește SUPABASE_SERVICE_ROLE_KEY din setările proiectului Vercel.",
    });
  }

  const action = new URL(req.url, "http://x").searchParams.get("action");

  if (action === "me") {
    const email = sessionEmail(req);
    return json(res, 200, { authenticated: !!email, email: email || null });
  }

  if (action === "logout") {
    res.setHeader("set-cookie", [
      `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      `qavb_ok=; Path=/; Max-Age=0; Secure; SameSite=Lax`,
    ]);
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

  const expires = Date.now() + MAX_AGE * 1000;
  res.setHeader("set-cookie", [
    `${COOKIE}=${encodeURIComponent(sign(user.email, expires))}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
    `qavb_ok=1; Path=/; Max-Age=${MAX_AGE}; Secure; SameSite=Lax`,
  ]);
  return json(res, 200, { ok: true, email: user.email });
}
