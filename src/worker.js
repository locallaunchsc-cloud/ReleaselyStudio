// Releasely Studio Worker: the static site in /public, plus a small API.
//   /api/count, /api/stats        usage counter (unchanged)
//   /api/auth/*, /api/me          artist accounts
//   /api/referrals/*              referral dashboard
//   /api/stripe/webhook           payments from Stripe
//   /api/admin/*                  admin view (ADMIN_USER_IDS only)
import { json, err, sameOrigin } from "./lib/util.js";
import { ensureSchema } from "./lib/schema.js";
import { signup, login, logout, me, currentUser, isAdmin } from "./lib/auth.js";
import { captureLanding, pendingReferral, dashboard, savePayoutMethod } from "./lib/referrals.js";
import { stripeWebhook } from "./lib/payments.js";
import { matureCommissions } from "./lib/commissions.js";
import * as admin from "./lib/admin.js";

const EVENTS = new Set(["album", "teasers"]);
const AID = /^[a-f0-9]{8,48}$/;

async function countEvent(request, env) {
  // Only count requests coming from the site itself.
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ ok: false }, 403);
  let body = {};
  try { body = await request.json(); } catch {}
  const event = body.event;
  if (!EVENTS.has(event)) return json({ ok: false }, 400);
  const stmts = [
    env.DB.prepare("INSERT INTO counters (name, n) VALUES (?1, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1").bind(event),
  ];
  if (typeof body.aid === "string" && AID.test(body.aid)) {
    stmts.push(env.DB.prepare(
      "INSERT INTO artists (aid, event) VALUES (?1, ?2) ON CONFLICT(aid, event) DO UPDATE SET n = n + 1"
    ).bind(body.aid, event));
  }
  await env.DB.batch(stmts);
  return json({ ok: true });
}

async function stats(env) {
  const [counts, uniq, repeat] = await env.DB.batch([
    env.DB.prepare("SELECT name, n FROM counters"),
    env.DB.prepare("SELECT COUNT(DISTINCT aid) AS artists FROM artists"),
    env.DB.prepare('SELECT COUNT(*) AS "returning" FROM (SELECT aid FROM artists GROUP BY aid HAVING SUM(n) > 1)'),
  ]);
  const out = { album: 0, teasers: 0 };
  for (const r of counts.results) if (EVENTS.has(r.name)) out[r.name] = r.n;
  // Unique artists only counted from this update onward; earlier albums had no ID.
  out.artists = uniq.results[0]?.artists || 0;
  out.returning = repeat.results[0]?.returning || 0;
  return json(out);
}

async function api(request, env, url) {
  const { pathname: p } = url;
  const m = request.method;

  // Stripe signs its webhook; it never sends an Origin header.
  if (p === "/api/stripe/webhook" && m === "POST") return stripeWebhook(request, env);

  if (m !== "GET" && !sameOrigin(request)) return err("Cross-site request blocked.", 403);

  if (p === "/api/count" && m === "POST") return countEvent(request, env);
  if (p === "/api/stats" && m === "GET") return stats(env);

  if (p === "/api/auth/signup" && m === "POST") return signup(request, env);
  if (p === "/api/auth/login" && m === "POST") return login(request, env);
  if (p === "/api/auth/logout" && m === "POST") return logout(request, env);
  if (p === "/api/me" && m === "GET") return me(request, env);
  if (p === "/api/referrals/pending" && m === "GET") return pendingReferral(request, env);

  const user = await currentUser(request, env);
  if (p.startsWith("/api/referrals/") || p.startsWith("/api/admin/")) {
    if (!user) return err("Log in first.", 401);
  }

  if (p === "/api/referrals/me" && m === "GET") return json({ ok: true, ...(await dashboard(env, user, url.origin)) });
  if (p === "/api/referrals/payout-method" && m === "POST") return savePayoutMethod(request, env, user);

  if (p.startsWith("/api/admin/")) {
    if (!isAdmin(user, env)) return err("Admins only.", 403);
    if (p === "/api/admin/overview" && m === "GET") return json({ ok: true, ...(await admin.overview(env)) });
    if (p === "/api/admin/referrers" && m === "GET") return json({ ok: true, referrers: await admin.referrers(env) });
    if (p === "/api/admin/referrals" && m === "GET") return json({ ok: true, referrals: await admin.referralList(env) });
    if (p === "/api/admin/commissions" && m === "GET") {
      return json({ ok: true, commissions: await admin.commissionList(env, url.searchParams.get("status") || "") });
    }
    if (p === "/api/admin/adjustments" && m === "POST") return admin.createAdjustment(request, env, user);
    if (p === "/api/admin/payouts" && m === "POST") return admin.createPayout(request, env, user);
    let hit = p.match(/^\/api\/admin\/commissions\/(\d+)$/);
    if (hit && m === "POST") return admin.reviewCommission(request, env, user, Number(hit[1]));
    hit = p.match(/^\/api\/admin\/commissions\/(\d+)\/history$/);
    if (hit && m === "GET") return json({ ok: true, events: await admin.commissionHistory(env, Number(hit[1])) });
    hit = p.match(/^\/api\/admin\/referrals\/(\d+)$/);
    if (hit && m === "POST") return admin.setReferralStatus(request, env, user, Number(hit[1]));
  }

  return err("Not found", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    await ensureSchema(env.DB);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(request, env, url);
      } catch (e) {
        console.error(e);
        return err("Something went wrong on our side.", 500);
      }
    }

    // Everything else is the website. If the visitor came through a referral
    // link, log it and set the referral cookie before serving the page.
    const res = await env.ASSETS.fetch(request);
    if (!url.searchParams.has("ref")) return res;
    const setCookie = await captureLanding(request, env).catch(() => null);
    if (!setCookie) return res;
    const out = new Response(res.body, res);
    out.headers.append("Set-Cookie", setCookie);
    return out;
  },

  // Hourly: move commissions past the refund window from pending to available.
  async scheduled(event, env) {
    await ensureSchema(env.DB);
    await matureCommissions(env);
  },
};
