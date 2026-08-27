# Billing

Metal sells prepaid organization credits. Provider usage is deducted at cost. The platform fee is charged only when credits are purchased.

## Purchase fee

Card and Stripe Checkout purchases add 5.5% of the credit amount, with a $0.80 minimum fee.

Examples:

- $5.00 in credits costs $5.80
- $100.00 in credits costs $105.50

Amounts are stored as integer micro-USD. Never use floating point for money.

## Stripe setup

Set these server-only variables:

- `STRIPE_SECRET_KEY` — prefer a restricted key with Checkout Sessions, Customers, PaymentIntents, PaymentMethods, and webhook read
- `STRIPE_WEBHOOK_SECRET` — signing secret for `POST /v1/webhooks/stripe`

Local forwarding is started by `pnpm dev` (`stripe listen --forward-to localhost:4000/v1/webhooks/stripe`). Copy the printed signing secret into `STRIPE_WEBHOOK_SECRET`. You can also run it on its own with `pnpm stripe:listen`.

The dashboard never credits a balance from a success redirect. Stripe webhooks are the source of truth.

## Automatic top ups

Owners and admins can enable automatic top ups after a payment method is saved (from a successful purchase or the add payment method flow). They choose:

- balance threshold
- refill amount
- monthly cap on automatic credits

Metal charges the saved payment method off session. A declined payment or required customer action pauses the policy instead of retrying in a loop. Use Update payment method on the billing page to recover.

## Spend behavior

Managed sandbox creation requires a balance greater than zero. There is no estimated hold, so delayed provider metering can produce a temporary negative balance. When a durable charge leaves the balance at zero or below and automatic top up cannot run, Metal stops managed sandboxes. BYOK sandboxes are not charged and are not stopped by this path.

## Provider eligibility

Managed routing skips providers that do not expose durable cost evidence. BYOK continues to use those providers because the customer pays the provider directly.
