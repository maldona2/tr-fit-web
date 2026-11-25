import pool from '../db/connect.js';
import type { Membership, PaymentMethod } from '../domain/types.js';

export const GRACE_DAYS = 7;
export const GRACE_HOURS = 48;
export const DEFAULT_PERIOD_DAYS = 30;

/**
 * Advance `base` by one calendar month, preserving the day-of-month and
 * clamping to the target month's last day when it is shorter.
 *
 * Renewals are calendar-month based (the coach quotes "6/07 → 6/08"), not
 * +30 days — 30 days would drift a day earlier every cycle (6/07 → 5/08 …).
 * Edge cases: Jan 31 → Feb 28 (or Feb 29 in a leap year); Aug 31 → Sep 30.
 * Time-of-day (h/m/s/ms) is preserved so paid_until keeps its original clock.
 */
export function addCalendarMonth(base: Date, months = 1): Date {
  const y = base.getFullYear();
  const m = base.getMonth();
  const d = base.getDate();
  // Day 0 of (month+months+1) is the last day of the target month → clamp.
  const lastDayOfTarget = new Date(y, m + months + 1, 0).getDate();
  const result = new Date(base);
  result.setFullYear(y, m + months, Math.min(d, lastDayOfTarget));
  return result;
}

/** Access gate: paid_until + 48h grace still grants access. */
export function isActiveWithGrace(
  paidUntil: string | number | null | undefined,
  now: number = Date.now()
): boolean {
  if (paidUntil == null) return false;
  if (paidUntil === Infinity || paidUntil === 'infinity') return true;
  return new Date(paidUntil).getTime() + GRACE_HOURS * 3_600_000 > now;
}

/** A membership grants access iff paid_until is in the future ('infinity' counts). */
export function isActive(m: Pick<Membership, 'paid_until'> | null): boolean {
  if (!m || m.paid_until == null) return false;
  // node-postgres parses 'infinity'::timestamptz to the JS number Infinity.
  if (m.paid_until === Infinity || m.paid_until === 'infinity') return true;
  return new Date(m.paid_until).getTime() > Date.now();
}

export async function getMembership(
  userId: string
): Promise<Membership | null> {
  const r = await pool.query<Membership>(
    `SELECT * FROM memberships WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] ?? null;
}

export const PERIOD_MONTHS = [1, 3, 6, 12] as const;
export type PeriodMonths = (typeof PERIOD_MONTHS)[number];

export function isPeriodMonths(n: number): n is PeriodMonths {
  return (PERIOD_MONTHS as readonly number[]).includes(n);
}

export interface RegisterPaymentInput {
  amount: number;
  currency?: string;
  method: PaymentMethod;
  paidAt: string; // 'YYYY-MM-DD'
  reference?: string | null;
  periodDays?: number; // default 30; ignored if coversUntil or periodMonths given
  /** 1 = monthly, 3 = quarterly, 6 = semiannual, 12 = annual. */
  periodMonths?: PeriodMonths;
  coversUntil?: string; // explicit ISO end; overrides periodDays / periodMonths
  recordedBy?: string | null;
}

/**
 * Records a payment, extends/creates the membership, and ensures the user is
 * approved — the single admin "enable / reactivate" operation. Transactional.
 */
export async function registerPayment(
  userId: string,
  input: RegisterPaymentInput
): Promise<Membership> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query<{
      paid_until: string | number | null;
      status: string;
    }>(
      `SELECT paid_until, status FROM memberships WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    // Extend from the later of current paid_until or now() (renewal vs top-up).
    // Vacation coverage is data-maintenance, not prepaid training: the cuota
    // that brings them back starts today even if "pagado hasta" is still ahead.
    const base = (() => {
      const row = existing.rows[0];
      if (row?.status === 'vacation') return new Date();
      const cur = row?.paid_until;
      if (cur != null && cur !== Infinity && cur !== 'infinity') {
        const t = new Date(cur).getTime();
        if (t > Date.now()) return new Date(t);
      }
      return new Date();
    })();

    // Extension policy (from `base` = later of current expiry or now):
    //   1. explicit coversUntil  → use as-is
    //   2. periodMonths (1/3/6/12) → +N calendar months (promo / prepaid)
    //   3. explicit periodDays   → +N days (custom-period callers, unchanged)
    //   4. default               → +1 calendar month (same day next month,
    //      clamped) so renewals track the calendar, e.g. 6/07 → 6/08.
    const periodMonths = input.periodMonths ?? 1;
    const coversUntil = input.coversUntil
      ? new Date(input.coversUntil)
      : input.periodMonths != null
        ? addCalendarMonth(base, input.periodMonths)
        : input.periodDays != null
          ? new Date(base.getTime() + input.periodDays * 86_400_000)
          : addCalendarMonth(base);

    await client.query(
      `INSERT INTO payments (user_id, paid_at, amount, currency, method, reference, covers_until, recorded_by, period_months)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        userId,
        input.paidAt,
        input.amount,
        input.currency ?? 'ARS',
        input.method,
        input.reference ?? null,
        coversUntil.toISOString(),
        input.recordedBy ?? null,
        periodMonths,
      ]
    );

    const m = await client.query<Membership>(
      `INSERT INTO memberships (user_id, status, started_at, paid_until, updated_at)
       VALUES ($1, 'active', now(), $2, now())
       ON CONFLICT (user_id) DO UPDATE
         SET status = 'active', paid_until = $2, paused_at = NULL, updated_at = now()
       RETURNING *`,
      [userId, coversUntil.toISOString()]
    );

    await client.query(`UPDATE users SET status = 'approved' WHERE id = $1`, [
      userId,
    ]);

    // Auto-resolve open billing alerts for this athlete (renewal clears them).
    await client.query(
      `UPDATE coach_alerts
          SET resolved_at = now()
        WHERE athlete_id = $1
          AND type IN ('membership_expiring','membership_overdue')
          AND resolved_at IS NULL`,
      [userId]
    );

    await client.query('COMMIT');
    return m.rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export class MembershipError extends Error {
  constructor(
    public code: 'not_active' | 'not_paused' | 'invalid_date' | 'invalid_amount'
  ) {
    super(code);
  }
}

/**
 * Calendar date YYYY-MM-DD stored as noon in Argentina (UTC-3, no DST) so the
 * admin "Vence el" column shows that same day.
 */
export function paidUntilOnCalendarDate(isoDate: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new MembershipError('invalid_date');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d, 15, 0, 0));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    throw new MembershipError('invalid_date');
  }
  return dt;
}

export interface RegisterVacationInput {
  /** Required when recordPayment is true. */
  amount?: number;
  currency?: string;
  method?: PaymentMethod;
  /** 'YYYY-MM-DD'. Defaults to today in Argentina. */
  paidAt?: string;
  /** 'YYYY-MM-DD' the coach picked as Pagado hasta. */
  paidUntil: string;
  recordPayment: boolean;
  recordedBy?: string | null;
}

/**
 * Put an athlete on vacation: block access, keep a real paid_until so they
 * sort with the other vencimientos, and optionally book the maintenance fee.
 * Does not approve the account — a rejected athlete stays rejected.
 */
export async function registerVacation(
  userId: string,
  input: RegisterVacationInput
): Promise<Membership> {
  const until = paidUntilOnCalendarDate(input.paidUntil);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (input.recordPayment) {
      if (
        input.amount == null ||
        !Number.isFinite(input.amount) ||
        input.amount < 0
      ) {
        throw new MembershipError('invalid_amount');
      }
      const paidAt =
        input.paidAt ??
        new Date().toLocaleDateString('en-CA', {
          timeZone: 'America/Argentina/Buenos_Aires',
        });
      await client.query(
        `INSERT INTO payments
           (user_id, paid_at, amount, currency, method, reference, covers_until, recorded_by, kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'vacation')`,
        [
          userId,
          paidAt,
          input.amount,
          input.currency ?? 'ARS',
          input.method ?? 'transfer',
          'Mantenimiento de datos',
          until.toISOString(),
          input.recordedBy ?? null,
        ]
      );
    }

    const m = await client.query<Membership>(
      `INSERT INTO memberships (user_id, status, started_at, paid_until, paused_at, updated_at)
       VALUES ($1, 'vacation', now(), $2, NULL, now())
       ON CONFLICT (user_id) DO UPDATE
         SET status = 'vacation', paid_until = $2, paused_at = NULL, updated_at = now()
       RETURNING *`,
      [userId, until.toISOString()]
    );

    await client.query('COMMIT');
    return m.rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Freeze a membership (injury/vacation): access is denied while paused and the
 * clock stops — resumeMembership() credits the paused days back.
 */
export async function pauseMembership(userId: string): Promise<Membership> {
  const r = await pool.query<Membership>(
    `UPDATE memberships
        SET status = 'paused', paused_at = now(), updated_at = now()
      WHERE user_id = $1 AND status IN ('active', 'expiring')
      RETURNING *`,
    [userId]
  );
  if (!r.rows[0]) throw new MembershipError('not_active');
  return r.rows[0];
}

/** Unfreeze: shift paid_until by the paused duration and restore access. */
export async function resumeMembership(userId: string): Promise<Membership> {
  const r = await pool.query<Membership>(
    `UPDATE memberships
        SET paid_until = CASE
              WHEN paid_until = 'infinity' THEN paid_until
              ELSE paid_until + (now() - COALESCE(paused_at, now()))
            END,
            status = 'active', paused_at = NULL, updated_at = now()
      WHERE user_id = $1 AND status = 'paused'
      RETURNING *`,
    [userId]
  );
  if (!r.rows[0]) throw new MembershipError('not_paused');
  return r.rows[0];
}

export async function cancelMembership(userId: string): Promise<void> {
  await pool.query(
    `UPDATE memberships SET status = 'cancelled', paid_until = now(), updated_at = now()
      WHERE user_id = $1`,
    [userId]
  );
}
