import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendSms, SEND_TIMEOUT_MS, TWILIO_API_BASE, type TwilioDeps } from './twilio.js';

const CREDS = { accountSid: 'AC' + 'a'.repeat(32), authToken: 'secret-token', from: '+15005550006' };
const MSG = { to: '+15551234567', body: 'hello' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function depsReturning(res: Response): TwilioDeps & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return res;
    }) as typeof fetch,
  };
}

describe('sendSms', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('POSTs form-encoded To/Body/From with HTTP Basic auth and returns sid/status', async () => {
    const deps = depsReturning(jsonResponse(201, { sid: 'SM123', status: 'queued' }));
    const result = await sendSms(CREDS, MSG, deps);
    expect(result).toEqual({ sid: 'SM123', status: 'queued' });

    const call = deps.calls[0];
    expect(call.url).toBe(`${TWILIO_API_BASE}/Accounts/${CREDS.accountSid}/Messages.json`);
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from(`${CREDS.accountSid}:${CREDS.authToken}`).toString('base64')}`,
    );
    const form = new URLSearchParams(String(call.init.body));
    expect(form.get('To')).toBe(MSG.to);
    expect(form.get('Body')).toBe(MSG.body);
    expect(form.get('From')).toBe(CREDS.from);
    expect(form.get('MessagingServiceSid')).toBeNull();
  });

  it('uses MessagingServiceSid when the credentials carry one', async () => {
    const deps = depsReturning(jsonResponse(201, { sid: 'SM1', status: 'queued' }));
    await sendSms({ accountSid: CREDS.accountSid, authToken: CREDS.authToken, messagingServiceSid: 'MG123' }, MSG, deps);
    const form = new URLSearchParams(String(deps.calls[0].init.body));
    expect(form.get('MessagingServiceSid')).toBe('MG123');
    expect(form.get('From')).toBeNull();
  });

  it('maps 401/403 to provider_unauthorized', async () => {
    for (const status of [401, 403]) {
      const deps = depsReturning(jsonResponse(status, { code: 20003, message: 'Authenticate' }));
      await expect(sendSms(CREDS, MSG, deps)).rejects.toMatchObject({
        code: 'provider_unauthorized',
        providerStatus: status,
      });
    }
  });

  it('maps 429 to provider_rate_limited', async () => {
    const deps = depsReturning(jsonResponse(429, { code: 20429, message: 'Too many requests' }));
    await expect(sendSms(CREDS, MSG, deps)).rejects.toMatchObject({ code: 'provider_rate_limited' });
  });

  it('maps a Twilio 400 envelope to provider_rejected with the Twilio code', async () => {
    const deps = depsReturning(
      jsonResponse(400, { code: 21211, message: "The 'To' number is not a valid phone number.", status: 400 }),
    );
    await expect(sendSms(CREDS, MSG, deps)).rejects.toMatchObject({
      code: 'provider_rejected',
      providerCode: 21211,
      providerStatus: 400,
    });
  });

  it('maps Twilio 5xx to upstream_unreachable', async () => {
    const deps = depsReturning(jsonResponse(503, {}));
    await expect(sendSms(CREDS, MSG, deps)).rejects.toMatchObject({ code: 'upstream_unreachable' });
  });

  it('maps a network failure to upstream_unreachable', async () => {
    const deps: TwilioDeps = {
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    };
    await expect(sendSms(CREDS, MSG, deps)).rejects.toMatchObject({ code: 'upstream_unreachable' });
  });

  it('maps an unexpected success shape (no sid) to upstream_unreachable', async () => {
    const deps = depsReturning(jsonResponse(201, { unexpected: true }));
    await expect(sendSms(CREDS, MSG, deps)).rejects.toMatchObject({ code: 'upstream_unreachable' });
  });

  it('maps the elapsed time budget to upstream_timeout', async () => {
    vi.useFakeTimers();
    const deps: TwilioDeps = {
      fetchImpl: ((_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as typeof fetch,
    };
    const pending = sendSms(CREDS, MSG, deps);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'upstream_timeout' });
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1);
    await assertion;
  });

  it('never includes the auth token in thrown error messages', async () => {
    const deps = depsReturning(jsonResponse(400, { code: 21211, message: 'bad number' }));
    const err = await sendSms(CREDS, MSG, deps).catch((e: Error) => e);
    expect(String(err)).not.toContain(CREDS.authToken);
    expect(JSON.stringify((err as { toBody?: () => unknown }).toBody?.() ?? {})).not.toContain(CREDS.authToken);
  });
});
