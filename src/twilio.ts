/**
 * The one upstream-speaking module: sends an SMS via the Twilio REST API.
 *
 * The upstream is FIXED (api.twilio.com) — caller-supplied URLs never reach
 * a socket, so this tool carries no SSRF guard by design. Credentials arrive
 * per request (inline override) or from the platform account in env; they
 * are used for one HTTP Basic header and never persisted or logged.
 *
 * Sends are NON-IDEMPOTENT: the tool is stateless (no idempotency ledger),
 * so callers must never auto-retry a failed send.
 */

import {
  ProviderRateLimitedError,
  ProviderRejectedError,
  ProviderUnauthorizedError,
  UpstreamTimeoutError,
  UpstreamUnreachableError,
} from './errors.js';
import { logger } from './logger.js';

export const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

/**
 * Total time budget for the Twilio call — deliberately below hadron-server's
 * 30s client timeout so the typed `upstream_timeout` wins over core's
 * generic SMS_TOOL_UNREACHABLE.
 */
export const SEND_TIMEOUT_MS = 25_000;

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  /** Exactly one of `from` / `messagingServiceSid` is set (validated upstream). */
  from?: string;
  messagingServiceSid?: string;
}

export interface SendSmsRequest {
  to: string;
  body: string;
}

export interface SendSmsResult {
  /** Twilio message SID (SM…). */
  sid: string;
  /** Twilio message status at creation time (usually "queued"). */
  status: string;
}

/**
 * Injectable seam — tests pass a fake fetch and a fixture platform account;
 * production (app.ts) wires the global fetch + the env-configured account.
 * Carrying the platform account here keeps ops/ free of config imports, so
 * both the configured and unconfigured paths are testable in one process.
 */
export interface TwilioDeps {
  fetchImpl: typeof fetch;
  /** The env-configured platform Twilio account; undefined ⇒ unconfigured. */
  platformAccount?: TwilioCredentials;
}

/**
 * POST /Accounts/{sid}/Messages.json with HTTP Basic auth. Maps every
 * failure mode to the typed catalog; only programming errors escape untyped.
 */
export async function sendSms(
  creds: TwilioCredentials,
  request: SendSmsRequest,
  deps: TwilioDeps,
): Promise<SendSmsResult> {
  const url = `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`;
  const form = new URLSearchParams({ To: request.to, Body: request.body });
  if (creds.messagingServiceSid) {
    form.set('MessagingServiceSid', creds.messagingServiceSid);
  } else if (creds.from) {
    form.set('From', creds.from);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  const startedAt = Date.now();
  let res: Response;
  let payload: Record<string, unknown> | null;
  try {
    res = await deps.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: controller.signal,
    });
    // Body read stays inside the timeout window.
    try {
      payload = (await res.json()) as Record<string, unknown> | null;
    } catch {
      if (controller.signal.aborted) throw new Error('timed out mid-body');
      payload = null;
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new UpstreamTimeoutError(SEND_TIMEOUT_MS / 1000);
    }
    throw new UpstreamUnreachableError(String((err as Error)?.message ?? err).slice(0, 200));
  } finally {
    clearTimeout(timer);
  }

  logger.info('twilio send attempted', {
    status: res.status,
    durationMs: Date.now() - startedAt,
  });

  if (res.status === 429) throw new ProviderRateLimitedError();
  if (res.status === 401 || res.status === 403) throw new ProviderUnauthorizedError(res.status);
  if (res.status >= 500) throw new UpstreamUnreachableError(`Twilio answered HTTP ${res.status}.`);
  if (!res.ok) {
    // Twilio 4xx error envelope: { code: 21211, message: "...", status: 400 }.
    const code = typeof payload?.code === 'number' ? payload.code : null;
    const message =
      typeof payload?.message === 'string' ? payload.message.slice(0, 300) : `Twilio answered HTTP ${res.status}.`;
    throw new ProviderRejectedError(code, message, res.status);
  }

  const sid = typeof payload?.sid === 'string' ? payload.sid : null;
  if (!sid) {
    throw new UpstreamUnreachableError('Twilio returned an unexpected response shape.');
  }
  return {
    sid,
    status: typeof payload?.status === 'string' ? payload.status : 'unknown',
  };
}
