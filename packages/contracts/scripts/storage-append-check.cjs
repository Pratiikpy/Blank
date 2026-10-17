#!/usr/bin/env node
// Verifies a storage-layout snapshot change is a safe UUPS upgrade:
// every pre-existing variable keeps its slot, offset, label and type, and
// new variables only take space that was previously __gap (the gap end
// slot does not move). Compares the committed snapshot (git HEAD) with the
// working-tree snapshot. Run after `pnpm storage:write`.
//
//   node scripts/storage-append-check.cjs            # all changed snapshots
//   node scripts/storage-append-check.cjs PaymentHub # one contract
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "storage-layouts");
const strip = (t) => (typeof t === "string" ? t.replace(/[0-9]+/g, "") : t);

function load(json) {
  const j = JSON.parse(json);
  return j.storage.map((s) => ({
    label: s.label,
    slot: BigInt(s.slot),
    offset: s.offset,
    type: strip(s.type),
    bytes: BigInt((j.types[s.type] || {}).numberOfBytes || "32"),
  }));
}

function check(name) {
  const rel = `packages/contracts/storage-layouts/${name}.json`;
  let oldJson;
  try {
    oldJson = execSync(`git show HEAD:"${rel}"`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    console.log(`[new] ${name}: no committed snapshot (fresh contract)`);
    return true;
  }
  const oldL = load(oldJson);
  const newL = load(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
  const errs = [];
  const oldGap = oldL.find((s) => s.label === "__gap");
  const newGap = newL.find((s) => s.label === "__gap");
  for (const o of oldL) {
    if (o.label === "__gap") continue;
    const n = newL.find((s) => s.label === o.label && s.slot === o.slot);
    if (!n) errs.push(`moved/removed: ${o.label} @${o.slot}`);
    else if (n.offset !== o.offset || n.type !== o.type)
      errs.push(`changed: ${o.label} ${o.type}@${o.slot}+${o.offset} -> ${n.type}@${n.slot}+${n.offset}`);
  }
  if (oldGap) {
    if (!newGap) errs.push("__gap removed");
    else {
      const oldEnd = oldGap.slot + oldGap.bytes / 32n;
      const newEnd = newGap.slot + newGap.bytes / 32n;
      if (oldEnd !== newEnd) errs.push(`__gap end moved ${oldEnd} -> ${newEnd}`);
      for (const n of newL) {
        if (n.label === "__gap" || oldL.some((o) => o.label === n.label && o.slot === n.slot)) continue;
        if (n.slot < oldGap.slot) errs.push(`new var ${n.label} @${n.slot} below old gap start ${oldGap.slot}`);
      }
    }
  } else {
    const oldMax = oldL.reduce((m, s) => (s.slot > m ? s.slot : m), -1n);
    for (const n of newL)
      if (!oldL.some((o) => o.label === n.label && o.slot === n.slot) && n.slot <= oldMax)
        errs.push(`new var ${n.label} @${n.slot} not appended (old max slot ${oldMax})`);
  }
  const added = newL.filter((n) => !oldL.some((o) => o.label === n.label && o.slot === n.slot) && n.label !== "__gap");
  if (errs.length) {
    console.log(`[FAIL] ${name}\n  ${errs.join("\n  ")}`);
    return false;
  }
  console.log(`[ok] ${name}${added.length ? " +" + added.map((a) => `${a.label}@${a.slot}`).join(", ") : ""}`);
  return true;
}

let names = process.argv.slice(2);
if (!names.length) {
  names = execSync(`git diff --name-only HEAD -- storage-layouts`, { cwd: path.join(__dirname, "..") })
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((f) => path.basename(f, ".json"));
}
const ok = names.map(check).every(Boolean);
process.exit(ok ? 0 : 1);
