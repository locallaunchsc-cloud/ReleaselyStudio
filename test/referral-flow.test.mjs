// End-to-end test for referrals + commissions against a running dev server.
//   npx wrangler dev --local --var STRIPE_WEBHOOK_SECRET:whsec_test \
//     --var DEV_ADMIN_EMAILS:admin@releasely.test --var DEV_INSECURE_COOKIES:1
//   node test/referral-flow.test.mjs
import crypto from "node:crypto";

const BASE = process.env.BASE || "http://localhost:8787";
const SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_test";
const run = Date.now().toString(36);
let passed = 0, failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, extra !== undefined ? JSON.stringify(extra) : ""); }
}

// A tiny browser: keeps its own cookies.
function client(ip) {
  const jar = {};
  return async function req(path, { method = "GET", body, headers = {} } = {}) {
    const h = { ...headers, "CF-Connecting-IP": ip };
    if (Object.keys(jar).length) h.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) h["Content-Type"] = "application/json";
    const r = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
    for (const c of r.headers.getSetCookie?.() || []) {
      const [pair, ...attrs] = c.split(";");
      const [k, v] = pair.split("=");
      if (attrs.some((a) => a.trim() === "Max-Age=0")) delete jar[k.trim()]; else jar[k.trim()] = v;
    }
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, jar };
  };
}

let evN = 0;
async function stripe(type, object) {
  const payload = JSON.stringify({ id: `evt_${run}_${++evN}`, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", SECRET).update(`${t}.${payload}`).digest("hex");
  const r = await fetch(BASE + "/api/stripe/webhook", { method: "POST", headers: { "Stripe-Signature": `t=${t},v1=${sig}` }, body: payload });
  return { status: r.status, data: await r.json(), payload };
}
async function replay(payload) {
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", SECRET).update(`${t}.${payload}`).digest("hex");
  const r = await fetch(BASE + "/api/stripe/webhook", { method: "POST", headers: { "Stripe-Signature": `t=${t},v1=${sig}` }, body: payload });
  return r.json();
}

const invoice = (id, customer, cents, email, extra = {}) => ({
  id, object: "invoice", customer, customer_email: email, amount_paid: cents, currency: "usd", tax: 0,
  subscription: `sub_${run}_${customer}`, payment_intent: `pi_${id}`, charge: `ch_${id}`,
  status_transitions: { paid_at: Math.floor(Date.now() / 1000) }, created: Math.floor(Date.now() / 1000), ...extra,
});

const dollars = (c) => `$${(c / 100).toFixed(2)}`;

console.log(`\nReleasely referral flow test (${BASE})\n`);

// ---------------------------------------------------------------------------
console.log("1. Artist A signs up and gets a referral link");
const A = client("10.0.0.1");
const aEmail = `artist.a.${run}@example.com`;
let r = await A("/api/auth/signup", { method: "POST", body: { email: aEmail, password: "password-a-123", name: "Artist A", device: "aaaaaaaaaaaaaaaa" } });
check("signup works", r.status === 201, r.data);
const aCode = r.data.user?.ref_code;
check(`has a referral code (${aCode})`, /^[A-Z0-9]{4,20}$/.test(aCode || ""));
r = await A("/api/referrals/me");
check(`dashboard returns referral link (${r.data.link})`, r.data.link?.endsWith(`/?ref=${aCode}`));
check("starts with zero referrals and $0", r.data.stats.referred === 0 && r.data.stats.earned_cents === 0);

// ---------------------------------------------------------------------------
console.log("\n2. Artist B opens A's link and signs up");
const B = client("10.0.0.2");
r = await B(`/?ref=${aCode.toLowerCase()}`);
check("landing page still loads", r.status === 200 && String(r.data).includes("Releasely"));
check("server set the rl_ref cookie", r.jar.rl_ref === aCode, r.jar);
r = await B("/api/referrals/pending");
check("signup form can show who invited them", r.data.referrer?.code === aCode);
const bEmail = `artist.b.${run}@example.com`;
r = await B("/api/auth/signup", { method: "POST", body: { email: bEmail, password: "password-b-123", name: "Artist B", device: "bbbbbbbbbbbbbbbb" } });
check("B signs up", r.status === 201, r.data);
check("B attributed to A on the server", r.data.referral?.attributed === true && r.data.referral.referrer_code === aCode, r.data.referral);
check("no risk flags for a normal signup", r.data.referral?.flags?.length === 0, r.data.referral);
check("referral cookie cleared after signup", !r.jar.rl_ref);
const bId = r.data.user.id;
r = await A("/api/referrals/me");
check("A sees 1 link visit and 1 referred artist", r.data.stats.link_visits === 1 && r.data.stats.referred === 1, r.data.stats);

// ---------------------------------------------------------------------------
console.log("\n3. B buys Pro for $50 (Stripe checkout + first invoice)");
const cusB = `cus_${run}_B`;
r = await stripe("checkout.session.completed", { id: `cs_${run}_B`, object: "checkout.session", mode: "subscription", client_reference_id: bId, customer: cusB, customer_details: { email: bEmail }, payment_status: "paid", amount_total: 5000, created: Math.floor(Date.now() / 1000) });
check("checkout webhook accepted", r.status === 200, r.data);
await stripe("charge.succeeded", { id: `ch_in_${run}_1`, payment_intent: `pi_in_${run}_1`, payment_method_details: { card: { fingerprint: "fp_B" } } });
const inv1 = await stripe("invoice.paid", invoice(`in_${run}_1`, cusB, 5000, bEmail));
check("invoice webhook accepted", inv1.status === 200, inv1.data);
check("commission created: $10.00, pending", inv1.data.result?.commission?.amount_cents === 1000 && inv1.data.result.commission.status === "pending", inv1.data.result);
r = await A("/api/referrals/me");
let s = r.data.stats;
check(`A: 1 paying, revenue ${dollars(s.revenue_cents)}, pending ${dollars(s.pending_cents)}`, s.paying === 1 && s.revenue_cents === 5000 && s.pending_cents === 1000 && s.earned_cents === 1000, s);

const dup = await replay(inv1.payload);
check("same Stripe event twice is ignored", dup.duplicate === true, dup);
const sameInvoiceNewEvent = await stripe("invoice.paid", invoice(`in_${run}_1`, cusB, 5000, bEmail));
check("same invoice in a new event creates no second commission", sameInvoiceNewEvent.data.result?.commission?.created === false, sameInvoiceNewEvent.data);
const bad = await fetch(BASE + "/api/stripe/webhook", { method: "POST", headers: { "Stripe-Signature": "t=1,v1=deadbeef" }, body: "{}" });
check("unsigned / forged webhook rejected", bad.status === 400);

// ---------------------------------------------------------------------------
console.log("\n4. B renews next month ($50)");
const inv2 = await stripe("invoice.paid", invoice(`in_${run}_2`, cusB, 5000, bEmail));
check("second $10.00 commission created", inv2.data.result?.commission?.amount_cents === 1000, inv2.data.result);
r = await A("/api/referrals/me");
s = r.data.stats;
check(`A: revenue ${dollars(s.revenue_cents)}, earned ${dollars(s.earned_cents)}`, s.revenue_cents === 10000 && s.earned_cents === 2000 && s.paying === 1, s);
check("A's history shows B with $100 revenue / $20 commission",
  r.data.referrals[0]?.revenue_cents === 10000 && r.data.referrals[0]?.commission_cents === 2000, r.data.referrals);
check("A's ledger has 2 commission rows", r.data.commissions.filter((c) => c.kind === "commission").length === 2);

// ---------------------------------------------------------------------------
console.log("\n5. Refunds and chargebacks");
let ref = await stripe("charge.refunded", { id: `ch_in_${run}_2`, payment_intent: `pi_in_${run}_2`, amount_refunded: 5000 });
check("full refund of month 2 reverses its unpaid commission", ref.data.result?.action === "reversed", ref.data);
r = await A("/api/referrals/me");
check("A back to $10.00 earned / $50 revenue", r.data.stats.earned_cents === 1000 && r.data.stats.revenue_cents === 5000, r.data.stats);

const inv3 = await stripe("invoice.paid", invoice(`in_${run}_3`, cusB, 5000, bEmail));
ref = await stripe("charge.refunded", { id: `ch_in_${run}_3`, payment_intent: `pi_in_${run}_3`, amount_refunded: 2500 });
check("half refund cuts that commission to $5.00", ref.data.result?.action === "reduced", ref.data);
const inv4 = await stripe("invoice.paid", invoice(`in_${run}_4`, cusB, 5000, bEmail));
const disp = await stripe("charge.dispute.created", { id: `dp_${run}`, charge: `ch_in_${run}_4`, payment_intent: `pi_in_${run}_4`, status: "needs_response" });
check("chargeback reverses the commission", disp.data.result?.action === "reversed", disp.data);
r = await A("/api/referrals/me");
check(`A: earned ${dollars(r.data.stats.earned_cents)} ($10 + $5)`, r.data.stats.earned_cents === 1500, r.data.stats);

// ---------------------------------------------------------------------------
console.log("\n6. Abuse protection");
const C = client("10.0.0.3");
await C(`/?ref=${aCode}`);
r = await C("/api/auth/signup", { method: "POST", body: { email: aEmail.replace("@", "+alt@"), password: "password-c-123", name: "Alt" } });
check("A can't refer a +alias of their own email", r.data.referral?.attributed === false && r.data.referral.reason === "self_referral", r.data.referral);
const D = client("10.0.0.1");
await D(`/?ref=${aCode}`);
r = await D("/api/auth/signup", { method: "POST", body: { email: `d.${run}@example.com`, password: "password-d-123", name: "D", device: "aaaaaaaaaaaaaaaa" } });
check("same IP + same device as A gets flagged", r.data.referral?.flags?.includes("same_ip_as_referrer") && r.data.referral.flags.includes("same_device_as_referrer"), r.data.referral);
const dId = r.data.user.id;
await stripe("charge.succeeded", { id: `ch_in_${run}_D`, payment_intent: `pi_in_${run}_D`, payment_method_details: { card: { fingerprint: "fp_B" } } });
const invD = await stripe("invoice.paid", invoice(`in_${run}_D`, `cus_${run}_D`, 5000, `d.${run}@example.com`, { metadata: { user_id: dId } }));
check("flagged referral's commission is held for review, not auto-paid", invD.data.result?.commission?.status === "held", invD.data.result);
r = await B("/api/auth/signup", { method: "POST", body: { email: bEmail, password: "x-password-123" } });
check("can't create a second account on the same email", r.status === 409);

// Pre-referral payment: E pays first, then signs up through A's link.
const eEmail = `e.${run}@example.com`;
await stripe("invoice.paid", invoice(`in_${run}_E`, `cus_${run}_E`, 4900, eEmail));
const E = client("10.0.0.5");
await E(`/?ref=${aCode}`);
r = await E("/api/auth/signup", { method: "POST", body: { email: eEmail, password: "password-e-123", name: "E" } });
check("E attributed to A", r.data.referral?.attributed === true);
check("E's earlier payment is linked to E's account (plan = pro)", r.data.user?.plan === "pro", r.data.user);
r = await A("/api/referrals/me");
check("but it earns A nothing: it was paid before the referral", !r.data.commissions.some((c) => c.artist === "E"), r.data.commissions);

// ---------------------------------------------------------------------------
console.log("\n7. Admin view");
const ADM = client("10.0.0.9");
await ADM("/api/auth/signup", { method: "POST", body: { email: "admin@releasely.test", password: "admin-password-1", name: "Jay" } }).then((x) => x.status === 409 && ADM("/api/auth/login", { method: "POST", body: { email: "admin@releasely.test", password: "admin-password-1" } }));
r = await A("/api/admin/overview");
check("non-admins are blocked from admin API", r.status === 403);
r = await ADM("/api/admin/overview");
check("admin overview loads", r.status === 200 && r.data.referred >= 3, r.data);
console.log(`     referred ${r.data.referred}, paying ${r.data.paying}, conversion ${(r.data.conversion_rate * 100).toFixed(0)}%, revenue ${dollars(r.data.referred_revenue_cents)}, commissions ${dollars(r.data.commissions_cents)}`);
r = await ADM("/api/admin/referrers");
const rowA = r.data.referrers.find((x) => x.ref_code === aCode);
check("admin sees A as a referrer with their totals", rowA && rowA.referred === 3, rowA);
r = await ADM("/api/admin/referrals");
check("admin sees flags on D's referral", r.data.referrals.some((x) => x.flags.includes("same_device_as_referrer")));
r = await ADM("/api/admin/commissions?status=held");
const held = r.data.commissions.find((c) => c.referred_email === `d.${run}@example.com`);
check("held commission is listed for review", !!held, r.data.commissions);
r = await ADM(`/api/admin/commissions/${held.id}`, { method: "POST", body: { action: "reverse", note: "same person as referrer" } });
check("admin can reverse it", r.data.ok === true);

r = await ADM("/api/admin/commissions?status=reversed");
const chargedBack = r.data.commissions.find((c) => c.payment_status === "disputed" && c.referrer_email === aEmail);
r = await ADM(`/api/admin/commissions/${chargedBack.id}`, { method: "POST", body: { action: "approve" } });
check("admin can't approve a commission on a charged-back payment", r.status === 409, r.data);

// Approve the remaining open commissions (skips the 30-day wait) and pay A.
r = await ADM("/api/admin/commissions?status=pending");
for (const c of r.data.commissions.filter((c) => c.referrer_email === aEmail)) {
  await ADM(`/api/admin/commissions/${c.id}`, { method: "POST", body: { action: "approve", note: "test" } });
}
r = await A("/api/referrals/me");
check(`A: ${dollars(r.data.stats.available_cents)} available after approval`, r.data.stats.available_cents === 1500 && r.data.stats.pending_cents === 0, r.data.stats);
r = await ADM("/api/admin/payouts", { method: "POST", body: { referrer: aEmail, method: "paypal", reference: "TEST-123" } });
check("payout recorded for $15.00", r.data.amount_cents === 1500, r.data);
r = await A("/api/referrals/me");
check("A: $15.00 paid, $0 available", r.data.stats.paid_cents === 1500 && r.data.stats.available_cents === 0, r.data.stats);

// Refund after payout -> clawback against future earnings.
ref = await stripe("charge.refunded", { id: `ch_in_${run}_1`, payment_intent: `pi_in_${run}_1`, amount_refunded: 5000 });
check("refund after payout creates a clawback", ref.data.result?.action === "clawback", ref.data);
r = await A("/api/referrals/me");
check("A's net earned drops to $5.00, with $10.00 owed", r.data.stats.earned_cents === 500 && r.data.stats.owed_cents === 1000, r.data.stats);
check("refunded payment no longer counts as revenue ($25 left from the half refund)", r.data.stats.revenue_cents === 2500, r.data.stats);

// ---------------------------------------------------------------------------
console.log("\n8. Attribution can't be changed");
const lock = await fetch(BASE + "/api/referrals/me", { headers: {} });
check("dashboard requires login", lock.status === 401);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
