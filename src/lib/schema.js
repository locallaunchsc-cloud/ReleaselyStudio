// Database schema. Same pattern as the usage counter: every statement is
// idempotent and runs once per Worker instance, so a normal `git push`
// deploy is all it takes. migrations/0001_accounts_referrals.sql holds the
// same SQL if you'd rather apply it by hand with `wrangler d1 migrations apply`.

export const SCHEMA = [
  // Usage counter (unchanged, already live).
  `CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS artists (aid TEXT NOT NULL, event TEXT NOT NULL, first_seen TEXT NOT NULL DEFAULT (datetime('now')), n INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (aid, event))`,

  // Artist accounts.
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     email_canonical TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     password_salt TEXT NOT NULL,
     display_name TEXT NOT NULL DEFAULT '',
     ref_code TEXT NOT NULL UNIQUE,
     plan TEXT NOT NULL DEFAULT 'free',
     stripe_customer_id TEXT UNIQUE,
     device_id TEXT,
     signup_ip_hash TEXT,
     last_ip_hash TEXT,
     payout_method TEXT,
     payout_handle TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS users_email_canonical ON users(email_canonical)`,

  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id),
     ip_hash TEXT,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,

  `CREATE TABLE IF NOT EXISTS login_attempts (ip_hash TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS login_attempts_ip ON login_attempts(ip_hash, at)`,

  // Every visit to a referral link, logged server-side.
  `CREATE TABLE IF NOT EXISTS referral_clicks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ref_code TEXT NOT NULL,
     referrer_id TEXT NOT NULL,
     ip_hash TEXT,
     landed_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS referral_clicks_referrer ON referral_clicks(referrer_id)`,

  // One row per referred artist. Written once at signup, never reassigned.
  `CREATE TABLE IF NOT EXISTS referrals (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     referrer_id TEXT NOT NULL REFERENCES users(id),
     referred_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
     ref_code TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'active',   -- active | blocked (blocked = no new commissions)
     flags TEXT NOT NULL DEFAULT '[]',        -- JSON list of risk signals seen at signup
     created_at TEXT NOT NULL,
     CHECK (referrer_id <> referred_user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals(referrer_id)`,
  // Attribution is permanent: the database itself refuses to move or delete it.
  `CREATE TRIGGER IF NOT EXISTS referrals_owner_locked
     BEFORE UPDATE OF referrer_id, referred_user_id ON referrals
     WHEN NEW.referrer_id IS NOT OLD.referrer_id OR NEW.referred_user_id IS NOT OLD.referred_user_id
     BEGIN SELECT RAISE(ABORT, 'referral attribution is permanent'); END`,
  `CREATE TRIGGER IF NOT EXISTS referrals_no_delete
     BEFORE DELETE ON referrals
     BEGIN SELECT RAISE(ABORT, 'referral attribution is permanent'); END`,

  // Every real payment Stripe reports, linked to the artist who paid.
  `CREATE TABLE IF NOT EXISTS payments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     stripe_ref TEXT NOT NULL UNIQUE,          -- invoice id (subscriptions) or checkout session id (one-time)
     user_id TEXT REFERENCES users(id),        -- null until we can match the payer to an account
     stripe_customer_id TEXT,
     stripe_subscription_id TEXT,
     stripe_payment_intent_id TEXT,
     stripe_charge_id TEXT,
     customer_email TEXT,
     product TEXT NOT NULL DEFAULT 'pro',
     amount_cents INTEGER NOT NULL,            -- what the artist actually paid
     tax_cents INTEGER NOT NULL DEFAULT 0,
     refunded_cents INTEGER NOT NULL DEFAULT 0,
     currency TEXT NOT NULL DEFAULT 'usd',
     status TEXT NOT NULL DEFAULT 'paid',      -- paid | partially_refunded | refunded | disputed | fraud_warning
     card_fingerprint TEXT,
     paid_at TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id)`,
  `CREATE INDEX IF NOT EXISTS payments_customer ON payments(stripe_customer_id)`,
  `CREATE INDEX IF NOT EXISTS payments_pi ON payments(stripe_payment_intent_id)`,
  `CREATE INDEX IF NOT EXISTS payments_charge ON payments(stripe_charge_id)`,

  // Card details from charge events, which can arrive before or after the invoice.
  `CREATE TABLE IF NOT EXISTS stripe_charges (
     charge_id TEXT PRIMARY KEY,
     payment_intent_id TEXT,
     invoice_id TEXT,
     card_fingerprint TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS stripe_charges_pi ON stripe_charges(payment_intent_id)`,

  // The ledger. kind = commission (one per payment), clawback (negative, after a
  // refund on an already-paid commission) or adjustment (manual, by admin).
  `CREATE TABLE IF NOT EXISTS commissions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     referrer_id TEXT NOT NULL REFERENCES users(id),
     referred_user_id TEXT REFERENCES users(id),
     payment_id INTEGER REFERENCES payments(id),
     kind TEXT NOT NULL DEFAULT 'commission',
     base_cents INTEGER NOT NULL DEFAULT 0,    -- payment amount minus tax and refunds
     rate_bps INTEGER NOT NULL DEFAULT 0,
     amount_cents INTEGER NOT NULL,
     currency TEXT NOT NULL DEFAULT 'usd',
     status TEXT NOT NULL,                     -- pending | held | available | paid | reversed
     available_at TEXT,
     flags TEXT NOT NULL DEFAULT '[]',
     note TEXT,
     payout_id INTEGER REFERENCES payouts(id),
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS commissions_one_per_payment ON commissions(payment_id) WHERE kind = 'commission'`,
  `CREATE INDEX IF NOT EXISTS commissions_referrer ON commissions(referrer_id, status)`,

  // Audit trail for every status or amount change.
  `CREATE TABLE IF NOT EXISTS commission_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     commission_id INTEGER NOT NULL REFERENCES commissions(id),
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     from_status TEXT,
     to_status TEXT,
     amount_cents INTEGER,
     note TEXT,
     at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS payouts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     referrer_id TEXT NOT NULL REFERENCES users(id),
     amount_cents INTEGER NOT NULL,
     currency TEXT NOT NULL DEFAULT 'usd',
     method TEXT,
     reference TEXT,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,

  // Stripe can deliver the same event more than once; process each only once.
  `CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at TEXT NOT NULL)`,
];

let ready = false;

export async function ensureSchema(db) {
  if (ready) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  ready = true;
}
