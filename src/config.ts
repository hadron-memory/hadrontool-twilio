import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration, validated once at boot. Importing this module
 * throws (and the process exits non-zero) if the environment is invalid, so a
 * misconfigured container fails fast instead of half-working.
 *
 * The Twilio platform credentials are deliberately OPTIONAL at boot
 * (hadrontool-google-cal posture): the tool starts and answers
 * `provider_not_configured` until they are set, so a staged deploy is
 * observable rather than a crash loop.
 */
const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  TWILIO_TOOL_TOKEN: z.string().min(1).optional(),
  // Shape-validated so a malformed Doppler value fails the BOOT, not the
  // first send — a container must never advertise a configured-but-unusable
  // platform account (PR-1 review, Gemini + Codex).
  TWILIO_ACCOUNT_SID: z
    .string()
    .regex(/^AC[0-9a-fA-F]{32}$/, 'must be a Twilio Account SID (AC…)')
    .optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_FROM: z
    .string()
    .regex(/^\+[1-9]\d{1,14}$/, 'must be an E.164 phone number')
    .optional(),
  TWILIO_MESSAGING_SERVICE_SID: z
    .string()
    .regex(/^MG[0-9a-fA-F]{32}$/, 'must be a Twilio Messaging Service SID (MG…)')
    .optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

const env = parsed.data;
const isProduction = env.NODE_ENV === 'production';

// Refuse to run an unauthenticated SMS sender in production — an open
// send endpoint inside the private network would let anything on the
// network spend the platform's Twilio account.
if (isProduction && !env.TWILIO_TOOL_TOKEN) {
  // eslint-disable-next-line no-console
  console.error('TWILIO_TOOL_TOKEN must be set when NODE_ENV=production. Refusing to start.');
  process.exit(1);
}

// A half-configured sender identity is a config error worth failing fast on
// (both set ⇒ ambiguous which one wins; Twilio accepts either, not both).
if (env.TWILIO_FROM && env.TWILIO_MESSAGING_SERVICE_SID) {
  // eslint-disable-next-line no-console
  console.error('Set exactly one of TWILIO_FROM / TWILIO_MESSAGING_SERVICE_SID, not both. Refusing to start.');
  process.exit(1);
}

// Boot-tolerance applies to a FULLY-unset platform account (staged deploy);
// a PARTIAL one is almost certainly a user error — fail fast rather than
// answer provider_not_configured forever at runtime (PR-1 review, Gemini).
const anyPlatformVar = Boolean(
  env.TWILIO_ACCOUNT_SID || env.TWILIO_AUTH_TOKEN || env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID,
);
if (anyPlatformVar) {
  const missing: string[] = [];
  if (!env.TWILIO_ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID');
  if (!env.TWILIO_AUTH_TOKEN) missing.push('TWILIO_AUTH_TOKEN');
  if (!env.TWILIO_FROM && !env.TWILIO_MESSAGING_SERVICE_SID) {
    missing.push('either TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID');
  }
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`Partial platform Twilio configuration. Missing: ${missing.join(', ')}. Refusing to start.`);
    process.exit(1);
  }
}

export const VERSION = '0.1.0';

/** The platform Twilio account (v1 default credential source). */
export interface PlatformTwilioAccount {
  accountSid: string;
  authToken: string;
  from?: string;
  messagingServiceSid?: string;
}

/** Resolved platform account, or undefined while unconfigured. */
function platformAccount(): PlatformTwilioAccount | undefined {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return undefined;
  if (!env.TWILIO_FROM && !env.TWILIO_MESSAGING_SERVICE_SID) return undefined;
  return {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    ...(env.TWILIO_FROM ? { from: env.TWILIO_FROM } : {}),
    ...(env.TWILIO_MESSAGING_SERVICE_SID ? { messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID } : {}),
  };
}

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction,
  port: env.PORT,
  /** Shared bearer token; when undefined, auth is disabled (dev only). */
  serviceToken: env.TWILIO_TOOL_TOKEN,
  /** Platform Twilio credentials; undefined ⇒ provider_not_configured. */
  platformAccount: platformAccount(),
} as const;

export type Config = typeof config;
