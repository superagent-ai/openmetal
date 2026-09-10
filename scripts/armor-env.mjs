import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dotenvxBin = resolve(root, "node_modules/.bin/dotenvx");
const envFile = resolve(root, ".env");
const keysFile = resolve(root, ".env.keys");
const hadLocalKeys = existsSync(keysFile);

if (!existsSync(dotenvxBin)) {
  throw new Error("missing @dotenvx/dotenvx. Run pnpm install.");
}
if (!existsSync(envFile)) {
  throw new Error("missing encrypted .env");
}

if (hadLocalKeys) {
  run(["armor", "up", "-f", ".env", "--team", "superagent-team"]);
}

const status = spawnSync(dotenvxBin, ["armor", "status"], {
  cwd: root,
  encoding: "utf8",
});
if (status.status !== 0 || status.stdout.trim() !== "on") {
  throw new Error("Dotenvx Armor is not active. Run `pnpm exec dotenvx armor login`, then retry.");
}

const envLines = readFileSync(envFile, "utf8").split("\n");
const plaintextSecrets = envLines.flatMap((line) => {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (!match?.[1] || match[2] === undefined) return [];
  const [key, rawValue] = [match[1], match[2].replace(/^["']|["']$/g, "")];
  const secretLike = /_(?:SECRET|API_KEY|TOKEN|PASSWORD|PRIVATE_KEY)/.test(key);
  return secretLike && rawValue && !rawValue.startsWith("encrypted:") ? [key] : [];
});
if (plaintextSecrets.length > 0) {
  throw new Error(`.env contains unencrypted secret values: ${plaintextSecrets.join(", ")}`);
}

const encryptedKeys = envLines.flatMap((line) => {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(?:["']?)encrypted:/.exec(line.trim());
  return match?.[1] ? [match[1]] : [];
});
if (encryptedKeys.length === 0) {
  throw new Error(".env does not contain encrypted values");
}

const verification = `
const keys = JSON.parse(process.env.DOTENVX_VERIFY_KEYS || "[]");
const missing = keys.filter((key) => {
  const value = process.env[key];
  return value === undefined || value.startsWith("encrypted:");
});
if (missing.length > 0) {
  console.error("Armor could not decrypt: " + missing.join(", "));
  process.exit(1);
}
`;
const verified = spawnSync(
  dotenvxBin,
  ["run", "-f", ".env", "--", process.execPath, "-e", verification],
  {
    cwd: root,
    env: {
      ...process.env,
      DOTENVX_VERIFY_KEYS: JSON.stringify(encryptedKeys),
    },
    stdio: "inherit",
  },
);
if (verified.status !== 0) {
  process.exit(verified.status ?? 1);
}

console.log(
  hadLocalKeys
    ? "Uploaded the private key to Dotenvx Armor and verified decryption."
    : "Dotenvx Armor is already configured; verified encrypted .env decryption.",
);

function run(args) {
  const result = spawnSync(dotenvxBin, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
