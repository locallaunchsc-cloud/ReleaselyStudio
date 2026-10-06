// Small helpers shared by every API module.

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

export function err(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

export function nowIso() {
  return new Date().toISOString();
}

export function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * 86400000).toISOString();
}

export function randomHex(bytes = 16) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

// Constant-time string compare for signatures and hashes.
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseCookies(request) {
  const out = {};
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, httpOnly = true, secure = true } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (httpOnly) c += "; HttpOnly";
  if (secure) c += "; Secure";
  return c;
}

export async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

// IPs are never stored raw: only a salted hash, used to spot duplicate accounts.
export async function ipHash(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return (await hmacHex(env.IP_SALT || "releasely-ip-salt", ip)).slice(0, 32);
}

// Lowercase, and for Gmail-style providers drop dots and +tags, so
// jay+1@gmail.com and j.a.y@gmail.com are recognized as the same inbox.
export function canonicalEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  local = local.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

export function maskEmail(email) {
  const [local, domain] = String(email || "").split("@");
  if (!domain) return "artist";
  return `${local.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, local.length - 2)))}@${domain}`;
}

// Requests that change data must come from the site itself.
export function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // non-browser clients (curl, Stripe) have no Origin
  return origin === new URL(request.url).origin;
}

export function config(env) {
  const num = (v, d) => (v === undefined || v === "" || isNaN(Number(v)) ? d : Number(v));
  return {
    rateBps: num(env.COMMISSION_RATE_BPS, 2000),       // 2000 basis points = 20%
    holdDays: num(env.COMMISSION_HOLD_DAYS, 30),        // refund window before a commission is payable
    months: num(env.COMMISSION_MONTHS, 0),              // 0 = commissions for as long as the artist pays
    minPayoutCents: num(env.MIN_PAYOUT_CENTS, 2000),    // $20 minimum before paying out
    refCookieDays: num(env.REF_COOKIE_DAYS, 60),
    // Admins are listed by account id, not email: emails aren't verified yet, so
    // anyone could register an address first. DEV_ADMIN_EMAILS is for local tests only.
    adminIds: String(env.ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
    devAdminEmails: String(env.DEV_ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}
