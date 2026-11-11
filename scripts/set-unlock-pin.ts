// Sets the admin unlock PIN: npm run set-unlock-pin [config.json]
// Run on the bridge host. 6-digit PIN, stored hashed in admin.unlock_pin_hash, every other key is kept.
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { hashPin, PIN_RE } from "../src/admin/unlock.ts";

const path = process.argv[2] ?? "config.json";
const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const admin = (raw.admin ?? {}) as Record<string, unknown>;

const rl = createInterface({ input: process.stdin, output: process.stdout });
const pin = (await rl.question("New unlock PIN (6 digits): ")).trim();
const again = (await rl.question("Repeat: ")).trim();
rl.close();
if (!PIN_RE.test(pin)) {
    console.error("The PIN must be exactly 6 digits.");
    process.exit(1);
}
if (pin !== again) {
    console.error("The two entries do not match.");
    process.exit(1);
}
admin.unlock_pin_hash = hashPin(pin);
raw.admin = admin;
copyFileSync(path, `${path}.bak`);
writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
console.log(`PIN saved to ${path} (previous file: ${path}.bak). Restart the bridge to apply.`);
