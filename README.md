# hadrontool-twilio

Stateless SMS-sending capability tool for the [Hadron](https://hadronmemory.com)
platform. Gives headless LLM runs a governed way to send an outbound SMS via
the Twilio REST API.

**Intent:** internal/staff notification SMS. Hadron-server enforces daily
quotas (`sms.send`) and the run policy chain (`tool.hadron_send_sms`) so this
never becomes a mass-campaign channel.

## Architecture

- **Stateless, DB-less, internal-only.** No Traefik route, no public DNS;
  hadron-server reaches it at `http://hadrontool-twilio:8080`.
- **Hadron-blind** (spec `cor:int:030:01`): holds no platform data, calls no
  platform API. All authorization happens in core before a request arrives.
- **Fixed upstream:** `api.twilio.com` only — caller-supplied URLs never
  reach a socket, so there is no SSRF surface.
- **Credential layering** (platform-default / BYO-override): the platform
  Twilio account lives in this tool's env (Doppler); a request may carry
  inline credentials instead (the seam for Hadron's deferred org-scoped
  bring-your-own-Twilio registry). Neither ⇒ `provider_not_configured`.
- **Non-idempotent sends:** no idempotency ledger exists; callers must never
  auto-retry a send.

## API

All `/ops` and `/info` requests require `Authorization: Bearer $TWILIO_TOOL_TOKEN`.

| Route | Purpose |
|---|---|
| `GET /healthz` / `GET /readyz` | liveness / readiness (public) |
| `GET /info` | capability advertisement `{name, version, operations, stateless, platformAccountConfigured}` |
| `POST /ops/send-sms` | send one SMS |

### `POST /ops/send-sms`

```json
{ "to": "+15551234567", "body": "Deploy finished." }
```

Optional inline credential override (all-or-nothing):
`accountSid` (AC…), `authToken`, and exactly one of `from` (E.164) /
`messagingServiceSid`.

Success: `200 {"ok": true, "sid": "SM…", "status": "queued"}`.

Errors: `{"error": "<code>", "message": "…"}` with stable codes
`validation_error` (400), `provider_not_configured` (503),
`provider_unauthorized` (502), `provider_rejected` (502, carries the Twilio
error code, e.g. 21211 invalid To-number), `provider_rate_limited` (429),
`upstream_unreachable` (502), `upstream_timeout` (504), `internal_error` (500).
Codes are the public contract — hadron-server surfaces them verbatim.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `TWILIO_TOOL_TOKEN` | in production | shared bearer for the ops plane |
| `TWILIO_ACCOUNT_SID` | for platform sends | Twilio Account SID (AC…) |
| `TWILIO_AUTH_TOKEN` | for platform sends | Twilio auth token |
| `TWILIO_FROM` / `TWILIO_MESSAGING_SERVICE_SID` | exactly one | sender identity |
| `PORT` | no | default 8080 |

The tool boots without Twilio credentials and answers
`provider_not_configured` until they are set (staged-deploy friendly).

## Development

```bash
npm install
npm run dev          # tsx watch on :8080
npm test             # vitest — no network; fake fetch seam
npm run typecheck
```

Twilio's [test credentials](https://www.twilio.com/docs/iam/test-credentials)
with the magic from-number `+15005550006` exercise the full path without
sending real SMS or spending money.
