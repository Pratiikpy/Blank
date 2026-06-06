#!/usr/bin/env python3
"""Independent audit of sweep tx hashes against on-chain status.

For each "✓ feature persona 0x<txhash>" row in a sweep log, query the
chain via JSON-RPC eth_getTransactionReceipt and confirm status=0x1.
This is the second layer of verification on top of the sweep's own
receipt-status check — a sweep that reports pass for actual on-chain
reverts is the bug class this script catches.

Usage:
    python audit-sweep.py truly-final-base-sepolia-40-pass.log base
    python audit-sweep.py truly-final-eth-sepolia-40-pass.log eth
    python audit-sweep.py truly-final-arb-sepolia-40-pass.log arb
"""
import re, json, urllib.request, time, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

RPCS = {
    "base": [
        "https://sepolia.base.org",
        "https://base-sepolia.gateway.tenderly.co",
        "https://base-sepolia-rpc.publicnode.com",
    ],
    "eth": [
        "https://ethereum-sepolia-rpc.publicnode.com",
        "https://1rpc.io/sepolia",
        "https://rpc.sepolia.org",
    ],
    "arb": [
        "https://sepolia-rollup.arbitrum.io/rpc",
        "https://arbitrum-sepolia-rpc.publicnode.com",
        "https://arbitrum-sepolia.gateway.tenderly.co",
    ],
}

def main():
    if len(sys.argv) != 3 or sys.argv[2] not in RPCS:
        print(f"Usage: python {sys.argv[0]} <sweep-log.txt> <base|eth|arb>")
        sys.exit(2)
    log_path = sys.argv[1]
    chain = sys.argv[2]
    rpcs = RPCS[chain]

    with open(log_path, 'r', encoding='utf-8') as f:
        log = f.read()
    rows = re.findall(r'^\s*✓\s+(\S+)\s+(\S+)\s+(0x[0-9a-fA-F]{64})', log, re.MULTILINE)
    print(f"Auditing {len(rows)} claimed-pass rows on {chain}-sepolia\n")

    ok = revert = unreachable = 0
    revs = []
    for feat, persona, txhash in rows:
        req = {"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":[txhash]}
        body = json.dumps(req).encode()
        got = False
        for url in rpcs:
            try:
                r = urllib.request.Request(url, data=body, headers={"Content-Type":"application/json","User-Agent":"audit/1"})
                with urllib.request.urlopen(r, timeout=15) as resp:
                    d = json.loads(resp.read())
                    result = d.get('result')
                    if result is None:
                        continue
                    status = result.get('status', '0x0')
                    got = True
                    if status == '0x1':
                        ok += 1
                    else:
                        revert += 1
                        revs.append((feat, persona, txhash))
                    break
            except Exception:
                pass
        if not got:
            unreachable += 1
        time.sleep(0.15)

    print(f"Result: {ok} truly mined / {revert} reverted / {unreachable} unreachable of {len(rows)}")
    if revs:
        print("\nReverted (claimed-pass that actually reverted):")
        for f, p, h in revs:
            print(f"  - {f:30} {p:6} {h}")
    elif ok == len(rows):
        print("\nAll claimed-pass tx hashes confirmed status=0x1 on chain.")
    sys.exit(0 if revert == 0 and unreachable == 0 else 1)

if __name__ == "__main__":
    main()
