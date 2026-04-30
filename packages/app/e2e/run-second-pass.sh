#!/bin/bash
# Second pass — re-run only the specs that failed in the first rerun.
# Hopefully the bumped prompt loops (2→4) flip the gift/group/invoice
# timeouts to passes.
set -uo pipefail
cd "$(dirname "$0")/.."

export PLAYWRIGHT_BASE_URL=http://localhost:3000
export NODE_OPTIONS="--max-old-space-size=4096"

declare -a SPECS=(
  "e2e/smoke-phase1.spec.ts"
  "e2e/passkey-smart-wallet.spec.ts"
  "e2e/phase4-business.spec.ts"
  "e2e/phase4-creator.spec.ts"
  "e2e/phase4-groups.spec.ts"
  "e2e/phase4-p2p-fill.spec.ts"
  "e2e/phase7-create-then-claim.spec.ts"
  "e2e/phase7-gift-claim-fast.spec.ts"
  "e2e/phase7-gift-claim.spec.ts"
  "e2e/phase7-group-settle.spec.ts"
  "e2e/phase7-invoice-pay.spec.ts"
  "e2e/session3-batch-b-cancel.spec.ts"
  "e2e/session3-p1-finalize-invoice.spec.ts"
  "e2e/session3-batch-c-escrow-payroll-group.spec.ts"
  "e2e/session3-p2-payroll-group-gift.spec.ts"
  "e2e/session4-phase1-passkey-gaps.spec.ts"
  "e2e/session4-phase2-two-person.spec.ts"
)

SUMMARY_FILE="/tmp/ui-suite-pass2-summary.txt"
> "$SUMMARY_FILE"
echo "Second pass — after prompt-loop bumps (2→4)" >> "$SUMMARY_FILE"
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$SUMMARY_FILE"
echo "" >> "$SUMMARY_FILE"

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

PASS_COUNT=0
FAIL_COUNT=0
TOTAL=${#SPECS[@]}
INDEX=0

for spec in "${SPECS[@]}"; do
  INDEX=$((INDEX+1))
  spec_id=$(basename "$spec" .spec.ts)
  log="/tmp/ui-pass2-${spec_id}.log"

  if ! wait_dev_alive; then
    echo "[runner] dev down 2min, aborting at $spec" | tee -a "$SUMMARY_FILE"
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

cat "$SUMMARY_FILE"
