/**
 * The operation registry — the hadron-server contract surface.
 *
 * `POST /ops/<operation>`; each operation has ONE zod schema (defineOp parses
 * before the handler runs — no shadow schema to drift from the declared
 * contract; the pattern is hadrontool-ms-exchange's via webfetch).
 *
 * v1 operation: send-sms. Credential resolution is layered (spec 046's
 * platform-default / BYO-override shape): inline credentials on the request
 * win; otherwise the platform account from env; neither ⇒
 * provider_not_configured. hadron-server v1 never sends inline credentials —
 * the field exists so the deferred org-scoped BYO registry lands with ZERO
 * tool changes.
 *
 * The tool is stateless: no idempotency ledger is possible, so core's
 * smsClient must never auto-retry a send. ALL authorization (policy chain,
 * quotas, budgets) happens in core before a request reaches this tool
 * (cor:int:030:01 — Hadron-blind).
 */

import { z } from 'zod';
import { ProviderNotConfiguredError, ValidationError } from '../errors.js';
import { sendSms, type TwilioDeps, type TwilioCredentials } from '../twilio.js';

/** E.164: +, leading non-zero digit, 15 digits max. */
const E164_RE = /^\+[1-9]\d{1,14}$/;

/** Twilio's hard cap on an outbound message body (concatenated segments). */
export const MAX_SMS_BODY_CHARS = 1_600;

const ACCOUNT_SID_RE = /^AC[0-9a-fA-F]{32}$/;

const sendSmsSchema = z
  .object({
    to: z.string().regex(E164_RE, 'must be an E.164 phone number, e.g. +15551234567'),
    body: z.string().min(1).max(MAX_SMS_BODY_CHARS),
    // Inline credential override — the BYO-ready seam. All-or-nothing:
    // accountSid + authToken + exactly one sender identity.
    accountSid: z.string().regex(ACCOUNT_SID_RE, 'must be a Twilio Account SID (AC…)').optional(),
    authToken: z.string().min(1).optional(),
    from: z.string().regex(E164_RE, 'must be an E.164 phone number').optional(),
    messagingServiceSid: z.string().min(1).optional(),
  })
  .strict();

/**
 * Resolve which Twilio credentials this request uses: inline override
 * (all-or-nothing) → platform account → provider_not_configured.
 */
function resolveCredentials(
  input: z.infer<typeof sendSmsSchema>,
  platformAccount: TwilioCredentials | undefined,
): TwilioCredentials {
  const inlineFields = [input.accountSid, input.authToken].filter((v) => v !== undefined).length;
  const hasInlineSender = input.from !== undefined || input.messagingServiceSid !== undefined;

  if (inlineFields === 0 && !hasInlineSender) {
    if (!platformAccount) throw new ProviderNotConfiguredError();
    return platformAccount;
  }
  if (inlineFields < 2) {
    throw new ValidationError('accountSid', 'inline credentials require accountSid AND authToken (plus a sender)');
  }
  if (input.from && input.messagingServiceSid) {
    throw new ValidationError('from', 'set exactly one of "from" / "messagingServiceSid"');
  }
  if (!hasInlineSender) {
    throw new ValidationError('from', 'inline credentials require "from" or "messagingServiceSid"');
  }
  return {
    accountSid: input.accountSid!,
    authToken: input.authToken!,
    ...(input.from ? { from: input.from } : {}),
    ...(input.messagingServiceSid ? { messagingServiceSid: input.messagingServiceSid } : {}),
  };
}

/** One operation: the single input schema + the handler over parsed input. */
export interface OperationDef {
  schema: z.ZodType;
  run(deps: TwilioDeps, input: Record<string, unknown>): Promise<unknown>;
}

/**
 * Define an operation with ONE schema: defineOp parses the raw input against
 * it and hands the handler the typed result.
 */
function defineOp<S extends z.ZodType>(
  schema: S,
  handler: (deps: TwilioDeps, input: z.infer<S>) => Promise<unknown>,
): OperationDef {
  return {
    schema,
    run: (deps, raw) => handler(deps, schema.parse(raw)),
  };
}

const sendSmsOp = defineOp(sendSmsSchema, async (deps, input) => {
  const creds = resolveCredentials(input, deps.platformAccount);
  const result = await sendSms(creds, { to: input.to, body: input.body }, deps);
  return { sid: result.sid, status: result.status };
});

export const OPERATIONS: Record<string, OperationDef> = {
  'send-sms': sendSmsOp,
};

export async function runOperation(deps: TwilioDeps, name: string, input: Record<string, unknown>): Promise<unknown> {
  const def = OPERATIONS[name];
  if (!def) throw new ValidationError('operation', `unknown operation "${name}"`);
  return def.run(deps, input);
}
