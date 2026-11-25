export {};
const { resetDatabase, ensureMigrated, closePool } =
  await import('./helpers/test-db.js');
const { createAdmin, createAthlete } = await import('./helpers/fixtures.js');
const poolMod = await import('../../src/db/connect.js');
const pool = poolMod.default;
const { getMembership, registerPayment, cancelMembership, isActive } =
  await import('../../src/services/membership.service.js');

beforeAll(async () => {
  await ensureMigrated();
});
beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('membership.service', () => {
  it('registerPayment creates an active membership, payment row, and approves the user', async () => {
    const admin = await createAdmin();
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, status, email_verified)
       VALUES ($1,'x','athlete','pending',true) RETURNING id`,
      [`rp-${Date.now()}@t.local`]
    );
    const userId = u.rows[0].id;

    const m = await registerPayment(userId, {
      amount: 25000,
      currency: 'ARS',
      method: 'transfer',
      paidAt: '2026-06-01',
      reference: 'transf #1',
      periodDays: 30,
      recordedBy: admin,
    });

    expect(m.status).toBe('active');
    expect(new Date(m.paid_until as string).getTime()).toBeGreaterThan(
      Date.now()
    );

    const pay = await pool.query(`SELECT * FROM payments WHERE user_id = $1`, [
      userId,
    ]);
    expect(pay.rowCount).toBe(1);
    expect(pay.rows[0].amount).toBe('25000.00');

    const user = await pool.query<{ status: string }>(
      `SELECT status FROM users WHERE id = $1`,
      [userId]
    );
    expect(user.rows[0].status).toBe('approved');
  });

  it('registerPayment extends from existing paid_until when still active', async () => {
    const admin = await createAdmin();
    const a = await createAthlete(admin);
    await pool.query(
      `UPDATE memberships SET paid_until = now() + interval '10 days', status='active' WHERE user_id=$1`,
      [a]
    );
    const m = await registerPayment(a, {
      amount: 1,
      method: 'transfer',
      paidAt: '2026-06-01',
      periodDays: 30,
      recordedBy: admin,
    });
    const days =
      (new Date(m.paid_until as string).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(35);
  });

  it('registerPayment with periodMonths 3 extends three calendar months and stores the period', async () => {
    const admin = await createAdmin();
    const a = await createAthlete(admin);
    await pool.query(
      `UPDATE memberships SET paid_until = '2026-12-06T15:00:00.000Z', status='active' WHERE user_id=$1`,
      [a]
    );
    const m = await registerPayment(a, {
      amount: 75000,
      method: 'transfer',
      paidAt: '2026-12-06',
      periodMonths: 3,
      recordedBy: admin,
    });
    const until = new Date(m.paid_until as string);
    expect(until.getUTCFullYear()).toBe(2027);
    expect(until.getUTCMonth()).toBe(2); // March
    expect(until.getUTCDate()).toBe(6);

    const pay = await pool.query<{ amount: string; period_months: number }>(
      `SELECT amount, period_months FROM payments WHERE user_id = $1`,
      [a]
    );
    expect(pay.rows[0].period_months).toBe(3);
    expect(pay.rows[0].amount).toBe('75000.00');
  });

  it('registerPayment on an expired membership renews from now()', async () => {
    const admin = await createAdmin();
    const a = await createAthlete(admin);
    await pool.query(
      `UPDATE memberships SET paid_until = now() - interval '5 days', status='expired' WHERE user_id=$1`,
      [a]
    );
    const m = await registerPayment(a, {
      amount: 1,
      method: 'transfer',
      paidAt: '2026-06-01',
      periodDays: 30,
      recordedBy: admin,
    });
    const days =
      (new Date(m.paid_until as string).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(28);
    expect(days).toBeLessThan(32);
    expect(m.status).toBe('active');
  });

  it('cancelMembership sets cancelled and paid_until=now', async () => {
    const admin = await createAdmin();
    const a = await createAthlete(admin);
    await cancelMembership(a);
    const m = await getMembership(a);
    expect(m!.status).toBe('cancelled');
    expect(isActive(m)).toBe(false);
  });

  it('isActive: infinity is active, past is not, null is not', async () => {
    expect(isActive({ paid_until: Infinity } as never)).toBe(true);
    expect(
      isActive({
        paid_until: new Date(Date.now() + 86_400_000).toISOString(),
      } as never)
    ).toBe(true);
    expect(
      isActive({
        paid_until: new Date(Date.now() - 86_400_000).toISOString(),
      } as never)
    ).toBe(false);
    expect(isActive({ paid_until: null } as never)).toBe(false);
    expect(isActive(null)).toBe(false);
  });
});
