/**
 * Typed error catalog — stable public surface.
 *
 * Codes are the PUBLIC contract: hadron-server's smsClient passes them
 * through to GraphQL `extensions.smsErrorCode` / run-tool errors verbatim,
 * so their meanings must stay stable. New codes may be added; existing ones
 * never change meaning.
 *
 * Error messages may name Twilio error codes and statuses but must NEVER
 * echo request input wholesale — operation inputs carry caller-supplied
 * credentials and message bodies.
 */

/** Base class: every tool error carries a stable `code` + HTTP status. */
export abstract class TwilioToolError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  /** JSON body shape every error response uses. */
  toBody(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extraFields() };
  }

  protected extraFields(): Record<string, unknown> {
    return {};
  }
}

/** Input failed schema or semantic validation. */
export class ValidationError extends TwilioToolError {
  readonly code = 'validation_error';
  readonly httpStatus = 400;
  constructor(
    public field: string,
    public reason: string,
  ) {
    super(`This request couldn't be processed: ${reason}`);
  }
  protected extraFields() {
    return { field: this.field, reason: this.reason };
  }
}

/** No platform Twilio account is configured and no inline credentials came. */
export class ProviderNotConfiguredError extends TwilioToolError {
  readonly code = 'provider_not_configured';
  readonly httpStatus = 503;
  constructor() {
    super('No Twilio account is configured on this tool and the request carried no credentials.');
  }
}

/** Twilio rejected the credentials (401/403). */
export class ProviderUnauthorizedError extends TwilioToolError {
  readonly code = 'provider_unauthorized';
  readonly httpStatus = 502;
  constructor(public providerStatus: number) {
    super(`Twilio rejected the credentials (HTTP ${providerStatus}).`);
  }
  protected extraFields() {
    return { providerStatus: this.providerStatus };
  }
}

/**
 * Twilio rejected the message itself (4xx with a Twilio error code, e.g.
 * 21211 invalid "To" number). The Twilio code + message are surfaced so the
 * calling LLM can adapt; Twilio's messages describe the problem without
 * echoing credentials.
 */
export class ProviderRejectedError extends TwilioToolError {
  readonly code = 'provider_rejected';
  readonly httpStatus = 502;
  constructor(
    public providerCode: number | null,
    providerMessage: string,
    public providerStatus: number,
  ) {
    super(
      providerCode != null
        ? `Twilio rejected the message (error ${providerCode}): ${providerMessage}`
        : `Twilio rejected the message: ${providerMessage}`,
    );
  }
  protected extraFields() {
    return { providerCode: this.providerCode, providerStatus: this.providerStatus };
  }
}

/** Twilio rate-limited the account (429). */
export class ProviderRateLimitedError extends TwilioToolError {
  readonly code = 'provider_rate_limited';
  readonly httpStatus = 429;
  constructor() {
    super('Twilio rate-limited this account. Do not retry immediately.');
  }
}

/** Network-level failure reaching Twilio (refused, reset, TLS, DNS, 5xx). */
export class UpstreamUnreachableError extends TwilioToolError {
  readonly code = 'upstream_unreachable';
  readonly httpStatus = 502;
  constructor(detail?: string) {
    super(detail ? `Twilio is unreachable: ${detail}` : 'Twilio is unreachable.');
  }
}

/** The total time budget elapsed talking to Twilio. */
export class UpstreamTimeoutError extends TwilioToolError {
  readonly code = 'upstream_timeout';
  readonly httpStatus = 504;
  constructor(public timeoutSeconds: number) {
    super(`The Twilio request timed out after ${timeoutSeconds}s.`);
  }
  protected extraFields() {
    return { timeoutSeconds: this.timeoutSeconds };
  }
}

/**
 * Build a ValidationError from a zod failure — the ONE place the
 * first-issue/path-join convention lives; `field`/`reason` are part of the
 * stable public error contract. Zod issue messages describe expected shapes
 * and never echo received values, so no credential can leak through here.
 */
export function validationFromZod(err: { issues: { path: PropertyKey[]; message: string }[] }): ValidationError {
  const issue = err.issues[0];
  return new ValidationError(issue?.path.map(String).join('.') || 'input', issue?.message ?? 'invalid input');
}
