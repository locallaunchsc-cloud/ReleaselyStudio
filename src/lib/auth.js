// Artist accounts: email + password, sessions in D1, HttpOnly cookie.
import {
  json, err, nowIso, addDays, randomHex, toHex, sha256Hex, safeEqual, parseCookies, cookie,
  readJson, ipHash, canonicalEmail, config,
} from "./util.js";
import { attributeSignup } from "./referrals.js";
import { claimPaymentsForUser } from "./payments.js";

const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000; // the maximum Cloudflare Workers allows
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DEVICE_RE = /^[a-f0-9]{8,48}$/;

async function hashPassword(password, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return toHex(bits);
}

// Referral codes look like JAYGRIFFIN7K: readable, unique, no confusing characters.
async function newRefCode(db, name, email) {
  const base = (name || email.split("@")[0]).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "ARTIST";
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  for (let i = 0; i < 8; i++) {
    const suffix = Array.from(crypto.getRandomValues(new Uint8Array(i < 4 ? 2 : 4)), (b) => alphabet[b % alphabet.length]).join("");
    const code = base + suffix;
    const hit = await db.prepare("SELECT 1 FROM users WHERE ref_code = ?1").bind(code).first();
    if (!hit) return code;
  }
  return "ARTIST" + randomHex(5).toUpperCase();
}

async function createSession(env, userId, ip) {
  const token = randomHex(32);
  const now = nowIso();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, ip_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)"
  ).bind(await sha256Hex(token), userId, ip, now, addDays(now, SESSION_DAYS)).run();
  return cookie("rl_sess", token, { maxAge: SESSION_DAYS * 86400, secure: !env.DEV_INSECURE_COOKIES });
}

export async function currentUser(request, env) {
  const token = parseCookies(request).rl_sess;
  if (!token || token.length !== 64) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?1 AND s.expires_at > ?2`
  ).bind(await sha256Hex(token), nowIso()).first();
  return row || null;
}

export function isAdmin(user, env) {
  if (!user) return false;
  const cfg = config(env);
  return cfg.adminIds.includes(user.id) || cfg.devAdminEmails.includes(String(user.email).toLowerCase());
}

export function publicUser(user, env) {
  return {
    id: user.id,
    email: user.email,
    name: user.display_name,
    ref_code: user.ref_code,
    plan: user.plan,
    is_admin: isAdmin(user, env),
    payout_method: user.payout_method || "",
    payout_handle: user.payout_handle || "",
  };
}

async function tooManyAttempts(env, ip) {
  const since = new Date(Date.now() - 15 * 60000).toISOString();
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip_hash = ?1 AND at > ?2").bind(ip, since).first();
  return (r?.n || 0) >= 20;
}

export async function signup(request, env) {
  const body = await readJson(request);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const name = String(body.name || "").trim().slice(0, 60);
  if (!EMAIL_RE.test(email) || email.length > 200) return err("Enter a valid email address.");
  if (password.length < 8 || password.length > 200) return err("Use a password with at least 8 characters.");

  const ip = await ipHash(request, env);
  if (await tooManyAttempts(env, ip)) return err("Too many attempts. Try again in 15 minutes.", 429);
  await env.DB.prepare("INSERT INTO login_attempts (ip_hash, at) VALUES (?1, ?2)").bind(ip, nowIso()).run();

  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE email = ?1").bind(email).first();
  if (exists) return err("An account with this email already exists. Log in instead.", 409);

  const id = randomHex(12);
  const salt = randomHex(16);
  const device = DEVICE_RE.test(String(body.device || "")) ? body.device : null;
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO users (id, email, email_canonical, password_hash, password_salt, display_name, ref_code,
                        device_id, signup_ip_hash, last_ip_hash, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)`
  ).bind(id, email, canonicalEmail(email), await hashPassword(password, salt), salt, name,
         await newRefCode(env.DB, name, email), device, ip, now).run();

  // Referral attribution happens here, on the server, from the cookie set when
  // the visitor landed on a referral link (or the code the form sends along).
  const refCode = parseCookies(request).rl_ref || body.ref || "";
  const attribution = await attributeSignup(env, { userId: id, email, device, ip, refCode });

  // Anyone who paid before creating an account (e.g. founding members) gets
  // their payments linked by email. No commission on payments made before attribution.
  await claimPaymentsForUser(env, await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(id).first(), { earnCommission: false });
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(id).first();

  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", await createSession(env, id, ip));
  headers.append("Set-Cookie", cookie("rl_ref", "", { maxAge: 0, secure: !env.DEV_INSECURE_COOKIES }));
  return new Response(JSON.stringify({ ok: true, user: publicUser(user, env), referral: attribution }), { status: 201, headers });
}

export async function login(request, env) {
  const body = await readJson(request);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const ip = await ipHash(request, env);
  if (await tooManyAttempts(env, ip)) return err("Too many attempts. Try again in 15 minutes.", 429);
  await env.DB.prepare("INSERT INTO login_attempts (ip_hash, at) VALUES (?1, ?2)").bind(ip, nowIso()).run();

  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?1").bind(email).first();
  const ok = user && safeEqual(await hashPassword(password, user.password_salt), user.password_hash);
  if (!ok) return err("That email and password don't match.", 401);

  await env.DB.prepare("UPDATE users SET last_ip_hash = ?1 WHERE id = ?2").bind(ip, user.id).run();
  return json({ ok: true, user: publicUser(user, env) }, 200, { "Set-Cookie": await createSession(env, user.id, ip) });
}

export async function logout(request, env) {
  const token = parseCookies(request).rl_sess;
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { "Set-Cookie": cookie("rl_sess", "", { maxAge: 0, secure: !env.DEV_INSECURE_COOKIES }) });
}

export async function me(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ ok: true, user: null });
  return json({ ok: true, user: publicUser(user, env) });
}
