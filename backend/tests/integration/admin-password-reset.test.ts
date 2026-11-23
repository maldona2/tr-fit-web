import { jest } from '@jest/globals';

// Admin "Resetear contraseña": sends the same 6-digit code the app's
// forgot-password flow sends, but surfaces mail failures to the admin.
const sendReset = jest
  .fn<(email: string, code: string) => Promise<void>>()
  .mockResolvedValue(undefined);
const noop = () =>
  jest.fn<(o: never) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../../src/services/email.service.js', () => ({
  sendOpenAiAccountAlert: async () => {},
  sendAccountApprovedEmail: noop(),
  sendVerifyEmail: noop(),
  sendPasswordResetEmail: sendReset,
  sendCoachPainAlert: noop(),
  sendMembershipExpiringEmail: noop(),
  sendMembershipExpiredEmail: noop(),
  sendCommunityRevisionEmail: noop(),
}));

const { resetDatabase, ensureMigrated, closePool } =
  await import('./helpers/test-db.js');
const { signToken } = await import('../../src/middleware/auth.js');
const { createAdmin, verifiedAthleteUser } =
  await import('./helpers/fixtures.js');
const requestMod = await import('supertest');
const request = requestMod.default;
const appMod = await import('../../src/app.js');
const app = appMod.default;

beforeAll(async () => {
  await ensureMigrated();
});
beforeEach(async () => {
  await resetDatabase();
  sendReset.mockReset();
  sendReset.mockResolvedValue(undefined);
});
afterAll(async () => {
  await closePool();
});

describe('POST /api/admin/users/:id/password-reset', () => {
  it('emails a code that works in the app reset flow', async () => {
    const tok = signToken({ id: await createAdmin(), role: 'admin' });
    const u = await verifiedAthleteUser();

    const r = await request(app)
      .post(`/api/admin/users/${u.id}/password-reset`)
      .set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(200);
    expect(sendReset).toHaveBeenCalledTimes(1);
    const [to, code] = sendReset.mock.calls[0];
    expect(to).toBe(u.email);

    const v = await request(app)
      .post('/api/auth/verify-reset-code')
      .send({ email: u.email, code });
    expect(v.status).toBe(200);
  });

  it('returns 502 when the mail service fails', async () => {
    const tok = signToken({ id: await createAdmin(), role: 'admin' });
    const u = await verifiedAthleteUser();
    sendReset.mockRejectedValue(new Error('mailer down'));

    const r = await request(app)
      .post(`/api/admin/users/${u.id}/password-reset`)
      .set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('email_send_failed');
  });

  it('404s for unknown user', async () => {
    const tok = signToken({ id: await createAdmin(), role: 'admin' });
    const r = await request(app)
      .post('/api/admin/users/00000000-0000-0000-0000-000000000000/password-reset')
      .set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(404);
  });
});
