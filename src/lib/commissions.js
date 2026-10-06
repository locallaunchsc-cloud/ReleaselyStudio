// The commission ledger. Every number on the referral dashboard comes from
// these rows; nothing is computed in the browser.
//
// Lifecycle of a commission:
//   pending   -> payment received, inside the refund window (COMMISSION_HOLD_DAYS)
//   held      -> a risk flag needs an admin to look at it before it can be paid
//   available -> refund window passed, ready to pay out
//   paid      -> included in a payout
//   reversed  -> payment was refunded, disputed, or marked fraudulent
import { nowIso, addDays, config } from "./util.js";

const OPEN = ["pending", "held", "available"];

// Revenue a referral really brought in: what the artist paid, minus tax and
// refunds; zero for chargebacks and fraud. Rows an admin reversed (judged not a
// genuine referral) don't count. Use with commissions c JOIN payments p.
export const NET_REVENUE_SQL = `CASE
  WHEN c.status = 'reversed' AND p.status IN ('paid', 'partially_refunded') THEN 0
  WHEN p.status IN ('disputed', 'fraud_warning', 'refunded') THEN 0
  ELSE p.amount_cents - p.tax_cents - p.refunded_cents END`;

export async function logEvent(db, commissionId, actor, action, fromStatus, toStatus, amountCents, note) {
  await db.prepare(
    `INSERT INTO commission_events (commission_id, actor, action, from_status, to_status, amount_cents, note, at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(commissionId, actor, action, fromStatus ?? null, toStatus ?? null, amountCents ?? null, note ?? null, nowIso()).run();
}

// Commission base = what the artist actually paid, minus tax, minus refunds.
function baseCents(payment) {
  return Math.max(0, payment.amount_cents - (payment.tax_cents || 0) - (payment.refunded_cents || 0));
}

function rateOf(base, bps) {
  return Math.floor((base * bps) / 10000); // round down to the cent, never overpay
}

// Called whenever a payment is linked to an artist. Creates at most one
// commission per payment (enforced by a unique index too).
export async function createCommissionForPayment(env, payment) {
  const db = env.DB;
  const cfg = config(env);
  if (!payment?.user_id || payment.status !== "paid") return { created: false, reason: "not_paid_or_unlinked" };

  const ref = await db.prepare("SELECT * FROM referrals WHERE referred_user_id = ?1").bind(payment.user_id).first();
  if (!ref) return { created: false, reason: "not_referred" };
  if (ref.status !== "active") return { created: false, reason: "referral_blocked" };
  // Only payments made after the artist was referred earn commission.
  // Stripe timestamps are whole seconds; compare at that precision.
  if (payment.paid_at.slice(0, 19) < ref.created_at.slice(0, 19)) return { created: false, reason: "paid_before_referral" };
  if (cfg.months > 0 && payment.paid_at > addDays(ref.created_at, cfg.months * 30.44)) {
    return { created: false, reason: "past_commission_window" };
  }

  const existing = await db.prepare("SELECT id FROM commissions WHERE payment_id = ?1 AND kind = 'commission'").bind(payment.id).first();
  if (existing) return { created: false, reason: "exists", id: existing.id };

  const base = baseCents(payment);
  const amount = rateOf(base, cfg.rateBps);
  if (amount <= 0) return { created: false, reason: "zero_amount" };

  // Risk signals: anything from signup, plus the same card on both accounts.
  const flags = JSON.parse(ref.flags || "[]");
  if (payment.card_fingerprint) {
    const sameCard = await db.prepare(
      "SELECT 1 FROM payments WHERE user_id = ?1 AND card_fingerprint = ?2 LIMIT 1"
    ).bind(ref.referrer_id, payment.card_fingerprint).first();
    if (sameCard) flags.push("same_card_as_referrer");
    const reused = await db.prepare(
      `SELECT 1 FROM payments p JOIN referrals r ON r.referred_user_id = p.user_id
       WHERE r.referrer_id = ?1 AND p.user_id <> ?2 AND p.card_fingerprint = ?3 LIMIT 1`
    ).bind(ref.referrer_id, payment.user_id, payment.card_fingerprint).first();
    if (reused) flags.push("card_used_by_another_referral");
  }
  const status = flags.length ? "held" : "pending";
  const now = nowIso();

  const res = await db.prepare(
    `INSERT INTO commissions (referrer_id, referred_user_id, payment_id, kind, base_cents, rate_bps, amount_cents,
                              currency, status, available_at, flags, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'commission', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
     ON CONFLICT DO NOTHING`
  ).bind(ref.referrer_id, payment.user_id, payment.id, base, cfg.rateBps, amount, payment.currency,
         status, addDays(payment.paid_at, cfg.holdDays), JSON.stringify([...new Set(flags)]), now).run();
  if (!res.meta.changes) return { created: false, reason: "exists" };
  const id = res.meta.last_row_id;
  await logEvent(db, id, "system", "created", null, status, amount,
    flags.length ? `held for review: ${flags.join(", ")}` : `${cfg.rateBps / 100}% of ${base} cents`);
  return { created: true, id, amount_cents: amount, status };
}

// A card fingerprint can arrive after the commission was created. Re-check it.
export async function recheckCardFlags(env, payment) {
  const c = await env.DB.prepare("SELECT * FROM commissions WHERE payment_id = ?1 AND kind = 'commission'").bind(payment.id).first();
  if (!c || !payment.card_fingerprint || !["pending", "available"].includes(c.status)) return;
  const hit = await env.DB.prepare(
    `SELECT 1 FROM payments WHERE card_fingerprint = ?1 AND id <> ?2 AND (user_id = ?3 OR user_id IN
       (SELECT referred_user_id FROM referrals WHERE referrer_id = ?3 AND referred_user_id <> ?4)) LIMIT 1`
  ).bind(payment.card_fingerprint, payment.id, c.referrer_id, payment.user_id).first();
  if (!hit) return;
  const flags = [...new Set([...JSON.parse(c.flags || "[]"), "card_shared_with_referrer_network"])];
  await env.DB.prepare("UPDATE commissions SET status = 'held', flags = ?1, updated_at = ?2 WHERE id = ?3")
    .bind(JSON.stringify(flags), nowIso(), c.id).run();
  await logEvent(env.DB, c.id, "system", "held", c.status, "held", null, "same card seen in referrer's network");
}

// After a refund, dispute or fraud warning, bring the commission in line with
// what the artist actually ended up paying.
export async function syncCommissionToPayment(env, payment, reason) {
  const db = env.DB;
  const c = await db.prepare("SELECT * FROM commissions WHERE payment_id = ?1 AND kind = 'commission'").bind(payment.id).first();
  if (!c) return { changed: false };
  const now = nowIso();

  const voidAll = ["refunded", "disputed", "fraud_warning"].includes(payment.status);
  const targetAmount = voidAll ? 0 : rateOf(baseCents(payment), c.rate_bps);

  if (OPEN.includes(c.status)) {
    if (targetAmount <= 0) {
      await db.prepare("UPDATE commissions SET status = 'reversed', note = ?1, updated_at = ?2 WHERE id = ?3").bind(reason, now, c.id).run();
      await logEvent(db, c.id, "system", "reversed", c.status, "reversed", -c.amount_cents, reason);
      return { changed: true, action: "reversed" };
    }
    if (targetAmount < c.amount_cents) {
      await db.prepare("UPDATE commissions SET amount_cents = ?1, base_cents = ?2, note = ?3, updated_at = ?4 WHERE id = ?5")
        .bind(targetAmount, baseCents(payment), reason, now, c.id).run();
      await logEvent(db, c.id, "system", "reduced", c.status, c.status, targetAmount - c.amount_cents, reason);
      return { changed: true, action: "reduced" };
    }
    return { changed: false };
  }

  if (c.status === "paid") {
    // Already paid out: record a negative entry that comes off the next payout.
    const clawed = await db.prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS s FROM commissions WHERE payment_id = ?1 AND kind = 'clawback'"
    ).bind(payment.id).first();
    const owedBack = c.amount_cents + clawed.s - targetAmount; // clawbacks are negative
    if (owedBack <= 0) return { changed: false };
    const res = await db.prepare(
      `INSERT INTO commissions (referrer_id, referred_user_id, payment_id, kind, base_cents, rate_bps, amount_cents,
                                currency, status, available_at, note, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'clawback', 0, ?4, ?5, ?6, 'available', ?7, ?8, ?7, ?7)`
    ).bind(c.referrer_id, c.referred_user_id, payment.id, c.rate_bps, -owedBack, c.currency, now, reason).run();
    await logEvent(db, res.meta.last_row_id, "system", "clawback", null, "available", -owedBack, reason);
    return { changed: true, action: "clawback" };
  }

  return { changed: false };
}

// A dispute the artist won: bring the commission back, but make an admin approve it.
export async function restoreAfterDispute(env, payment) {
  const c = await env.DB.prepare(
    "SELECT * FROM commissions WHERE payment_id = ?1 AND kind = 'commission' AND status = 'reversed'"
  ).bind(payment.id).first();
  if (!c) return;
  await env.DB.prepare("UPDATE commissions SET status = 'held', note = 'dispute won; review before paying', updated_at = ?1 WHERE id = ?2")
    .bind(nowIso(), c.id).run();
  await logEvent(env.DB, c.id, "system", "restored", "reversed", "held", c.amount_cents, "dispute closed in our favor");
}

// pending -> available once the refund window has passed. Runs on every
// dashboard/admin read and hourly from the cron trigger.
export async function matureCommissions(env) {
  const now = nowIso();
  const due = await env.DB.prepare(
    "SELECT id, amount_cents FROM commissions WHERE status = 'pending' AND available_at <= ?1"
  ).bind(now).all();
  if (!due.results.length) return 0;
  await env.DB.prepare("UPDATE commissions SET status = 'available', updated_at = ?1 WHERE status = 'pending' AND available_at <= ?1").bind(now).run();
  for (const r of due.results) await logEvent(env.DB, r.id, "system", "matured", "pending", "available", r.amount_cents, null);
  return due.results.length;
}

export async function balances(db, referrerId) {
  const rows = await db.prepare(
    `SELECT status, kind, COALESCE(SUM(amount_cents), 0) AS cents FROM commissions
     WHERE referrer_id = ?1 GROUP BY status, kind`
  ).bind(referrerId).all();
  const b = { pending_cents: 0, available_cents: 0, paid_cents: 0, reversed_cents: 0, earned_cents: 0, owed_cents: 0 };
  for (const r of rows.results) {
    if (r.status === "pending" || r.status === "held") b.pending_cents += r.cents;
    if (r.status === "available") b.available_cents += r.cents;
    if (r.status === "paid") b.paid_cents += r.cents;
    if (r.status === "reversed") b.reversed_cents += r.cents;
  }
  b.earned_cents = b.pending_cents + b.available_cents + b.paid_cents; // net of clawbacks
  b.owed_cents = Math.max(0, -b.available_cents);     // refunds after a payout, taken from future earnings
  b.available_cents = Math.max(0, b.available_cents);
  return b;
}
