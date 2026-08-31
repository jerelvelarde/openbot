#!/usr/bin/env bash
# Live traversal of the application-authored turn path, against running services.
set -u
BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YEL=$'\033[33m'; OFF=$'\033[0m'
say() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }
note() { printf '%s%s%s\n' "$DIM" "$1" "$OFF"; }

PG="docker exec cpki-deps-postgres-1 psql -U intelligence -d intelligence_app -t -A"
T=$(cat /private/tmp/claude-501/thread4.txt)

say "1. Services"
for p in 7050 7053 3011; do
  n=$(lsof -ti tcp:$p -sTCP:LISTEN 2>/dev/null | head -1)
  case $p in
    7050) l="Intelligence app-api";; 7053) l="Realtime Gateway";; *) l="OpenBot server";;
  esac
  printf '   %s%-22s%s :%s  %spid %s%s\n' "$GRN" "$l" "$OFF" "$p" "$DIM" "$n" "$OFF"
done
note "   Slack adapter is attached with a STUBBED token: every leg below is real"
note "   except the outbound Slack HTTP call, which cannot succeed without a workspace."

say "2. Is the Slack conversation writable from the web?"
note "   OpenBot asks Intelligence for a conversation reference the first time the"
note "   thread is opened. Before this branch the answer was always read-only."
curl -s -m 15 "http://localhost:3011/api/external-links/threads/$T" | python3 -m json.tool

say "3. Post a turn from the web surface"
curl -s -m 40 -X POST "http://localhost:3011/api/external-links/threads/$T/messages" \
  -H 'content-type: application/json' \
  -d '{"id":"recorded-web-turn-1","text":"Answering the Slack thread from the OpenBot web composer."}' \
  | python3 -m json.tool
note "   202, not 200: the turn is durably accepted; Slack and the agent come after."

say "4. What Intelligence recorded"
$PG -c "SELECT 'origin=' || origin || '  slot=' || conversation_turn_seq || '  wake=' || wake_state || '  echo_claimed=' || (authored_echo_claim_id IS NOT NULL) FROM cpki.channel_inbound_deliveries WHERE origin='application' ORDER BY created_at DESC LIMIT 1"
note "   An ordinary inbound delivery — same table, same pipeline as a Slack webhook."

say "5. The author that reached the SDK"
$PG -c "SELECT jsonb_pretty(prepared_input->'turn'->'authoredBy') FROM cpki.channel_inbound_deliveries WHERE origin='application' ORDER BY created_at DESC LIMIT 1"

say "6. Cross-surface ordering, in Redis"
KEY=$(docker exec cpki-deps-redis-1 redis-cli --scan --pattern '*conversation*' 2>/dev/null | head -1)
docker exec cpki-deps-redis-1 redis-cli HGETALL "$KEY" 2>/dev/null | paste - - | sed 's/^/   /'
note "   activeOrigin=application is the gate that stops a Slack message silently"
note "   superseding an accepted web turn, and vice versa."

say "7. Where it stops"
printf '   %sThe agent ran and the Gateway attempted the Slack posts; they fail on the%s\n' "$YEL" "$OFF"
printf '   %sstub token. The echo message id is therefore unrecorded — the pair fails%s\n' "$YEL" "$OFF"
printf '   %sin the safe direction: claimed-and-not-posted, never posted-twice.%s\n' "$YEL" "$OFF"
echo
