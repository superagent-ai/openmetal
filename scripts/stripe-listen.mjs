import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(resolve(root, ".env"));
loadEnvFile(resolve(root, "apps/api/.env"));

const port = process.env.API_PORT ?? "4000";
const forwardTo = `localhost:${port}/v1/webhooks/stripe`;
const events = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
].join(",");

const version = spawnSync("stripe", ["--version"], { encoding: "utf8" });
if (version.error) {
  console.error("Stripe CLI is not installed or not on PATH.");
  console.error("Install it with: brew install stripe/stripe-cli/stripe");
  console.error("Then authenticate with: stripe login");
  process.exit(1);
}

const args = ["listen", "--forward-to", forwardTo, "--events", events, "--skip-update"];
const secret = process.env.STRIPE_SECRET_KEY;
if (secret && !secret.includes("replace-with")) {
  args.unshift("--api-key", secret);
}

console.log(`Forwarding Stripe webhooks to ${forwardTo}`);
console.log("Copy the signing secret into STRIPE_WEBHOOK_SECRET if it is not already set.");

const child = spawn("stripe", args, { stdio: "inherit" });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
