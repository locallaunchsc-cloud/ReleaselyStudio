// Referral links, attribution and the artist's referral dashboard.
import { json, err, nowIso, cookie, parseCookies, ipHash, canonicalEmail, maskEmail, readJson, config } from "./util.js";
import { balances, matureCommissions, NET_REVENUE_SQL } from "./commissions.js";

const CODE_RE = /^[A-Z0-9]{4,20}$/;

export function normalizeCode(code) {
  const c = String(code || "").trim().toUpperCase();
  return CODE_RE.test(c) ? c : "";
}

// Someone opened releaselystudio.com/?ref=CODE. Log the click on the server and
// remember the code in an HttpOnly cookie until they sign up. Last valid link wins.
export async function captureLanding(request, env) {
  const url = new URL(request.url);
  const code = normalizeCode(url.searchParams.get("ref"));
  if (!code) return null;
  const owner = await env.DB.prepare("SELECT id FROM users WHERE ref_code = ?1").bind(code).first();
  if (!owner) return null;
  // Don't count a refresh as a new click.
  if (parseCookies(request).rl_ref !== code) {
    await env.DB.prepare("INSERT INTO referral_clicks (ref_code, referrer_id, ip_hash, landed_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(code, owner.id, await ipHash(request, env), nowIso()).run();
  }
  return cookie("rl_ref", code, { maxAge: config(env).refCookieDays * 86400, secure: !env.DEV_INSECURE_COOKIES });
}

// Lets the signup form show "Invited by ...".
export async function pendingReferral(request, env) {
  const code = normalizeCode(parseCookies(request).rl_ref || new URL(request.url).searchParams.get("ref"));
  if (!code) return json({ ok: true, referrer: null });
  const owner = await env.DB.prepare("SELECT display_name, ref_code FROM users WHERE ref_code = ?1").bind(code).first();
  return json({ ok: true, referrer: owner ? { name: owner.display_name || "An artist", code: owner.ref_code } : null });
}

// Runs once, inside signup. Returns what happened so it can be tested.
export async function attributeSignup(env, { userId, email, device, ip, refCode }) {
  const code = normalizeCode(refCode);
  if (!code) return { attributed: false, reason: "no_code" };
  const referrer = await env.DB.prepare("SELECT * FROM users WHERE ref_code = ?1").bind(code).first();
  if (!referrer) return { attributed: false, reason: "unknown_code" };
  if (referrer.id === userId) return { attributed: false, reason: "self_referral" };

  // Same inbox under a different spelling (j.ay+2@gmail.com) is the same person.
  if (referrer.email_canonical === canonicalEmail(email)) return { attributed: false, reason: "self_referral" };

  const flags = [];
  if (ip && (ip === referrer.signup_ip_hash || ip === referrer.last_ip_hash)) flags.push("same_ip_as_referrer");
  if (device && device === referrer.device_id) flags.push("same_device_as_referrer");
  const since = new Date(Date.now() - 86400000).toISOString();
  const burst = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM referrals r JOIN users u ON u.id = r.referred_user_id
     WHERE r.referrer_id = ?1 AND u.signup_ip_hash = ?2 AND r.created_at > ?3`
  ).bind(referrer.id, ip, since).first();
  if ((burst?.n || 0) >= 2) flags.push("many_signups_same_ip");

  try {
    await env.DB.prepare(
      "INSERT INTO referrals (referrer_id, referred_user_id, ref_code, flags, created_at) VALUES (?1, ?2, ?3, ?4, ?5)"
    ).bind(referrer.id, userId, code, JSON.stringify(flags), nowIso()).run();
  } catch (e) {
    // UNIQUE(referred_user_id): this artist is already attributed. Keep the original.
    return { attributed: false, reason: "already_attributed" };
  }
  return { attributed: true, referrer_code: code, flags };
}

// Everything the Artist Referral Dashboard shows, straight from the database.
export async function dashboard(env, user, origin) {
  await matureCommissions(env);
  const db = env.DB;
  const [clicks, signups, paying, revenue, history, ledger] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM referral_clicks WHERE referrer_id = ?1").bind(user.id),
    db.prepare("SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ?1").bind(user.id),
    db.prepare(
      `SELECT COUNT(DISTINCT c.referred_user_id) AS n FROM commissions c JOIN payments p ON p.id = c.payment_id
       WHERE c.referrer_id = ?1 AND c.kind = 'commission' AND (${NET_REVENUE_SQL}) > 0`
    ).bind(user.id),
    db.prepare(
      `SELECT COALESCE(SUM(${NET_REVENUE_SQL}), 0) AS cents FROM commissions c JOIN payments p ON p.id = c.payment_id
       WHERE c.referrer_id = ?1 AND c.kind = 'commission'`
    ).bind(user.id),
    db.prepare(
      `SELECT r.created_at AS joined_at, u.display_name, u.email, u.plan,
              COALESCE((SELECT SUM(${NET_REVENUE_SQL}) FROM commissions c JOIN payments p ON p.id = c.payment_id
                        WHERE c.referred_user_id = r.referred_user_id AND c.referrer_id = r.referrer_id AND c.kind = 'commission'), 0) AS revenue_cents,
              COALESCE((SELECT SUM(c.amount_cents) FROM commissions c
                        WHERE c.referred_user_id = r.referred_user_id AND c.referrer_id = r.referrer_id AND c.status <> 'reversed'), 0) AS commission_cents
       FROM referrals r JOIN users u ON u.id = r.referred_user_id
       WHERE r.referrer_id = ?1 ORDER BY r.created_at DESC LIMIT 200`
    ).bind(user.id),
    db.prepare(
      `SELECT c.id, c.kind, c.amount_cents, c.base_cents, c.currency, c.status, c.available_at, c.created_at,
              u.display_name, u.email
       FROM commissions c LEFT JOIN users u ON u.id = c.referred_user_id
       WHERE c.referrer_id = ?1 ORDER BY c.created_at DESC LIMIT 200`
    ).bind(user.id),
  ]);
  const b = await balances(db, user.id);
  const who = (r) => r.display_name || maskEmail(r.email);
  return {
    ref_code: user.ref_code,
    link: `${origin}/?ref=${user.ref_code}`,
    rate_percent: config(env).rateBps / 100,
    hold_days: config(env).holdDays,
    min_payout_cents: config(env).minPayoutCents,
    stats: {
      link_visits: clicks.results[0].n,
      referred: signups.results[0].n,
      paying: paying.results[0].n,
      revenue_cents: revenue.results[0].cents,
      ...b,
    },
    referrals: history.results.map((r) => ({
      artist: who(r), joined_at: r.joined_at, paying: r.revenue_cents > 0,
      revenue_cents: r.revenue_cents, commission_cents: r.commission_cents,
    })),
    commissions: ledger.results.map((r) => ({
      id: r.id, kind: r.kind, artist: r.email ? who(r) : "Adjustment", amount_cents: r.amount_cents,
      payment_cents: r.base_cents, status: r.status, available_at: r.available_at, created_at: r.created_at,
    })),
    payout: { method: user.payout_method || "", handle: user.payout_handle || "" },
  };
}

const PAYOUT_METHODS = new Set(["paypal", "cashapp", "venmo", "usdc_solana", "usdc_base", "other"]);

export async function savePayoutMethod(request, env, user) {
  const body = await readJson(request);
  const method = String(body.method || "");
  const handle = String(body.handle || "").trim().slice(0, 120);
  if (!PAYOUT_METHODS.has(method)) return err("Pick a payout method.");
  if (!handle) return err("Add where we should send your payouts.");
  await env.DB.prepare("UPDATE users SET payout_method = ?1, payout_handle = ?2 WHERE id = ?3").bind(method, handle, user.id).run();
  return json({ ok: true });
}
