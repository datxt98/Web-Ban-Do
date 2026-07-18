import crypto from "node:crypto";

const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_SALT_BYTES = 16;
const DEFAULT_TOKEN_DAYS = 7;

export function createPasswordRecord(password) {
  const salt = crypto.randomBytes(PASSWORD_SALT_BYTES).toString("hex");
  const hash = hashPassword(password, salt);
  return { passwordHash: hash, passwordSalt: salt };
}

export function verifyPassword(password, user) {
  const passwordHash = String(user?.passwordHash ?? user?.password_hash ?? "");
  const passwordSalt = String(user?.passwordSalt ?? user?.password_salt ?? "");
  if (!passwordHash || !passwordSalt) return false;

  const expected = Buffer.from(passwordHash, "hex");
  const actual = Buffer.from(hashPassword(password, passwordSalt), "hex");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export function createAuthToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const maxAgeDays = readNumberEnv("BANDO_AUTH_TOKEN_DAYS", DEFAULT_TOKEN_DAYS);
  const payload = {
    sub: Number(user.id) || 0,
    username: String(user.username || ""),
    role: String(user.role || "admin"),
    iat: now,
    exp: now + Math.max(1, maxAgeDays) * 24 * 60 * 60,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function verifyAuthToken(token) {
  const text = String(token || "").trim();
  const [encodedPayload, suppliedSignature] = text.split(".");
  if (!encodedPayload || !suppliedSignature) return null;

  const expectedSignature = sign(encodedPayload);
  if (!safeEqual(expectedSignature, suppliedSignature)) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload?.username || !payload?.exp) return null;
    if (Number(payload.exp) < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password || ""), salt, PASSWORD_KEY_LENGTH).toString("hex");
}

function sign(value) {
  return crypto.createHmac("sha256", authSecret()).update(value).digest("base64url");
}

function authSecret() {
  return process.env.BANDO_AUTH_SECRET?.trim() || process.env.BANDO_BOT_TOKEN?.trim() || "bando-dev-change-this-secret";
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function readNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}
