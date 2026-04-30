#!/bin/bash
# Re-run each failed test in a FRESH playwright process with bigger heap.
# Each test gets its own process so memory leaks from a prior test don't
# kill the next one.
set -uo pipefail

cd "$(dirname "$0")/.."

export PLAYWRIGHT_BASE_URL=http://localhost:3000
export NODE_OPTIONS="--max-old-space-size=4096"

declare -a TESTS=(
  "e2e/phase7-create-then-claim.spec.ts"
  "e2e/phase7-gift-claim.spec.ts"
  "e2e/phase7-group-settle.spec.ts"
  "e2e/phase7-invoice-pay.spec.ts"
  "e2e/phase7-request-fulfill.spec.ts"
  "e2e/session4-phase2-two-person.spec.ts:206"  # C4 group expense
  "e2e/session4-phase2-two-person.spec.ts:284"  # C5 gift
)

PASS=0
FAIL=0
declare -a RESULTS

for test in "${TESTS[@]}"; do
  echo ""
  echo "=================================================================="
  echo " Running: $test"
  echo "=================================================================="
  if pnpm exec playwright test "$test" --project=chromium --reporter=list --timeout=300000 --workers=1 2>&1 | tee "/tmp/rerun-$(echo "$test" | tr '/:' '__').log" | grep -E "passed|failed" | tail -3; then
    if grep -qE "^\s*[0-9]+ passed" "/tmp/rerun-$(echo "$test" | tr '/:' '__').log" 2>/dev/null; then
      PASS=$((PASS+1))
      RESULTS+=("PASS  $test")
    else
      FAIL=$((FAIL+1))
      RESULTS+=("FAIL  $test")
    fi
  else
    FAIL=$((FAIL+1))
    RESULTS+=("FAIL  $test (exit $?)")
  fi
done

echo ""
echo "=================================================================="
echo "FINAL: $PASS passed, $FAIL failed"
echo "=================================================================="
for r in "${RESULTS[@]}"; do echo "  $r"; done
