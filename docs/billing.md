# Billing

Metal sells prepaid organization credits. Provider usage is deducted at cost. The platform fee is charged only when credits are purchased.

## Welcome credits

Each new user receives a one-time $500.00 credit grant in the first organization they create. The
grant has no purchase fee and cannot be transferred to another organization. Creating additional
organizations does not issue additional credits.

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

Local forwarding:

```bash
stripe listen --forward-to localhost:4000/v1/webhooks/stripe
```

The dashboard never credits a balance from a success redirect. Stripe webhooks are the source of truth.

## Automatic top ups

Owners and admins can enable automatic top ups after a payment method is saved (from a successful purchase or the add payment method flow). They choose:

- balance threshold
- refill amount
- monthly cap on automatic credits

Metal charges the saved payment method off session. A declined payment or required customer action pauses the policy instead of retrying in a loop. Use Update payment method on the billing page to recover.

## Spend behavior

Managed sandbox creation requires a balance greater than zero. There is no estimated hold, so delayed provider metering can produce a temporary negative balance. When a durable charge leaves the balance at zero or below and automatic top up cannot run, Metal stops managed sandboxes. BYOK sandboxes are not charged and are not stopped by this path.

## Usage analytics

The organization Usage view reports compute cost by day, provider, project, sandbox, and billing
mode. Managed cost is the amount deducted from Metal credits. BYOK cost is observational only and
never affects the Metal balance.

Every cost snapshot records its source:

- Provider reported means the provider returned a monetary cost.
- Provider metered means the provider returned usage quantities and Metal applied a versioned rate.
- Rate estimate means Metal calculated cost from runtime evidence and a published rate card.

Provider reported values can still lag or differ from a final invoice because of discounts, taxes,
or delayed billing. Unsupported providers remain marked unavailable instead of receiving a
fabricated estimate.

Freestyle managed usage is a low-confidence rate-card estimate derived from provider-reported
cumulative runtime and fixed VM resources. It excludes data transfer, included plan credits,
discounts, and enterprise pricing, so it can differ from the Freestyle invoice.

Modal managed usage is a medium-confidence rate-card calculation derived from provider-reported
cumulative CPU core nanoseconds and memory GiB nanoseconds. Metal captures a final measurement
before termination and applies the published Modal Sandbox rate card. The result excludes credits,
discounts, and regional modifiers.

## Provider eligibility

Managed routing skips providers that do not expose durable cost evidence. BYOK continues to use those providers because the customer pays the provider directly.
