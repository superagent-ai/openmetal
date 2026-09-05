"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Add01Icon,
  CreditCardIcon,
  File01Icon,
  InformationCircleIcon,
  Invoice01Icon,
  Refresh01Icon,
  Settings04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createMetalClient } from "@/lib/metal";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { OrganizationBilling } from "@openmetal/sdk";

const dateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

function purchaseSourceLabel(source: OrganizationBilling["purchases"][number]["source"]): string {
  switch (source) {
    case "welcome_grant":
      return "Welcome credit";
    case "admin_grant":
      return "Admin credit";
    case "auto_topup":
      return "Automatic top up";
    case "checkout":
      return "Credit purchase";
  }
}

function formatUsd(value: string): string {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return value;
  const dollars = match[1] ?? "0";
  const cents = (match[2] ?? "").padEnd(2, "0") || "00";
  return cents === "00" ? dollars : `${dollars}.${cents}`;
}

function feeFor(amountUsd: string): { fee: string; total: string } | null {
  const match = /^\d+(?:\.\d{1,2})?$/.exec(amountUsd.trim());
  if (!match) return null;
  const [dollars, cents = ""] = amountUsd.trim().split(".");
  const credit =
    BigInt(dollars ?? "0") * 1_000_000n + BigInt(cents.padEnd(2, "0") || "0") * 10_000n;
  if (credit < 5_000_000n || credit > 10_000_000_000n) return null;
  const percentFeeCents = (credit * 55n + 5_000_000n) / 10_000_000n;
  const percent = percentFeeCents * 10_000n;
  const fee = percent > 800_000n ? percent : 800_000n;
  const format = (value: bigint) => {
    const abs = value < 0n ? -value : value;
    return `${value < 0n ? "-" : ""}${abs / 1_000_000n}.${((abs % 1_000_000n) / 10_000n).toString().padStart(2, "0")}`;
  };
  return { fee: format(fee), total: format(credit + fee) };
}

function SwitchControl({
  checked,
  disabled,
  id,
  onCheckedChange,
}: {
  checked: boolean;
  disabled?: boolean;
  id?: string;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full ring-1 ring-foreground/10 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "pointer-events-none absolute top-0.5 size-4 rounded-full bg-background shadow-sm transition-[left]",
          checked ? "left-[1.125rem]" : "left-0.5",
        )}
      />
    </button>
  );
}

function cardLabel(billing: OrganizationBilling): string {
  const method = billing.payment_method;
  if (!method) return "No saved payment method";
  const brand = method.brand ? method.brand.toUpperCase() : "CARD";
  if (!method.last4) return brand;
  return `${brand} · ${method.last4}`;
}

function PaymentMethodIcon({ billing }: { billing: OrganizationBilling }) {
  if (billing.payment_method?.brand?.toLowerCase() === "link") {
    return <Image src="/stripe-link-mark.svg" alt="" width={20} height={20} className="size-5" />;
  }
  return <HugeiconsIcon icon={CreditCardIcon} strokeWidth={2} className="size-4" />;
}

function autoTopupCopy(billing: OrganizationBilling): ReactNode {
  const policy = billing.auto_topup;
  if (policy.status === "paused") {
    return (
      <>
        Auto top-up is <span className="font-medium text-foreground">paused</span>
        {policy.paused_reason ? ` (${policy.paused_reason.replaceAll("_", " ")})` : ""}. Update the
        payment method to resume.
      </>
    );
  }
  if (policy.enabled && policy.status === "active") {
    return (
      <>
        Auto top-up is <span className="font-medium text-foreground">enabled</span> and will add{" "}
        <span className="font-medium text-foreground">${formatUsd(policy.refill_usd)}</span>{" "}
        automatically when your balance drops below{" "}
        <span className="font-medium text-foreground">${formatUsd(policy.threshold_usd)}</span>.
      </>
    );
  }
  return (
    <>
      Auto top-up is <span className="font-medium text-foreground">disabled</span>. Turn it on to
      refill credits before the balance runs out.
    </>
  );
}

export function BillingView({
  organizationId,
  organizationName,
  organizationSlug,
  initialBilling,
  notice,
}: {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  initialBilling: OrganizationBilling;
  notice?: string | null;
}) {
  const [billing, setBilling] = useState(initialBilling);
  const [amount, setAmount] = useState("25");
  const [threshold, setThreshold] = useState(initialBilling.auto_topup.threshold_usd);
  const [refill, setRefill] = useState(initialBilling.auto_topup.refill_usd);
  const [monthlyCap, setMonthlyCap] = useState(initialBilling.auto_topup.monthly_cap_usd);
  const [enabled, setEnabled] = useState(initialBilling.auto_topup.enabled);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"checkout" | "policy" | "card" | "refresh" | null>(null);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const quote = useMemo(() => feeFor(amount), [amount]);
  const canManage = billing.can_manage;
  const transactions = useMemo(
    () => billing.purchases.filter((purchase) => purchase.status === "paid"),
    [billing.purchases],
  );

  async function client() {
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    return createMetalClient(async () => data.session?.access_token);
  }

  function syncPolicy(next: OrganizationBilling) {
    setThreshold(next.auto_topup.threshold_usd);
    setRefill(next.auto_topup.refill_usd);
    setMonthlyCap(next.auto_topup.monthly_cap_usd);
    setEnabled(next.auto_topup.enabled);
  }

  async function refresh() {
    setBusy("refresh");
    try {
      const metal = await client();
      const next = await metal.billing.get(organizationId);
      setBilling(next);
      syncPolicy(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not refresh billing");
    } finally {
      setBusy(null);
    }
  }

  async function onCheckout(event: FormEvent) {
    event.preventDefault();
    if (!canManage || !quote) return;
    setError(null);
    setBusy("checkout");
    try {
      const metal = await client();
      const result = await metal.billing.checkout(
        organizationId,
        { amount_usd: amount.includes(".") ? amount : `${amount}.00` },
        { idempotencyKey: crypto.randomUUID() },
      );
      window.location.assign(result.checkout_url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start checkout");
      setBusy(null);
    }
  }

  async function onSavePolicy(event: FormEvent) {
    event.preventDefault();
    if (!canManage) return;
    setError(null);
    setBusy("policy");
    try {
      const metal = await client();
      const next = await metal.billing.updateAutoTopup(organizationId, {
        enabled,
        threshold_usd: threshold,
        refill_usd: refill,
        monthly_cap_usd: monthlyCap,
      });
      setBilling(next);
      syncPolicy(next);
      setAutoOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save automatic top ups");
    } finally {
      setBusy(null);
    }
  }

  async function onAddCard() {
    if (!canManage) return;
    setError(null);
    setBusy("card");
    try {
      const metal = await client();
      const result = await metal.billing.setupPaymentMethod(organizationId);
      window.location.assign(result.checkout_url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start payment method setup");
      setBusy(null);
    }
  }

  function openAutoTopup() {
    syncPolicy(billing);
    setAutoOpen(true);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">
            Organization Credits
          </h1>
          <p className="text-sm text-muted-foreground">Org Account: {organizationName}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void refresh()}
          disabled={busy === "refresh"}
        >
          <HugeiconsIcon icon={Refresh01Icon} strokeWidth={2} />
          {busy === "refresh" ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="pt-1">
          <div className="flex items-center gap-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Total available
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                    aria-label="About prepaid credits"
                  />
                }
              >
                <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} />
              </TooltipTrigger>
              <TooltipContent>
                Credits pay managed sandbox usage at provider cost. Purchases add a 5.5% platform
                fee with an $0.80 minimum.
              </TooltipContent>
            </Tooltip>
          </div>
          <p className="mt-2 font-heading text-4xl font-semibold tracking-tight tabular-nums">
            ${billing.balance_usd}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Prepaid credits</p>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="h-full">
          <CardHeader>
            <CardTitle>Buy credits</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-center">
            <Button
              type="button"
              size="lg"
              className="w-full"
              disabled={!canManage}
              onClick={() => setPurchaseOpen(true)}
            >
              Add credits
            </Button>
            {!canManage ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Only owners and admins can purchase credits.
              </p>
            ) : null}
          </CardContent>
          <CardFooter>
            <Link
              href={`/dashboard/${organizationSlug}/usage`}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              View usage
            </Link>
          </CardFooter>
        </Card>

        <Card className="h-full">
          <CardHeader>
            <CardTitle>Auto top-up</CardTitle>
            <CardAction>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!canManage}
                onClick={openAutoTopup}
              >
                <HugeiconsIcon icon={Settings04Icon} strokeWidth={2} />
                Manage
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-center">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {autoTopupCopy(billing)}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3">
        <h2 className="text-base font-medium">Recent transactions</h2>
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow>
                <TableHead className="pl-4">Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead className="pr-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                    No transactions yet.
                  </TableCell>
                </TableRow>
              ) : (
                transactions.map((purchase) => (
                  <TableRow key={purchase.id}>
                    <TableCell className="pl-4 text-muted-foreground">
                      {formatDate(purchase.paid_at ?? purchase.created_at)}
                    </TableCell>
                    <TableCell>{purchaseSourceLabel(purchase.source)}</TableCell>
                    <TableCell>${purchase.credit_usd}</TableCell>
                    <TableCell className="pr-4">
                      <div className="flex items-center justify-end gap-3">
                        {purchase.receipt_url ? (
                          <a
                            href={purchase.receipt_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                          >
                            Receipt
                            <HugeiconsIcon icon={File01Icon} strokeWidth={2} className="size-3.5" />
                          </a>
                        ) : null}
                        {purchase.invoice_url ? (
                          <a
                            href={purchase.invoice_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                          >
                            Get invoice
                            <HugeiconsIcon
                              icon={Invoice01Icon}
                              strokeWidth={2}
                              className="size-3.5"
                            />
                          </a>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <p className="text-sm text-muted-foreground">
          {transactions.length} {transactions.length === 1 ? "transaction" : "transactions"}
        </p>
      </div>

      <Dialog open={purchaseOpen} onOpenChange={setPurchaseOpen}>
        <DialogContent className="sm:max-w-md" showCloseButton>
          <form className="grid gap-4" onSubmit={onCheckout}>
            <DialogHeader>
              <DialogTitle>Purchase credits</DialogTitle>
              <DialogDescription>
                You receive the credit amount. The platform fee is added at checkout.
              </DialogDescription>
            </DialogHeader>

            <div className="overflow-hidden rounded-lg border border-foreground/20 bg-muted transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
              <div className="flex items-center gap-3 p-3">
                <div className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <PaymentMethodIcon billing={billing} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{cardLabel(billing)}</p>
                  <p className="text-xs text-muted-foreground">
                    {billing.payment_method
                      ? "Saved for automatic top-ups"
                      : "Optional. Stripe will collect payment details."}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={
                    billing.payment_method ? "Update payment method" : "Add payment method"
                  }
                  disabled={!canManage || busy === "card"}
                  onClick={() => void onAddCard()}
                >
                  <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                </Button>
              </div>
              <div className="flex border-t border-foreground/20">
                <Label
                  htmlFor="credit-amount"
                  className="flex items-center border-r border-foreground/20 px-4 text-muted-foreground"
                >
                  Amount
                </Label>
                <Input
                  id="credit-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (/^\d*(?:\.\d{0,2})?$/.test(next)) setAmount(next);
                  }}
                  className="h-10 rounded-none border-0 bg-transparent px-4 text-right text-base tabular-nums shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
                  pattern="\d*(?:\.\d{0,2})?"
                  required
                />
              </div>
            </div>

            <Separator />

            {quote ? (
              <dl className="grid gap-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Platform fee</dt>
                  <dd className="tabular-nums">${quote.fee}</dd>
                </div>
                <div className="flex justify-between gap-4 font-medium">
                  <dt>Total due</dt>
                  <dd className="tabular-nums">${quote.total}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                Enter an amount between $5.00 and $10,000.00.
              </p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={!canManage || !quote || busy === "checkout"}
            >
              {busy === "checkout" ? "Redirecting" : "Purchase"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={autoOpen} onOpenChange={setAutoOpen}>
        <DialogContent className="sm:max-w-md">
          <form className="grid gap-4" onSubmit={onSavePolicy}>
            <DialogHeader>
              <DialogTitle>Auto top-up</DialogTitle>
              <DialogDescription>
                Metal charges the saved card when the balance reaches the threshold, including the
                same purchase fee.
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="auto-topup-enabled">Enable auto top-up</Label>
              <SwitchControl
                id="auto-topup-enabled"
                checked={enabled}
                disabled={!canManage}
                onCheckedChange={setEnabled}
              />
            </div>

            <div className="flex items-center gap-3 rounded-lg border p-3">
              <div className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <PaymentMethodIcon billing={billing} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{cardLabel(billing)}</p>
                {billing.auto_topup.paused_reason ? (
                  <p className="text-xs text-muted-foreground">
                    Paused: {billing.auto_topup.paused_reason.replaceAll("_", " ")}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">Used for automatic refills</p>
                )}
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={!canManage || busy === "card"}
              onClick={() => void onAddCard()}
            >
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {billing.payment_method ? "Update payment method" : "Add payment method"}
            </Button>

            <div className="grid gap-3">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="threshold">When credits are below</Label>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    id="threshold"
                    value={threshold}
                    onChange={(event) => setThreshold(event.target.value)}
                    disabled={!canManage}
                    className="w-24 text-right tabular-nums"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="refill">Purchase this amount</Label>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    id="refill"
                    value={refill}
                    onChange={(event) => setRefill(event.target.value)}
                    disabled={!canManage}
                    className="w-24 text-right tabular-nums"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="cap">Monthly cap</Label>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    id="cap"
                    value={monthlyCap}
                    onChange={(event) => setMonthlyCap(event.target.value)}
                    disabled={!canManage}
                    className="w-24 text-right tabular-nums"
                  />
                </div>
              </div>
            </div>

            <p className="text-sm text-muted-foreground">
              This month ${formatUsd(billing.auto_topup.month_credited_usd)} of $
              {formatUsd(billing.auto_topup.monthly_cap_usd)}
            </p>

            <DialogFooter>
              <Button type="submit" disabled={!canManage || busy === "policy"}>
                {busy === "policy" ? "Saving" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
