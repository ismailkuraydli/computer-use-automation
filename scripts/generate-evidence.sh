#!/usr/bin/env bash
# Regenerate the curated evidence in evidence/demo/.
#
# 1. A real LLM discovery run on the Keystone mock app (needs OPENROUTER_API_KEY)
#    plus its self-check replay.
# 2. Replays of the discovered artifact and of the hand-written open-sub-account
#    artifact, each with one runtime condition injected into the mock app.
#
# Each run is copied to evidence/demo/<NN-name>/ with its console output.
# Usage: scripts/generate-evidence.sh            (mock app must be free to start on :3000)
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=evidence/demo
MOCK=http://localhost:3000
rm -rf "$OUT"
mkdir -p "$OUT/artifacts"

if ! curl -s -o /dev/null "$MOCK/search"; then
  npm run -s mock-app > /dev/null 2>&1 &
  MOCK_PID=$!
  trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
  for _ in $(seq 1 40); do curl -s -o /dev/null "$MOCK/search" && break; sleep 0.25; done
fi

faults() { curl -s -X POST "$MOCK/__faults" -H 'content-type: application/json' -d "$1" > /dev/null; }

# keep <dest> <console> <label> [name]: copy the evidence dir printed after <label>
keep() {
  local dir
  dir=$(grep -E "$3" "$2" | grep -oE "evidence/[0-9a-f]{8}" | head -1 || true)
  if [ -n "$dir" ]; then cp -R "$dir" "$1/${4:-run}"; fi
}

# Console output is kept as evidence too — redact it like every other log.
redact() { perl -pe 's/(?<!\d)\d{10,12}(?!\d)/[REDACTED]/g; s/\d{3}-\d{2}-\d{4}/[REDACTED]/g'; }

record() {
  local name=$1; shift
  mkdir -p "$OUT/$name"
  { "$@" 2>&1 || true; } | redact > "$OUT/$name/console.txt"
  keep "$OUT/$name" "$OUT/$name/console.txt" "Evidence:"
  echo "$name: $(grep -E '^Status' "$OUT/$name/console.txt" | head -1)"
}

# --- 1. Discovery with the real LLM ---
faults '{}'
mkdir -p "$OUT/01-discovery"
npm run -s discover -- \
  --goal "Look up member 23456 and read the balance of their Savings account" \
  --target "$MOCK/search" --app keystone-cu --allowlist allowlists/keystone-cu.json \
  2>&1 | redact > "$OUT/01-discovery/console.txt"
keep "$OUT/01-discovery" "$OUT/01-discovery/console.txt" "Evidence:" discovery-run
keep "$OUT/01-discovery" "$OUT/01-discovery/console.txt" "Self-check replay:" self-check-run
DISCOVERED=$(grep -oE "artifacts/[^ ]+\.json" "$OUT/01-discovery/console.txt" | tail -1)
cp "$DISCOVERED" "$OUT/artifacts/lookup-member-savings-balance.json"
echo "01-discovery: $(grep -E 'Self-check' "$OUT/01-discovery/console.txt")"

npx tsx scripts/export-fixture-artifacts.ts "$OUT/artifacts/fixtures" > /dev/null
A="$OUT/artifacts/lookup-member-savings-balance.json"
F="$OUT/artifacts/fixtures/open-sub-account/v1.json"
BLANK=(--target about:blank)

# --- 2. Replays ---
faults '{}';                                    record 02-replay-other-member     npm run -s replay -- --artifact "$A" --params '{"memberId":"45678"}' "${BLANK[@]}"
faults '{}';                                    record 03-replay-not-found        npm run -s replay -- --artifact "$A" --params '{"memberId":"99999"}' "${BLANK[@]}"
faults '{}';                                    record 04-replay-no-savings-row   npm run -s replay -- --artifact "$A" --params '{"memberId":"34567"}' "${BLANK[@]}"
faults '{"interstitialPaths":["/search"]}';     record 05-replay-known-notice     npm run -s replay -- --artifact "$A" --params '{"memberId":"12345"}' "${BLANK[@]}"
faults '{"slowMs":2000,"transientErrors":1}';   record 06-replay-slow-and-503     npm run -s replay -- --artifact "$A" --params '{"memberId":"12345"}' "${BLANK[@]}"
faults '{"expireSessionAfter":2}';              record 07-replay-session-expired  npm run -s replay -- --artifact "$A" --params '{"memberId":"12345"}' "${BLANK[@]}"
faults '{}';                                    record 08-replay-missing-param    npm run -s replay -- --artifact "$A" --params '{}' "${BLANK[@]}"
faults '{"interstitialPaths":["/search"]}';     record 09-handoff-simulated-operator npx tsx scripts/handoff-demo.ts "$A" '{"memberId":"12345"}'
faults '{}';                                    record 10-open-account-unconfirmed npm run -s replay -- --artifact "$F" --params '{"memberId":"12345","accountType":"Checking","deposit":"250"}' "${BLANK[@]}"
faults '{}';                                    record 11-open-account-confirmed  npm run -s replay -- --artifact "$F" --params '{"memberId":"12345","accountType":"Checking","deposit":"250"}' --confirm "${BLANK[@]}"
faults '{}';                                    record 12-open-account-validation-error npm run -s replay -- --artifact "$F" --params '{"memberId":"12345","accountType":"Checking","deposit":"-5"}' --confirm "${BLANK[@]}"
faults '{"confirmOnSubmit":true}';              record 13-open-account-unexpected-dialog npm run -s replay -- --artifact "$F" --params '{"memberId":"12345","accountType":"Savings","deposit":"250"}' --confirm "${BLANK[@]}"
faults '{}'
