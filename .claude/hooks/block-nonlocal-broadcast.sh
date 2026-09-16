#!/usr/bin/env bash
# PreToolUse hook (safety rules 2/3, docs/SPEC.md #2): blocks any Bash command that
# looks like it would broadcast a transaction to an RPC other than localhost/127.0.0.1
# (i.e. anything but a local Anvil fork). Sentinel's execution mode must stay "off"
# during development, and this is the mechanical backstop for that — code-level
# enforcement is not enough on its own per the spec.
#
# Reads the PreToolUse hook JSON payload on stdin: {"tool_name": "...", "tool_input":
# {"command": "..."}}. Only inspects Bash calls. On a match, prints a PreToolUse
# "deny" decision as JSON; otherwise exits silently (allow).
set -euo pipefail

input="$(cat)"
tool_name="$(jq -r '.tool_name // empty' <<<"$input")"
command="$(jq -r '.tool_input.command // empty' <<<"$input")"

if [[ "$tool_name" != "Bash" || -z "$command" ]]; then
  exit 0
fi

# Commands that broadcast a signed transaction. Deliberately narrow (cast send/publish,
# forge script --broadcast, raw eth_sendRawTransaction/eth_sendTransaction JSON-RPC
# calls e.g. via curl) rather than matching every "cast"/"forge" invocation — read-only
# calls like `cast call` or a non-broadcast `forge script` dry run are unaffected.
is_broadcast=false
grep -qE '(^|[|&;]|[[:space:]])cast[[:space:]]+send([[:space:]]|$)' <<<"$command" && is_broadcast=true
grep -qE '(^|[|&;]|[[:space:]])cast[[:space:]]+publish([[:space:]]|$)' <<<"$command" && is_broadcast=true
if grep -qE '(^|[|&;]|[[:space:]])forge[[:space:]]+script([[:space:]]|$)' <<<"$command" \
  && grep -qE '(^|[[:space:]])--broadcast([[:space:]]|$)' <<<"$command"; then
  is_broadcast=true
fi
grep -qiE 'eth_sendRawTransaction|eth_sendTransaction' <<<"$command" && is_broadcast=true

if [[ "$is_broadcast" != true ]]; then
  exit 0
fi

is_local_url() {
  [[ "$1" =~ ^https?://(localhost|127(\.[0-9]{1,3}){3}|\[::1\])([:/]|$) ]]
}

# Every URL-shaped token the command references: --rpc-url VALUE / --rpc-url=VALUE,
# an RPC_URL=... env assignment, or a bare http(s):// URL (e.g. passed to curl).
urls="$( (grep -oE '(--rpc-url[= ][^ ]+|RPC_URL=[^ ]+|https?://[^ ]+)' <<<"$command" \
  | sed -E 's/^--rpc-url[= ]//; s/^RPC_URL=//') || true )"

block=false
if [[ -z "$urls" ]]; then
  # A broadcast-shaped command with no discoverable RPC URL might fall back to an env
  # var or foundry.toml default we can't see from here — fail closed rather than
  # assume it's local.
  block=true
else
  while IFS= read -r url; do
    [[ -z "$url" ]] && continue
    is_local_url "$url" || block=true
  done <<<"$urls"
fi

if [[ "$block" == true ]]; then
  reason="Blocked by Sentinel's safety hook (docs/SPEC.md #2, rules 2-3): this command looks like it would broadcast a transaction to a non-local RPC. Execution mode must stay 'off' during development -- only localhost/127.0.0.1 (Anvil forks) are permitted. If this is genuinely a local fork, make the RPC URL explicit as http://127.0.0.1:<port> or http://localhost:<port>. Command: $command"
  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
fi

exit 0
