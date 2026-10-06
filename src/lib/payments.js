// Stripe -> payments -> commissions.
//
// Stripe tells us about money through webhooks. We only trust events with a
// valid signature, process each event id once, and store every payment so
// commissions always point back at a real Stripe invoice or checkout.
import { json, err, nowIso, hmacHex, safeEqual, canonicalEmail } from "./util.js";
import { createCommissionForPayment, syncCommissionToPayment, restoreAfterDispute, recheckCardFlags } from "./commissions.js";

const TOLERANCE_SECONDS = 300;

async function verifySignature(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = header.split(",").filter((p) => p.trim().startsWith("v1=")).map((p) => p.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > TOLERANCE_SECONDS) return false;
  const expected = await hmacHex(secret, `${t}.${payload}`);
  return sigs.some((s) => safeEqual(s, expected));
}

const id = (v) => (typeof v === "string" ? v : v?.id || null);
const iso = (unix) => (unix ? new Date(unix * 1000).toISOString() : nowIso());

// Optional Stripe API read, used only when the webhook payload leaves something out.
async function stripeGet(env, path) {
  if (!env.STRIPE_SECRET_KEY) return null;
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
  return r.ok ? r.json() : null;
}

async function findUser(db, { userId, customerId, email }) {
  if (userId) {
    const u = await db.prepare("SELECT * FROM users WHERE id = ?1").bind(userId).first();
    if (u) return u;
  }
  if (customerId) {
    const u = await db.prepare("SELECT * FROM users WHERE stripe_customer_id = ?1").bind(customerId).first();
    if (u) return u;
  }
  if (email) {
    const e = String(email).toLowerCase();
    const u = await db.prepare("SELECT * FROM users WHERE email = ?1").bind(e).first()
      || await db.prepare("SELECT * FROM users WHERE email_canonical = ?1 ORDER BY created_at LIMIT 1").bind(canonicalEmail(e)).first();
    if (u) return u;
  }
  return null;
}

async function linkCustomer(db, user, customerId) {
  if (!user || !customerId || user.stripe_customer_id) return;
  await db.prepare("UPDATE users SET stripe_customer_id = ?1 WHERE id = ?2 AND stripe_customer_id IS NULL").bind(customerId, user.id).run();
}

// Insert (or fetch the existing) payment row, then try to create its commission.
async function recordPayment(env, p) {
  const db = env.DB;
  const now = nowIso();
  if (p.payment_intent_id && !p.card_fingerprint) {
    const ch = await db.prepare("SELECT * FROM stripe_charges WHERE payment_intent_id = ?1").bind(p.payment_intent_id).first();
    if (ch) { p.card_fingerprint = ch.card_fingerprint; p.charge_id = p.charge_id || ch.charge_id; }
  }
  await db.prepare(
    `INSERT INTO payments (stripe_ref, user_id, stripe_customer_id, stripe_subscription_id, stripe_payment_intent_id,
                           stripe_charge_id, customer_email, product, amount_cents, tax_cents, currency, status,
                           card_fingerprint, paid_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'paid', ?12, ?13, ?14)
     ON CONFLICT(stripe_ref) DO NOTHING`
  ).bind(p.stripe_ref, p.user_id, p.customer_id, p.subscription_id, p.payment_intent_id, p.charge_id, p.email,
         p.product || "pro", p.amount_cents, p.tax_cents || 0, p.currency || "usd", p.card_fingerprint || null,
         p.paid_at, now).run();
  const payment = await db.prepare("SELECT * FROM payments WHERE stripe_ref = ?1").bind(p.stripe_ref).first();
  if (payment.user_id) {
    await db.prepare("UPDATE users SET plan = 'pro' WHERE id = ?1").bind(payment.user_id).run();
  }
  const commission = await createCommissionForPayment(env, payment);
  return { payment_id: payment.id, commission };
}

// Payments that came in before we knew which account they belonged to.
// At signup (earnCommission = false) these were paid before the account, and so
// before any referral, existed: they are linked but never earn commission.
export async function claimPaymentsForUser(env, user, { earnCommission = true } = {}) {
  if (!user) return;
  const db = env.DB;
  const rows = await db.prepare(
    `SELECT * FROM payments WHERE user_id IS NULL AND (
       (stripe_customer_id IS NOT NULL AND stripe_customer_id = ?1) OR lower(customer_email) = ?2)`
  ).bind(user.stripe_customer_id || "", user.email).all();
  for (const p of rows.results) {
    await db.prepare("UPDATE payments SET user_id = ?1 WHERE id = ?2 AND user_id IS NULL").bind(user.id, p.id).run();
    if (p.stripe_customer_id) await linkCustomer(db, user, p.stripe_customer_id);
    await db.prepare("UPDATE users SET plan = 'pro' WHERE id = ?1").bind(user.id).run();
    if (earnCommission) await createCommissionForPayment(env, { ...p, user_id: user.id });
  }
}

async function findPayment(db, { chargeId, paymentIntentId, invoiceId }) {
  if (chargeId) {
    const p = await db.prepare("SELECT * FROM payments WHERE stripe_charge_id = ?1").bind(chargeId).first();
    if (p) return p;
  }
  if (paymentIntentId) {
    const p = await db.prepare("SELECT * FROM payments WHERE stripe_payment_intent_id = ?1").bind(paymentIntentId).first();
    if (p) return p;
  }
  if (invoiceId) return db.prepare("SELECT * FROM payments WHERE stripe_ref = ?1").bind(invoiceId).first();
  return null;
}

// ---- event handlers -------------------------------------------------------

async function onCheckoutCompleted(env, s) {
  const db = env.DB;
  const customerId = id(s.customer);
  const email = s.customer_details?.email || s.customer_email;
  // The site passes the logged-in artist's id as client_reference_id.
  const user = await findUser(db, { userId: s.client_reference_id, customerId, email });
  await linkCustomer(db, user, customerId);

  if (s.mode === "payment" && s.payment_status === "paid" && s.amount_total > 0) {
    return recordPayment(env, {
      stripe_ref: s.id, user_id: user?.id || null, customer_id: customerId, subscription_id: null,
      payment_intent_id: id(s.payment_intent), charge_id: null, email,
      product: s.metadata?.product || "pro", amount_cents: s.amount_total,
      tax_cents: s.total_details?.amount_tax || 0, currency: s.currency, paid_at: iso(s.created),
    });
  }
  // Subscriptions are recorded from invoice.paid. If that invoice arrived first,
  // it's waiting unlinked; claim it now that we know the account.
  if (user) await claimPaymentsForUser(env, { ...user, stripe_customer_id: user.stripe_customer_id || customerId });
  return { linked: !!user };
}

async function onInvoicePaid(env, inv) {
  const db = env.DB;
  if (!inv.amount_paid || inv.amount_paid <= 0) return { skipped: "zero_amount" }; // trials, 100% coupons
  const customerId = id(inv.customer);
  // Field locations differ between Stripe API versions; check both.
  const subscriptionId = id(inv.subscription) || id(inv.parent?.subscription_details?.subscription);
  const metaUserId = inv.subscription_details?.metadata?.user_id || inv.parent?.subscription_details?.metadata?.user_id || inv.metadata?.user_id;
  let paymentIntentId = id(inv.payment_intent) || id(inv.payments?.data?.[0]?.payment?.payment_intent);
  let chargeId = id(inv.charge) || id(inv.payments?.data?.[0]?.payment?.charge);
  if (!paymentIntentId && !chargeId) {
    const ip = await stripeGet(env, `invoice_payments?invoice=${encodeURIComponent(inv.id)}&limit=1`);
    paymentIntentId = id(ip?.data?.[0]?.payment?.payment_intent);
    chargeId = id(ip?.data?.[0]?.payment?.charge);
  }
  const tax = typeof inv.tax === "number" ? inv.tax
    : (inv.total_taxes || []).reduce((s, t) => s + (t.amount || 0), 0);
  const user = await findUser(db, { userId: metaUserId, customerId, email: inv.customer_email });
  await linkCustomer(db, user, customerId);
  return recordPayment(env, {
    stripe_ref: inv.id, user_id: user?.id || null, customer_id: customerId, subscription_id: subscriptionId,
    payment_intent_id: paymentIntentId, charge_id: chargeId, email: inv.customer_email,
    product: "pro", amount_cents: inv.amount_paid, tax_cents: tax, currency: inv.currency,
    paid_at: iso(inv.status_transitions?.paid_at || inv.created),
  });
}

async function onChargeSucceeded(env, ch) {
  const db = env.DB;
  const fp = ch.payment_method_details?.card?.fingerprint || null;
  await db.prepare(
    `INSERT INTO stripe_charges (charge_id, payment_intent_id, invoice_id, card_fingerprint, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(charge_id) DO NOTHING`
  ).bind(ch.id, id(ch.payment_intent), id(ch.invoice), fp, nowIso()).run();
  const payment = await findPayment(db, { chargeId: ch.id, paymentIntentId: id(ch.payment_intent), invoiceId: id(ch.invoice) });
  if (payment) {
    await db.prepare("UPDATE payments SET stripe_charge_id = COALESCE(stripe_charge_id, ?1), card_fingerprint = COALESCE(card_fingerprint, ?2) WHERE id = ?3")
      .bind(ch.id, fp, payment.id).run();
    if (fp && !payment.card_fingerprint) await recheckCardFlags(env, { ...payment, card_fingerprint: fp });
  }
  return { stored: true };
}

async function onChargeRefunded(env, ch) {
  const db = env.DB;
  const payment = await findPayment(db, { chargeId: ch.id, paymentIntentId: id(ch.payment_intent), invoiceId: id(ch.invoice) });
  if (!payment) return { skipped: "unknown_payment" };
  const refunded = Math.min(payment.amount_cents, ch.amount_refunded || 0);
  const status = refunded >= payment.amount_cents ? "refunded" : refunded > 0 ? "partially_refunded" : payment.status;
  await db.prepare("UPDATE payments SET refunded_cents = ?1, status = ?2, stripe_charge_id = COALESCE(stripe_charge_id, ?3) WHERE id = ?4")
    .bind(refunded, status, ch.id, payment.id).run();
  const updated = { ...payment, refunded_cents: refunded, status };
  return syncCommissionToPayment(env, updated, status === "refunded" ? "payment refunded" : `partial refund of ${refunded} cents`);
}

async function onDispute(env, d, closed) {
  const db = env.DB;
  const payment = await findPayment(db, { chargeId: id(d.charge), paymentIntentId: id(d.payment_intent) });
  if (!payment) return { skipped: "unknown_payment" };
  if (!closed) {
    await db.prepare("UPDATE payments SET status = 'disputed' WHERE id = ?1").bind(payment.id).run();
    return syncCommissionToPayment(env, { ...payment, status: "disputed" }, "chargeback opened");
  }
  if (d.status === "won") {
    await db.prepare("UPDATE payments SET status = 'paid' WHERE id = ?1").bind(payment.id).run();
    await restoreAfterDispute(env, { ...payment, status: "paid" });
    return { restored: true };
  }
  return { kept_reversed: true };
}

async function onFraudWarning(env, w) {
  const db = env.DB;
  const payment = await findPayment(db, { chargeId: id(w.charge), paymentIntentId: id(w.payment_intent) });
  if (!payment) return { skipped: "unknown_payment" };
  await db.prepare("UPDATE payments SET status = 'fraud_warning' WHERE id = ?1").bind(payment.id).run();
  return syncCommissionToPayment(env, { ...payment, status: "fraud_warning" }, "card issuer reported fraud");
}

const HANDLERS = {
  "checkout.session.completed": (env, o) => onCheckoutCompleted(env, o),
  "checkout.session.async_payment_succeeded": (env, o) => onCheckoutCompleted(env, { ...o, payment_status: "paid" }),
  "invoice.paid": (env, o) => onInvoicePaid(env, o),
  "charge.succeeded": (env, o) => onChargeSucceeded(env, o),
  "charge.refunded": (env, o) => onChargeRefunded(env, o),
  "charge.dispute.created": (env, o) => onDispute(env, o, false),
  "charge.dispute.closed": (env, o) => onDispute(env, o, true),
  "radar.early_fraud_warning.created": (env, o) => onFraudWarning(env, o),
};

export async function stripeWebhook(request, env) {
  const payload = await request.text();
  if (!(await verifySignature(payload, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET))) {
    return err("bad signature", 400);
  }
  const event = JSON.parse(payload);
  const handler = HANDLERS[event.type];
  if (!handler) return json({ received: true, ignored: event.type });

  // Idempotency: claim the event id first; a duplicate delivery stops here.
  const claim = await env.DB.prepare("INSERT INTO stripe_events (id, type, received_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO NOTHING")
    .bind(event.id, event.type, nowIso()).run();
  if (!claim.meta.changes) return json({ received: true, duplicate: true });

  try {
    const result = await handler(env, event.data.object);
    return json({ received: true, result });
  } catch (e) {
    // Release the claim so Stripe's retry gets processed.
    await env.DB.prepare("DELETE FROM stripe_events WHERE id = ?1").bind(event.id).run();
    console.error("stripe webhook failed", event.type, e);
    return err("processing failed", 500);
  }
}
