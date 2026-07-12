import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import type { TwilioDeps } from '../twilio.js';

const TOKEN = 'test-service-token';
const PLATFORM = { accountSid: 'AC' + 'b'.repeat(32), authToken: 'platform-secret', from: '+15005550006' };
const INLINE = { accountSid: 'AC' + 'c'.repeat(32), authToken: 'inline-secret', from: '+15005550001' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Fake deps: records every upstream call, returns the canned response.
 * `opts.platformAccount` distinguishes "omitted" (defaults to PLATFORM)
 * from "explicitly none" — a bare `undefined` positional would silently
 * re-trigger the default.
 */
function fakeDeps(
  res: Response = jsonResponse(201, { sid: 'SM123', status: 'queued' }),
  opts: { platformAccount?: TwilioDeps['platformAccount'] } = { platformAccount: PLATFORM },
): TwilioDeps & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    platformAccount: opts.platformAccount,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return res;
    }) as typeof fetch,
  };
}

function appWith(deps: TwilioDeps) {
  return createApp({ twilioDeps: deps, serviceToken: TOKEN });
}

const send = (app: ReturnType<typeof createApp>, body: unknown) =>
  request(app).post('/ops/send-sms').set('authorization', `Bearer ${TOKEN}`).send(body as object);

describe('auth gate', () => {
  it('answers 401 without a bearer on /ops and /info', async () => {
    const app = appWith(fakeDeps());
    await request(app).post('/ops/send-sms').send({}).expect(401);
    await request(app).get('/info').expect(401);
  });

  it('answers 401 with a wrong bearer', async () => {
    const app = appWith(fakeDeps());
    await request(app).post('/ops/send-sms').set('authorization', 'Bearer nope').send({}).expect(401);
  });

  it('keeps /healthz and /readyz public', async () => {
    const app = appWith(fakeDeps());
    await request(app).get('/healthz').expect(200);
    await request(app).get('/readyz').expect(200);
  });

  it('/info advertises the operations with a valid bearer', async () => {
    const app = appWith(fakeDeps());
    const res = await request(app).get('/info').set('authorization', `Bearer ${TOKEN}`).expect(200);
    expect(res.body.name).toBe('hadrontool-twilio');
    expect(res.body.operations).toEqual(['send-sms']);
    expect(res.body.stateless).toBe(true);
  });
});

describe('routing', () => {
  it('answers 404 unknown_operation for an unregistered op', async () => {
    const app = appWith(fakeDeps());
    const res = await request(app)
      .post('/ops/receive-sms')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({})
      .expect(404);
    expect(res.body.error).toBe('unknown_operation');
    expect(res.body.operations).toEqual(['send-sms']);
  });
});

describe('send-sms validation', () => {
  it.each([
    [{ body: 'hi' }, 'missing to'],
    [{ to: '15551234567', body: 'hi' }, 'not E.164 (no plus)'],
    [{ to: '+05551234567', body: 'hi' }, 'not E.164 (leading zero)'],
    [{ to: '+15551234567', body: '' }, 'empty body'],
    [{ to: '+15551234567', body: 'x'.repeat(1601) }, 'body over 1600 chars'],
    [{ to: '+15551234567', body: 'hi', extra: true }, 'unknown field (.strict)'],
    [{ to: '+15551234567', body: 'hi', accountSid: 'not-a-sid', authToken: 't', from: '+15005550001' }, 'bad accountSid'],
  ])('rejects %j (%s) as validation_error', async (payload) => {
    const deps = fakeDeps();
    const res = await send(appWith(deps), payload).expect(400);
    expect(res.body.error).toBe('validation_error');
    expect(deps.calls).toHaveLength(0); // guard fires before any upstream call
  });

  it.each([
    [{ ...{}, accountSid: INLINE.accountSid }, 'accountSid without authToken'],
    [{ authToken: INLINE.authToken, from: INLINE.from }, 'authToken without accountSid'],
    [{ accountSid: INLINE.accountSid, authToken: INLINE.authToken }, 'inline creds without sender'],
    [{ ...INLINE, messagingServiceSid: 'MG1' }, 'both from and messagingServiceSid'],
  ])('rejects partial inline credentials %j (%s)', async (inline) => {
    const deps = fakeDeps();
    const res = await send(appWith(deps), { to: '+15551234567', body: 'hi', ...inline }).expect(400);
    expect(res.body.error).toBe('validation_error');
    expect(deps.calls).toHaveLength(0);
  });
});

describe('send-sms credential resolution', () => {
  it('sends via the platform account by default', async () => {
    const deps = fakeDeps();
    const res = await send(appWith(deps), { to: '+15551234567', body: 'hi' }).expect(200);
    expect(res.body).toEqual({ ok: true, sid: 'SM123', status: 'queued' });
    const headers = deps.calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from(`${PLATFORM.accountSid}:${PLATFORM.authToken}`).toString('base64')}`,
    );
    expect(deps.calls[0].url).toContain(PLATFORM.accountSid);
  });

  it('a platform messagingServiceSid account sends MessagingServiceSid', async () => {
    const deps = fakeDeps(jsonResponse(201, { sid: 'SM9', status: 'queued' }), {
      platformAccount: {
        accountSid: PLATFORM.accountSid,
        authToken: PLATFORM.authToken,
        messagingServiceSid: 'MG777',
      },
    });
    await send(appWith(deps), { to: '+15551234567', body: 'hi' }).expect(200);
    const form = new URLSearchParams(String(deps.calls[0].init.body));
    expect(form.get('MessagingServiceSid')).toBe('MG777');
    expect(form.get('From')).toBeNull();
  });

  it('inline credentials override the platform account (the BYO seam)', async () => {
    const deps = fakeDeps();
    await send(appWith(deps), { to: '+15551234567', body: 'hi', ...INLINE }).expect(200);
    const headers = deps.calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from(`${INLINE.accountSid}:${INLINE.authToken}`).toString('base64')}`,
    );
    expect(deps.calls[0].url).toContain(INLINE.accountSid);
  });

  it('answers provider_not_configured when no platform account and no inline creds', async () => {
    const deps = fakeDeps(jsonResponse(201, { sid: 'SM1', status: 'queued' }), {});
    const res = await send(appWith(deps), { to: '+15551234567', body: 'hi' }).expect(503);
    expect(res.body.error).toBe('provider_not_configured');
    expect(deps.calls).toHaveLength(0);
  });

  it('inline creds still work when no platform account is configured', async () => {
    const deps = fakeDeps(jsonResponse(201, { sid: 'SM2', status: 'queued' }), {});
    const res = await send(appWith(deps), { to: '+15551234567', body: 'hi', ...INLINE }).expect(200);
    expect(res.body.sid).toBe('SM2');
  });
});

describe('send-sms error mapping', () => {
  it.each([
    [401, { code: 20003, message: 'Authenticate' }, 502, 'provider_unauthorized'],
    [429, { code: 20429, message: 'Too many requests' }, 429, 'provider_rate_limited'],
    [400, { code: 21211, message: 'Invalid To number' }, 502, 'provider_rejected'],
    [503, {}, 502, 'upstream_unreachable'],
  ])('Twilio %i %j → HTTP %i %s', async (twilioStatus, twilioBody, httpStatus, code) => {
    const deps = fakeDeps(jsonResponse(twilioStatus, twilioBody));
    const res = await send(appWith(deps), { to: '+15551234567', body: 'hi' }).expect(httpStatus);
    expect(res.body.error).toBe(code);
  });

  it('provider_rejected carries the Twilio error code for the caller', async () => {
    const deps = fakeDeps(jsonResponse(400, { code: 21211, message: 'Invalid To number', status: 400 }));
    const res = await send(appWith(deps), { to: '+15551234567', body: 'hi' }).expect(502);
    expect(res.body.providerCode).toBe(21211);
  });

  it('a network failure maps to upstream_unreachable', async () => {
    const deps: TwilioDeps = {
      platformAccount: PLATFORM,
      fetchImpl: (async () => {
        throw new Error('ECONNRESET');
      }) as typeof fetch,
    };
    const res = await send(appWith(deps), { to: '+15551234567', body: 'hi' }).expect(502);
    expect(res.body.error).toBe('upstream_unreachable');
  });
});

describe('credential and body non-leak', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('never echoes credentials or the message body in error responses or logs', async () => {
    const logLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logLines.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => void logLines.push(String(line)));

    const secretBody = 'super-secret-message-body';
    const deps = fakeDeps(jsonResponse(400, { code: 21610, message: 'Unsubscribed recipient' }));
    const res = await send(appWith(deps), { to: '+15551234567', body: secretBody, ...INLINE }).expect(502);

    const everything = JSON.stringify(res.body) + logLines.join('\n');
    expect(everything).not.toContain(INLINE.authToken);
    expect(everything).not.toContain(PLATFORM.authToken);
    expect(everything).not.toContain(secretBody);
    expect(everything).not.toContain('+15551234567');
  });
});
