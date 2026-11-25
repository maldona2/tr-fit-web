export {};
const { resetDatabase, ensureMigrated, closePool } =
  await import('./helpers/test-db.js');
const { signToken } = await import('../../src/middleware/auth.js');
const { createAdmin, signupUserInDb, setMembership } =
  await import('./helpers/fixtures.js');
const poolMod = await import('../../src/db/connect.js');
const pool = poolMod.default;
const requestMod = await import('supertest');
const request = requestMod.default;
const appMod = await import('../../src/app.js');
const app = appMod.default;

beforeAll(async () => {
  await ensureMigrated();
});
beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('POST /api/admin/users/:id/payments', () => {
  it('registers a payment, activates membership, approves user, audits', async () => {
    const adminId = await createAdmin();
    const tok = signToken({ id: adminId, role: 'admin' });
    const { id: athleteId } = await signupUserInDb(
      'payme@test.local',
      'pwd-test-1234',
      true
    );
    await pool.query(`UPDATE users SET status='pending' WHERE id=$1`, [
      athleteId,
    ]);

    const r = await request(app)
      .post(`/api/admin/users/${athleteId}/payments`)
      .set('Authorization', `Bearer ${tok}`)
      .send({
        amount: 25000,
        method: 'transfer',
        paid_at: '2026-06-01',
        period_days: 30,
      });
    expect(r.status).toBe(201);
    expect(r.body.membership.status).toBe('active');

    const user = await pool.query<{ status: string }>(
      `SELECT status FROM users WHERE id=$1`,
      [athleteId]
    );
    expect(user.rows[0].status).toBe('approved');

    const pay = await pool.query(`SELECT * FROM payments WHERE user_id=$1`, [
      athleteId,
    ]);
    expect(pay.rowCount).toBe(1);
    expect(pay.rows[0].recorded_by).toBe(adminId);

    const audit = await pool.query(
      `SELECT 1 FROM admin_audit_log WHERE target_id=$1 AND type='payment_registered'`,
      [athleteId]
    );
    expect(audit.rowCount).toBe(1);
  });

  it('a registered payment lets a previously-pending athlete log in', async () => {
    const adminId = await createAdmin();
    const tok = signToken({ id: adminId, role: 'admin' });
    const email = 'enable-via-pay@test.local';
    const { id: athleteId } = await signupUserInDb(
      email,
      'pwd-test-1234',
      true
    );
    await pool.query(`UPDATE users SET status='pending' WHERE id=$1`, [
      athleteId,
    ]);

    await request(app)
      .post(`/api/admin/users/${athleteId}/payments`)
      .set('Authorization', `Bearer ${tok}`)
      .send({
        amount: 25000,
        method: 'transfer',
        paid_at: '2026-06-01',
        period_days: 30,
      });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'pwd-test-1234' });
    expect(login.status).toBe(200);
  });

  it('accepts period_months 3 and extends three calendar months', async () => {
    const adminId = await createAdmin();
    const tok = signToken({ id: adminId, role: 'admin' });
    const { id: athleteId } = await signupUserInDb(
      'qtr@test.local',
      'pwd-test-1234',
      true
    );
    await pool.query(
      `INSERT INTO memberships (user_id, status, paid_until)
       VALUES ($1, 'active', '2026-12-06T15:00:00.000Z')`,
      [athleteId]
    );

    const r = await request(app)
      .post(`/api/admin/users/${athleteId}/payments`)
      .set('Authorization', `Bearer ${tok}`)
      .send({
        amount: 75000,
        method: 'transfer',
        paid_at: '2026-12-06',
        period_months: 3,
      });
    expect(r.status).toBe(201);
    const until = new Date(r.body.membership.paid_until);
    expect(until.getUTCMonth()).toBe(2);
    expect(until.getUTCDate()).toBe(6);

    const pay = await pool.query<{ period_months: number }>(
      `SELECT period_months FROM payments WHERE user_id=$1`,
      [athleteId]
    );
    expect(pay.rows[0].period_months).toBe(3);
  });

  it('rejects invalid period_months', async () => {
    const adminId = await createAdmin();
    const tok = signToken({ id: adminId, role: 'admin' });
    const { id: athleteId } = await signupUserInDb(
      'badqtr@test.local',
      'pwd-test-1234',
      true
    );
    const r = await request(app)
      .post(`/api/admin/users/${athleteId}/payments`)
      .set('Authorization', `Bearer ${tok}`)
      .send({
        amount: 75000,
        method: 'transfer',
        paid_at: '2026-12-06',
        period_months: 2,
      });
    expect(r.status).toBe(400);
  });

  it('rejects invalid payload', async () => {
    const adminId = await createAdmin();
    const tok = signToken({ id: adminId, role: 'admin' });
    const { id: athleteId } = await signupUserInDb(
      'bad@test.local',
      'pwd-test-1234',
      true
    );
    const r = await request(app)
      .post(`/api/admin/users/${athleteId}/payments`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ amount: -5, method: 'bitcoin' });
    expect(r.status).toBe(400);
  });

  it('non-admin is rejected', async () => {
    const { id: athleteId } = await signupUserInDb(
      'atk@test.local',
      'pwd-test-1234',
      true
    );
    const tok = signToken({ id: athleteId, role: 'athlete' });
    const r = await request(app)
      .post(`/api/admin/users/${athleteId}/payments`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ amount: 1, method: 'transfer', paid_at: '2026-06-01' });
    expect(r.status).toBe(403);
  });

  it('cancel endpoint sets membership cancelled', async () => {
    const adminId = await createAdmin();
    const tok = signToken({ id: adminId, role: 'admin' });
    const { id: athleteId } = await signupUserInDb(
      'cxl@test.local',
      'pwd-test-1234',
      true
    );
    await setMembership(athleteId, 'infinity', 'active');
    const r = await request(app)
      .post(`/api/admin/users/${athleteId}/membership/cancel`)
      .set('Authorization', `Bearer ${tok}`)
      .send({});
    expect(r.status).toBe(200);
    const m = await pool.query<{ status: string }>(
      `SELECT status FROM memberships WHERE user_id=$1`,
      [athleteId]
    );
    expect(m.rows[0].status).toBe('cancelled');
  });

  it('admin user row exposes membership_status and paid_until', async () => {
    const adminId = await createAdmin();
    const tok = signToken({ id: adminId, role: 'admin' });
    const { id: athleteId } = await signupUserInDb(
      'row@test.local',
      'pwd-test-1234',
      true
    );
    await setMembership(
      athleteId,
      new Date(Date.now() + 5 * 86_400_000).toISOString(),
      'expiring'
    );

    const r = await request(app)
      .get(`/api/admin/users/${athleteId}`)
      .set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(200);
    expect(r.body.membership_status).toBe('expiring');
    expect(r.body.paid_until).toBeTruthy();
  });
});
