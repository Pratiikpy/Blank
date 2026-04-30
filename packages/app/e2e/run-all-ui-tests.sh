#!/bin/bash
# Full UI verification — every feature, every flow.
# Each spec runs in its own playwright process so memory leaks / context
# cleanup hangs in one spec don't poison the next.
#
# Skipped specs (require external infra we can't drive headless):
#   - session3-eoa-mock.spec.ts          : depends on injected mock provider
#   - session3-metamask-eoa.spec.ts      : needs MetaMask extension
#   - session3-metamask-full.spec.ts     : needs MetaMask extension
#   - session3-p1-finalize-fix-verify    : verification meta-test
#   - session3-p1-finalize-existing      : intermediate debug
#   - session3-p1-finalize-ui-verify     : verification meta-test
#   - chain-selector / health / verify-page : trivial / not feature flows

set -uo pipefail
cd "$(dirname "$0")/.."

export PLAYWRIGHT_BASE_URL=http://localhost:3000
export NODE_OPTIONS="--max-old-space-size=4096"

declare -a SPECS=(
  # Public + nav rendering
  "e2e/landing.spec.ts"
  "e2e/navigation.spec.ts"
  "e2e/smoke-phase1.spec.ts"
  "e2e/smoke-phase1_5.spec.ts"

  # Wallet
  "e2e/passkey-smart-wallet.spec.ts"

  # Single-account FHE + contract flows
  "e2e/phase2-send.spec.ts"
  "e2e/phase2-shield.spec.ts"
  "e2e/phase3-gift.spec.ts"
  "e2e/phase3-stealth.spec.ts"
  "e2e/phase4-business.spec.ts"
  "e2e/phase4-creator.spec.ts"
  "e2e/phase4-groups.spec.ts"
  "e2e/phase4-inheritance.spec.ts"
  "e2e/phase4-p2p-fill.spec.ts"
  "e2e/phase4-swap.spec.ts"

  # Cross-account on-chain (the user's primary scenario)
  "e2e/phase6-creator-crossaccount.spec.ts"
  "e2e/phase6-send-realtime.spec.ts"
  "e2e/phase7-create-then-claim.spec.ts"
  "e2e/phase7-gift-claim-fast.spec.ts"
  "e2e/phase7-gift-claim.spec.ts"
  "e2e/phase7-group-settle.spec.ts"
  "e2e/phase7-invoice-pay.spec.ts"
  "e2e/phase7-recipient-send-back.spec.ts"
  "e2e/phase7-recipient-shield.spec.ts"
  "e2e/phase7-request-fulfill.spec.ts"

  # Cancellation + finalize paths
  "e2e/session3-batch-b-cancel.spec.ts"
  "e2e/session3-p1-escrow-dispute.spec.ts"
  "e2e/session3-p1-finalize-click.spec.ts"
  "e2e/session3-p1-finalize-invoice.spec.ts"
  "e2e/session3-p1-stealth-finalize.spec.ts"

  # Multi-feature batches
  "e2e/session3-batch-c-escrow-payroll-group.spec.ts"
  "e2e/session3-batch-d-encrypted.spec.ts"
  "e2e/session3-batch-e-ai-agents.spec.ts"
  "e2e/session3-p2-payroll-group-gift.spec.ts"
  "e2e/session4-phase1-passkey-gaps.spec.ts"
  "e2e/session4-phase2-two-person.spec.ts"

  # UI surface / UX
  "e2e/phase8-comprehensive-smoke.spec.ts"
  "e2e/phase9-remaining.spec.ts"
  "e2e/phase10-live-feed.spec.ts"
  "e2e/phase10-ux-smokes.spec.ts"
  "e2e/session3-batch-a-landing.spec.ts"
)

SUMMARY_FILE="/tmp/ui-suite-summary.txt"
mkdir -p /tmp
> "$SUMMARY_FILE"
echo "UI verification — full sweep" >> "$SUMMARY_FILE"
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$SUMMARY_FILE"
echo "" >> "$SUMMARY_FILE"

PASS_COUNT=0
FAIL_COUNT=0
TOTAL=${#SPECS[@]}
INDEX=0

wait_dev_alive() {
  local tries=0
  while [ $tries -lt 60 ]; do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 2>/dev/null)" = "200" ]; then
      return 0
    fi
    sleep 2
    tries=$((tries+1))
  done
  return 1
}

for spec in "${SPECS[@]}"; do
  INDEX=$((INDEX+1))
  spec_id=$(basename "$spec" .spec.ts)
  log="/tmp/ui-suite-${spec_id}.log"

  # Wait for dev server (watchdog restarts it after a crash) before
  # firing the next spec; otherwise we get ECONNREFUSED cascades.
  if ! wait_dev_alive; then
    echo "[runner] dev server still down after 2 min — aborting" | tee -a "$SUMMARY_FILE"
    break
  fi

  echo ""
  echo "════════════════════════════════════════════════════════════════════"
  echo "  [$INDEX/$TOTAL] $spec"
  echo "════════════════════════════════════════════════════════════════════"

  start=$(date +%s)
  pnpm exec playwright test "$spec" --project=chromium --reporter=list --timeout=900000 --workers=1 > "$log" 2>&1
  exit_code=$?
  end=$(date +%s)
  dur=$((end-start))

  # Parse pass/fail count from playwright's "X passed (Ym)" / "X failed" line
  passed=$(grep -E "^\s*[0-9]+ passed" "$log" 2>/dev/null | tail -1 | grep -oE "[0-9]+" | head -1)
  failed=$(grep -E "^\s*[0-9]+ failed" "$log" 2>/dev/null | tail -1 | grep -oE "[0-9]+" | head -1)
  passed=${passed:-0}
  failed=${failed:-0}

  if [ "$exit_code" = "0" ] && [ "$failed" = "0" ]; then
    status="PASS"
    PASS_COUNT=$((PASS_COUNT+1))
  else
    status="FAIL"
    FAIL_COUNT=$((FAIL_COUNT+1))
  fi

  printf "  [%2d/%2d] %-55s %s  (%ds, %d✓/%d✘)\n" \
    "$INDEX" "$TOTAL" "$spec_id" "$status" "$dur" "$passed" "$failed" \
    | tee -a "$SUMMARY_FILE"
done

echo "" >> "$SUMMARY_FILE"
echo "Finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$SUMMARY_FILE"
echo "Total: $TOTAL specs   PASS: $PASS_COUNT   FAIL: $FAIL_COUNT" >> "$SUMMARY_FILE"

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "FINAL: $PASS_COUNT/$TOTAL specs passed"
echo "════════════════════════════════════════════════════════════════════"
cat "$SUMMARY_FILE"
