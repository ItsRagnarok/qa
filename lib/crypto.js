import { createHmac, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function aesKey() {
  return createHmac("sha256", SERVICE_KEY).update("your-voice-mail-secret-v1").digest();
}

export function encryptSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(packed) {
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", aesKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
