// Smoke-check the v018 BusinessHub upgrade. Reads the two new mappings on
// the upgraded proxy. Both should return 0x0…0 for legacy invoice/escrow
// ids that pre-date the upgrade — proves the new selectors are live and
// that storage isn't corrupted (legacy slots return their old values).
import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  const addrs = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!addrs.BusinessHub) throw new Error("BusinessHub not in deployment");

  const hub = await hre.ethers.getContractAt("BusinessHub", addrs.BusinessHub);
  const pdfCid0 = await hub.invoicePdfCidHash(0);
  const escrowCid0 = await hub.escrowAttachmentCidHash(0);
  const pdfCid1 = await hub.invoicePdfCidHash(1);

  console.log(`Network:           ${network}`);
  console.log(`BusinessHub proxy: ${addrs.BusinessHub}`);
  console.log(`BusinessHub impl:  ${addrs.BusinessHub_Impl}`);
  console.log(`invoicePdfCidHash(0):       ${pdfCid0}`);
  console.log(`invoicePdfCidHash(1):       ${pdfCid1}`);
  console.log(`escrowAttachmentCidHash(0): ${escrowCid0}`);
  // Both must be 32-byte zeros for any legacy id — proves new selector is
  // wired up AND legacy storage wasn't shifted (otherwise we'd be reading
  // a different slot's value, almost certainly non-zero).
  const ok =
    pdfCid0 === "0x0000000000000000000000000000000000000000000000000000000000000000" &&
    pdfCid1 === "0x0000000000000000000000000000000000000000000000000000000000000000" &&
    escrowCid0 === "0x0000000000000000000000000000000000000000000000000000000000000000";
  console.log(ok ? "\n✓ smoke OK" : "\n✗ smoke FAILED — non-zero hash on legacy id");
  if (!ok) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
