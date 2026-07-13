# Agent dev guide — hadrontool-twilio

**hadrontool-twilio** is an independently-deployed, **stateless** SMS-sending
capability tool for the Hadron platform: it lets headless LLM runs send an
outbound SMS via the Twilio REST API. Core (hadron-server) keeps the
contract, identity, and ALL authorization — the policy chain
(`tool.hadron_send_sms`), action budgets, and the `sms.send` daily quotas all
run in core before a request reaches this tool. This tool executes the send
and nothing else.

**Intent:** internal/staff notification SMS — not a mass-campaign tool. Not
a hard rule; core's quotas are the enforcement. Sibling tools:
`hadrontool-webfetch` (the template this repo copies) and
`hadrontool-ms-exchange` (the `defineOp` ops-registry pattern).

## Commands

```bash
npm run dev          # tsx watch (port 8080)
npm test             # vitest — real HTTP via supertest over a FAKE fetch seam
npm run typecheck
```

No database, no Prisma, no migrations — nothing to set up.

## Structure

- `src/twilio.ts` — the ONE upstream-speaking module: fixed base URL
  (api.twilio.com), HTTP Basic from the resolved credentials, form-encoded
  `To`/`Body`/`From`|`MessagingServiceSid`, one AbortController budget (25s,
  deliberately below core's 30s client timeout), typed error mapping.
- `src/ops/index.ts` — the operation registry (`send-sms`); one zod schema
  via `defineOp`. Credential resolution: inline override → platform account
  (env) → `provider_not_configured`.
- `src/routes/` — `ops` (bearer-gated internal plane), `health` (open).
- Tests inject `TwilioDeps.fetchImpl` fakes — no network in the suite.

## Key invariants

- **Stateless.** No database, no keys at rest beyond the platform account in
  env (Doppler), no connection records. Consequence: NO idempotency ledger
  is possible, and an SMS send is non-idempotent — core's smsClient must
  NEVER auto-retry a send.
- **All authorization happens in core.** Never add authorization, quota, or
  rate-limit logic to this tool (cor:int:030:01 — Hadron-blind).
- **The upstream is fixed.** Caller-supplied URLs never reach a socket, so
  this tool carries no SSRF guard BY DESIGN — do not add caller-controlled
  destinations without adding the webfetch egress policy.
- **Credentials and message bodies never leak.** Not into logs (log codes,
  statuses, durations only — never `to`, never `body`, never tokens), not
  into error bodies (zod messages don't echo values; Twilio messages are
  passed through bounded).
- **Error codes are the public contract.** hadron-server passes `error`
  through verbatim (`extensions.smsErrorCode`). Add codes; never change
  meanings. Catalog: `validation_error`, `provider_not_configured`,
  `provider_unauthorized`, `provider_rejected` (carries the Twilio error
  code, e.g. 21211), `provider_rate_limited`, `upstream_unreachable`,
  `upstream_timeout`, `internal_error`.
- **BYO-ready seam.** `send-sms` accepts optional inline credentials
  (accountSid + authToken + from|messagingServiceSid, all-or-nothing). Core
  v1 never sends them; the deferred org-scoped BYO registry lands with zero
  tool changes. Don't remove the seam.
- **Agent-agnostic.** No agent names in `src/` (Constitution Invariant #14).

## Use of Hadron

This tool has no memory of its own — work against the shared ones:

- `hrn:memory:hadronmemory.com::dev` — findings, conventions, ops, `preflight`
- `hrn:memory:hadronmemory.com::specs` — product specs (`cor:int:030` is the
  capability-tool module; `cor:int:030:01` the Hadron-blind boundary)

Query Hadron before reading code/design (`hadron_find_nodes` → `hadron_get_node`),
and capture non-obvious findings as nodes the moment they emerge.
