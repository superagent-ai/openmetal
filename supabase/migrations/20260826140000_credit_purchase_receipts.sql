alter table metal.credit_purchases
  add column stripe_receipt_url text,
  add column stripe_invoice_url text;
