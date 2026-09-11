import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prepareSchema, uniq } from './setup.js';

const app = createApp();

/**
 * Security behaviours that are easy to regress because nothing visibly breaks
 * when they do.
 */
describe('authentication', () => {
  beforeAll(async () => {
    await prepareSchema();
  }, 60_000);

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: `${uniq('nobody')}@example.test`, password: 'whatever-password' });

    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ email: 'demo@devscout.dev', password: 'definitely-not-the-password' });

    // Differing responses would turn login into an account-enumeration oracle.
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body.error).toBe(wrong.body.error);
  });

  it('rejects a forged session token', async () => {
    await request(app)
      .get('/api/auth/session')
      .set('Cookie', 'devscout_session=not.a.real.jwt')
      .expect(401);
  });

  it('never returns a password hash', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'demo@devscout.dev', password: 'devscout-demo' });

    if (res.status !== 200) return; // demo data not seeded here
    const cookie = (res.headers['set-cookie'] as unknown as string[]).join('; ');
    const session = await request(app).get('/api/auth/session').set('Cookie', cookie).expect(200);

    expect(JSON.stringify(session.body)).not.toMatch(/password/i);
    expect(JSON.stringify(session.body)).not.toMatch(/\$2[aby]\$/); // bcrypt prefix
  });

  it('sets the session cookie httpOnly so script cannot read it', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'demo@devscout.dev', password: 'devscout-demo' });
    if (res.status !== 200) return;

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith('devscout_session='));
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite/i);
  });

  it('enforces a minimum password length at registration', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: `${uniq('short')}@example.test`, password: 'short' });

    expect(res.status).toBe(400);
  });
});

describe('input validation', () => {
  it('rejects a malformed GitHub login instead of passing it to the API', async () => {
    const res = await request(app).get('/api/candidates/not%20a%20valid%20login');
    // 401 (no session) or 400 (bad input) are both correct; a 500 is not.
    expect([400, 401]).toContain(res.status);
  });

  it('answers a 404 with JSON rather than an HTML error page', async () => {
    const res = await request(app).get('/api/definitely-not-a-route').expect(404);
    expect(res.body).toHaveProperty('error');
    expect(res.body.code).toBe('not_found');
  });

  it('returns a correlatable request id on every response', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('echoes a caller-supplied request id so traces join up', async () => {
    const res = await request(app).get('/api/health').set('x-request-id', 'trace-me-123');
    expect(res.headers['x-request-id']).toBe('trace-me-123');
  });
});

describe('security headers', () => {
  it('sets a content security policy and denies framing', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['content-security-policy']).toBeTruthy();
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
  });

  it('does not advertise the server framework', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('cron endpoints', () => {
  it('refuses an unauthenticated drain', async () => {
    const res = await request(app).post('/api/cron/drain');
    expect([401, 503]).toContain(res.status);
  });

  it('refuses a wrong secret', async () => {
    const res = await request(app)
      .post('/api/cron/drain')
      .set('Authorization', 'Bearer definitely-wrong-secret');
    expect([401, 503]).toContain(res.status);
  });
});
