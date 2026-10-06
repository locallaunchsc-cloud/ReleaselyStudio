# Artist referral program

Artists earn 20% of what the artists they refer pay, on every payment, for as
long as those artists keep paying. Everything is tracked in the D1 database;
nothing is calculated in the browser.

## How it works

1. Every account gets a referral code. Links look like `/?ref=CODE`.
2. When someone opens that link, the Worker logs the visit and sets an
   HttpOnly cookie (60 days, last link clicked wins).
3. On signup the server reads the cookie and writes a row in `referrals`.
   That row can never be changed or deleted (database triggers block it).
4. Stripe sends a webhook for every payment. Each one becomes a `payments`
   row, and if the payer was referred, a `commissions` row:
   20% of (amount paid - tax - refunds), rounded down to the cent.
5. Commissions start as **pending** for 30 days (refund window), then become
   **available**. You pay artists yourself and record it in the admin page,
   which marks them **paid**.
6. Refunds shrink or reverse unpaid commissions. Chargebacks and fraud
   warnings reverse them. If a refund lands after you already paid, a
   negative "clawback" comes off that artist's next payout.
7. Suspicious signups (same IP, same device, same card as the referrer,
   bursts from one IP) are **held** until you approve or reverse them.
   Self-referrals (including email aliases like you+2@gmail.com) are blocked.
   Payments made before someone was referred never earn commission.

## One-time setup

1. **Stripe webhook.** Stripe Dashboard > Developers > Webhooks > Add endpoint:
   `https://releaselystudio.releasely.workers.dev/api/stripe/webhook`
   Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `invoice.paid`, `charge.succeeded`, `charge.refunded`,
   `charge.dispute.created`, `charge.dispute.closed`,
   `radar.early_fraud_warning.created`.
   Copy the signing secret (starts with `whsec_`).
2. **Secrets.** Cloudflare Dashboard > Workers & Pages > releaselystudio >
   Settings > Variables and Secrets. Add as **Secret**:
   - `STRIPE_WEBHOOK_SECRET` = the whsec_ value
   - `IP_SALT` = any long random string
   - `STRIPE_SECRET_KEY` (optional) = a restricted, read-only key
3. **Push the code** (see below) and wait for the deploy.
4. **Make yourself admin.** Create your account at `/account.html`, open
   `/api/me`, copy your `id`, paste it into `ADMIN_USER_IDS` in
   `wrangler.jsonc`, push again. Then `/admin.html` works for you only.

Settings in `wrangler.jsonc` (`vars`): commission rate, hold days, how many
months a referral earns (0 = forever), payout minimum, cookie length.

## Pages and API

- `/account.html`: sign up / log in, referral link, Copy / Share / Invite,
  earnings, referral and commission history, payout details
- `/admin.html`: totals, conversion rate, all referrers and referred artists,
  commission review (approve, hold, reverse, edit), payouts, adjustments
- API: `/api/auth/*`, `/api/me`, `/api/referrals/*`, `/api/stripe/webhook`,
  `/api/admin/*`

## Testing locally

```
npx wrangler dev --local --var STRIPE_WEBHOOK_SECRET:whsec_test --var DEV_ADMIN_EMAILS:admin@releasely.test --var DEV_INSECURE_COOKIES:1
node test/referral-flow.test.mjs
```

## Known gaps (next steps)

- No email verification yet. Payments that arrive without an account are
  matched by email, so add verification before relying on that heavily.
- Payouts are manual. Stripe Connect can automate them later.
