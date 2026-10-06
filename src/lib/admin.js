// Admin-only views and actions. Access is decided on the server from
// ADMIN_USER_IDS; the admin page itself holds no data or secrets.
import { json, err, nowIso, readJson, config } from "./util.js";
import { logEvent, matureCommissions, balances, NET_REVENUE_SQL } from "./commissions.js";

export async function overview(env) {
  await matureCommissions(env);
  const db = env.DB;
  const [users, clicks, refs, paying, money, byStatus] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM users"),
    db.prepare("SELECT COUNT(*) AS n FROM referral_clicks"),
    db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT referrer_id) AS referrers FROM referrals"),
    db.prepare(
      `SELECT COUNT(DISTINCT c.referred_user_id) AS n FROM commissions c JOIN payments p ON p.id = c.payment_id
       WHERE c.kind = 'commission' AND (${NET_REVENUE_SQL}) > 0`
    ),
    db.prepare(
      `SELECT (SELECT COALESCE(SUM(${NET_REVENUE_SQL}), 0) FROM commissions c JOIN payments p ON p.id = c.payment_id WHERE c.kind = 'commission') AS revenue,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM commissions WHERE status <> 'reversed') AS commissions`
    ),
    db.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM commissions GROUP BY status"),
  ]);
  const referred = refs.results[0].n;
  const payingN = paying.results[0].n;
  return {
    users: users.results[0].n,
    link_visits: clicks.results[0].n,
    referrers: refs.results[0].referrers,
    referred,
    paying: payingN,
    conversion_rate: referred ? payingN / referred : 0,           // referred artists who paid
    visit_to_signup_rate: clicks.results[0].n ? referred / clicks.results[0].n : 0,
    referred_revenue_cents: money.results[0].revenue,
    commissions_cents: money.results[0].commissions,
    by_status: Object.fromEntries(byStatus.results.map((r) => [r.status, { count: r.n, cents: r.cents }])),
    settings: { rate_percent: config(env).rateBps / 100, hold_days: config(env).holdDays, months: config(env).months },
  };
}

export async function referrers(env) {
  const rows = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.ref_code, u.payout_method, u.payout_handle,
       (SELECT COUNT(*) FROM referral_clicks k WHERE k.referrer_id = u.id) AS visits,
       (SELECT COUNT(*) FROM referrals r WHERE r.referrer_id = u.id) AS referred,
       (SELECT COUNT(DISTINCT c.referred_user_id) FROM commissions c JOIN payments p ON p.id = c.payment_id WHERE c.referrer_id = u.id AND c.kind = 'commission' AND (${NET_REVENUE_SQL}) > 0) AS paying,
       (SELECT COALESCE(SUM(${NET_REVENUE_SQL}), 0) FROM commissions c JOIN payments p ON p.id = c.payment_id WHERE c.referrer_id = u.id AND c.kind = 'commission') AS revenue_cents,
       (SELECT COALESCE(SUM(CASE WHEN c.status IN ('pending','held') THEN c.amount_cents END), 0) FROM commissions c WHERE c.referrer_id = u.id) AS pending_cents,
       (SELECT COALESCE(SUM(CASE WHEN c.status = 'available' THEN c.amount_cents END), 0) FROM commissions c WHERE c.referrer_id = u.id) AS available_cents,
       (SELECT COALESCE(SUM(CASE WHEN c.status = 'paid' THEN c.amount_cents END), 0) FROM commissions c WHERE c.referrer_id = u.id) AS paid_cents
     FROM users u
     WHERE EXISTS (SELECT 1 FROM referrals r WHERE r.referrer_id = u.id)
        OR EXISTS (SELECT 1 FROM commissions c WHERE c.referrer_id = u.id)
     ORDER BY revenue_cents DESC, referred DESC LIMIT 500`
  ).all();
  return rows.results;
}

export async function referralList(env) {
  const rows = await env.DB.prepare(
    `SELECT r.id, r.status, r.flags, r.created_at, r.ref_code,
            ref.email AS referrer_email, ref.display_name AS referrer_name,
            u.email AS referred_email, u.display_name AS referred_name, u.plan,
            (SELECT COALESCE(SUM(${NET_REVENUE_SQL}), 0) FROM commissions c JOIN payments p ON p.id = c.payment_id WHERE c.referred_user_id = u.id AND c.kind = 'commission') AS revenue_cents,
            (SELECT COALESCE(SUM(c.amount_cents), 0) FROM commissions c WHERE c.referred_user_id = u.id AND c.status <> 'reversed') AS commission_cents
     FROM referrals r JOIN users ref ON ref.id = r.referrer_id JOIN users u ON u.id = r.referred_user_id
     ORDER BY r.created_at DESC LIMIT 1000`
  ).all();
  return rows.results.map((r) => ({ ...r, flags: JSON.parse(r.flags || "[]") }));
}

export async function commissionList(env, status) {
  const where = status ? "WHERE c.status = ?1" : "";
  const stmt = env.DB.prepare(
    `SELECT c.*, ref.email AS referrer_email, u.email AS referred_email,
            p.stripe_ref, p.amount_cents AS payment_cents, p.refunded_cents, p.status AS payment_status
     FROM commissions c JOIN users ref ON ref.id = c.referrer_id
     LEFT JOIN users u ON u.id = c.referred_user_id LEFT JOIN payments p ON p.id = c.payment_id
     ${where} ORDER BY c.created_at DESC LIMIT 1000`
  );
  const rows = await (status ? stmt.bind(status) : stmt).all();
  return rows.results.map((r) => ({ ...r, flags: JSON.parse(r.flags || "[]") }));
}

// Manual review: approve, hold, reverse, or change the amount. Every change is logged.
export async function reviewCommission(request, env, admin, commissionId) {
  const body = await readJson(request);
  const c = await env.DB.prepare("SELECT * FROM commissions WHERE id = ?1").bind(commissionId).first();
  if (!c) return err("Commission not found.", 404);
  if (c.status === "paid") return err("This commission was already paid. Add a negative adjustment instead.", 409);
  // Hard rule: no commission on refunded, charged-back or fraud-flagged money.
  if (["approve", "restore"].includes(body.action) && c.payment_id) {
    const p = await env.DB.prepare("SELECT status FROM payments WHERE id = ?1").bind(c.payment_id).first();
    if (p && ["refunded", "disputed", "fraud_warning"].includes(p.status)) {
      return err(`The payment behind this commission is ${p.status.replace("_", " ")}, so it can't be paid.`, 409);
    }
  }
  const actor = `admin:${admin.email}`;
  const note = String(body.note || "").slice(0, 300) || null;
  const now = nowIso();
  let to = c.status;
  let amount = c.amount_cents;

  switch (body.action) {
    case "approve": // cleared for payout (skips the rest of the waiting period)
      to = "available"; break;
    case "hold":
      to = "held"; break;
    case "reverse":
      to = "reversed"; break;
    case "restore":
      to = c.available_at && c.available_at > now ? "pending" : "available"; break;
    case "set_amount": {
      const v = Number(body.amount_cents);
      if (!Number.isInteger(v)) return err("amount_cents must be a whole number of cents.");
      amount = v; break;
    }
    default:
      return err("Unknown action.");
  }
  await env.DB.prepare("UPDATE commissions SET status = ?1, amount_cents = ?2, note = COALESCE(?3, note), updated_at = ?4 WHERE id = ?5")
    .bind(to, amount, note, now, c.id).run();
  await logEvent(env.DB, c.id, actor, body.action, c.status, to, amount - c.amount_cents || null, note);
  return json({ ok: true });
}

// A one-off credit or debit, e.g. a bonus or correcting a mistake.
export async function createAdjustment(request, env, admin) {
  const body = await readJson(request);
  const amount = Number(body.amount_cents);
  if (!Number.isInteger(amount) || amount === 0) return err("amount_cents must be a non-zero whole number.");
  const referrer = await env.DB.prepare("SELECT id FROM users WHERE id = ?1 OR email = ?1 OR ref_code = ?1").bind(String(body.referrer || "")).first();
  if (!referrer) return err("Referrer not found.", 404);
  const note = String(body.note || "").slice(0, 300) || "manual adjustment";
  const now = nowIso();
  const res = await env.DB.prepare(
    `INSERT INTO commissions (referrer_id, kind, amount_cents, status, available_at, note, created_at, updated_at)
     VALUES (?1, 'adjustment', ?2, 'available', ?3, ?4, ?3, ?3)`
  ).bind(referrer.id, amount, now, note).run();
  await logEvent(env.DB, res.meta.last_row_id, `admin:${admin.email}`, "adjustment", null, "available", amount, note);
  return json({ ok: true, id: res.meta.last_row_id });
}

// Record that you sent money (PayPal, Cash App, USDC...). Marks every available
// row for that artist as paid, netting any clawbacks.
export async function createPayout(request, env, admin) {
  const body = await readJson(request);
  const referrer = await env.DB.prepare("SELECT * FROM users WHERE id = ?1 OR email = ?1 OR ref_code = ?1").bind(String(body.referrer || "")).first();
  if (!referrer) return err("Referrer not found.", 404);
  await matureCommissions(env);
  const b = await balances(env.DB, referrer.id);
  if (b.available_cents <= 0) return err("Nothing available to pay out.", 409);
  const now = nowIso();
  const res = await env.DB.prepare(
    "INSERT INTO payouts (referrer_id, amount_cents, method, reference, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  ).bind(referrer.id, b.available_cents, String(body.method || referrer.payout_method || ""), String(body.reference || "").slice(0, 200),
         admin.email, now).run();
  const payoutId = res.meta.last_row_id;
  const rows = await env.DB.prepare("SELECT id, amount_cents FROM commissions WHERE referrer_id = ?1 AND status = 'available'").bind(referrer.id).all();
  await env.DB.prepare("UPDATE commissions SET status = 'paid', payout_id = ?1, updated_at = ?2 WHERE referrer_id = ?3 AND status = 'available'")
    .bind(payoutId, now, referrer.id).run();
  for (const r of rows.results) await logEvent(env.DB, r.id, `admin:${admin.email}`, "paid", "available", "paid", r.amount_cents, `payout #${payoutId}`);
  return json({ ok: true, payout_id: payoutId, amount_cents: b.available_cents });
}

export async function setReferralStatus(request, env, admin, referralId) {
  const body = await readJson(request);
  if (!["active", "blocked"].includes(body.status)) return err("status must be active or blocked.");
  const r = await env.DB.prepare("UPDATE referrals SET status = ?1 WHERE id = ?2").bind(body.status, referralId).run();
  if (!r.meta.changes) return err("Referral not found.", 404);
  return json({ ok: true });
}

export async function commissionHistory(env, commissionId) {
  const rows = await env.DB.prepare("SELECT * FROM commission_events WHERE commission_id = ?1 ORDER BY id").bind(commissionId).all();
  return rows.results;
}
