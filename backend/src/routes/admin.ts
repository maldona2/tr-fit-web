import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import pool from '../db/connect.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/role.js';
import {
  registerPayment,
  registerVacation,
  cancelMembership,
  pauseMembership,
  resumeMembership,
  MembershipError,
} from '../services/membership.service.js';
import { forceLogout } from '../services/auth.service.js';
import {
  listUsers,
  getUser,
  updateUser,
  createUser,
  deleteUser,
  upsertManualSubscription,
  cancelSubscription,
  getStats,
  logAudit,
  listActivity,
  setAthleteMonthlyFee,
  listAthleteRms,
  listMissingPrincipalRms,
  setAthleteRm,
  listAthleteWeights,
  setAthleteWeight,
  AdminError,
} from '../services/admin.service.js';
import { getLoggedSessions } from '../services/logged-sessions.service.js';
import { sendAccountApprovedEmail } from '../services/email.service.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(requireAuth, requireAdmin);

async function actorEmail(req: Request): Promise<string> {
  if (!req.user) return 'system';
  const r = await pool.query<{ email: string }>(
    `SELECT email FROM users WHERE id = $1`,
    [req.user.id]
  );
  return r.rows[0]?.email ?? `admin:${req.user.id.slice(0, 8)}`;
}

// Mirrors the login gate in auth.service.ts: an athlete needs BOTH an approved
// status and a live membership. Mailing on the status flip alone promises access
// the login gate still denies.
function canLogIn(
  u: {
    role: string;
    status: string;
    membership_status: string | null;
    paid_until: string | number | null;
  } | null
): boolean {
  if (!u || u.status !== 'approved') return false;
  if (u.role !== 'athlete') return true;
  if (u.membership_status === 'paused' || u.membership_status === 'vacation')
    return false;
  const p = u.paid_until;
  if (p == null) return false;
  if (p === Infinity || p === 'infinity') return true; // sentinel used by fixtures + manual grants
  const t = new Date(p).getTime();
  return Number.isFinite(t) && t + 48 * 3_600_000 > Date.now(); // 48h grace, same as the SQL gate
}

// Only mail when the account *became* usable (before: no login, after: can login).
// A re-save, renewal, or bare status approve without membership never re-sends.
// A dead mailer must not fail the request.
async function notifyApproved(
  before: {
    role: string;
    status: string;
    membership_status: string | null;
    paid_until: string | number | null;
  } | null,
  after: {
    email: string;
    name: string | null;
    role: string;
    status: string;
    membership_status: string | null;
    paid_until: string | number | null;
  } | null
): Promise<void> {
  if (!after || canLogIn(before) || !canLogIn(after)) return;
  try {
    await sendAccountApprovedEmail({
      email: after.email,
      name: after.name ?? 'atleta',
    });
  } catch (e) {
    logger.error(
      { err: e, email: after.email },
      'account approved email failed'
    );
  }
}

router.get('/stats', async (_req: Request, res: Response) => {
  const stats = await getStats();
  res.json(stats);
});

const activityQuery = z.object({
  category: z.enum(['user', 'sub', 'auth']).optional(),
  target_id: z.string().uuid().optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

router.get('/activity', async (req: Request, res: Response) => {
  const parsed = activityQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_query' });
  }
  const rows = await listActivity(parsed.data);
  res.json(rows);
});

const listQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  role: z.enum(['athlete', 'admin', 'superadmin']).optional(),
  search: z.string().trim().min(1).max(120).optional(),
});

router.get('/users', async (req: Request, res: Response) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_query' });
  const users = await listUsers(parsed.data);
  res.json(users);
});

const createBody = z.object({
  email: z.email().max(255),
  password: z.string().min(8).max(128),
  role: z.enum(['athlete', 'admin', 'superadmin']).optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  email_verified: z.boolean().optional(),
});

router.post('/users', async (req: Request, res: Response) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'invalid_payload' });
  try {
    const user = await createUser(parsed.data);
    await logAudit({
      type: 'user_created',
      actor: await actorEmail(req),
      target: user.email,
      target_id: user.id,
      severity: 'brand',
      meta: { role: user.role, status: user.status },
    });
    return res.status(201).json(user);
  } catch (e) {
    if (e instanceof AdminError && e.code === 'email_taken') {
      return res.status(409).json({ error: 'email_already_registered' });
    }
    throw e;
  }
});

router.delete('/users/:id', async (req: Request, res: Response) => {
  if (req.params.id === req.user!.id) {
    return res.status(400).json({ error: 'cannot_delete_self' });
  }
  try {
    const u = await getUser(req.params.id);
    await deleteUser(req.params.id);
    await logAudit({
      type: 'user_deleted',
      actor: await actorEmail(req),
      target: u?.email ?? null,
      target_id: req.params.id,
      severity: 'destructive',
    });
    return res.status(204).end();
  } catch (e) {
    if (e instanceof AdminError && e.code === 'not_found') {
      return res.status(404).json({ error: 'not_found' });
    }
    throw e;
  }
});

router.get('/users/:id', async (req: Request, res: Response) => {
  const u = await getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  res.json(u);
});

// Coach view of an athlete's logged training (dropsets grouped "3-2-1 lad").
router.get('/users/:id/sessions', async (req: Request, res: Response) => {
  const limit = Math.min(
    60,
    Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20)
  );
  res.json(await getLoggedSessions(req.params.id, limit));
});

// Audit trail of the automatic weekly progression: what the cron bumped on each
// run (from/to kg + reps per exercise), so coaches can check it did the right thing.
router.get('/users/:id/progression', async (req: Request, res: Response) => {
  const { rows: runs } = await pool.query<{
    id: string;
    ran_at: string;
    from_week: number;
    to_week: number;
    compliance: number | null;
    weights_bumped: Array<{
      exercise_id: number;
      from_kg: number | null;
      to_kg: number | null;
      reps_from: string | null;
      reps_to: string;
    }>;
    status: string;
    error_message: string | null;
  }>(
    `SELECT id, ran_at, from_week, to_week, compliance,
            weights_bumped, status, error_message
       FROM progression_runs
      WHERE athlete_id = $1
      ORDER BY ran_at DESC
      LIMIT 50`,
    [req.params.id]
  );

  // weights_bumped stores exercise ids only; resolve names for display.
  const ids = [
    ...new Set(runs.flatMap((r) => r.weights_bumped.map((b) => b.exercise_id))),
  ];
  const names = new Map<number, string>();
  if (ids.length) {
    const nameR = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM exercises WHERE id = ANY($1)`,
      [ids]
    );
    for (const e of nameR.rows) names.set(e.id, e.name);
  }

  // Principals follow the periodization (not the cron), so the run never
  // records them. Show what the athlete actually lifted on them that week,
  // taking the role from the skeleton the session was trained on.
  const weeks = [...new Set(runs.map((r) => r.from_week))];
  const principalsByWeek = new Map<
    number,
    Array<{
      exercise_id: number;
      exercise_name: string;
      sets: Array<{ value: number | null; unit: string | null; reps: number }>;
    }>
  >();
  if (weeks.length) {
    const { rows } = await pool.query<{
      week: number;
      exercise_id: number;
      exercise_name: string;
      value: string | null;
      unit: string | null;
      reps: number;
    }>(
      `SELECT sl.week, sl.exercise_id, e.name AS exercise_name,
              COALESCE(sl.value, sl.weight_kg)::text AS value,
              COALESCE(sl.unit, 'kg') AS unit, sl.reps
         FROM set_logs sl
         JOIN session_logs s ON s.id = sl.session_log_id
         JOIN exercises e ON e.id = sl.exercise_id
        WHERE sl.athlete_id = $1
          AND sl.week = ANY($2::int[])
          AND sl.completed AND sl.reps IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM skeleton_slots ss
             WHERE ss.skeleton_id = s.skeleton_id
               AND ss.exercise_id = sl.exercise_id
               AND ss.role = 'principal'
          )
        ORDER BY sl.week, sl.day_of_week, e.name, sl.set_index`,
      [req.params.id, weeks]
    );
    for (const row of rows) {
      const list = principalsByWeek.get(row.week) ?? [];
      let ex = list.find((p) => p.exercise_id === row.exercise_id);
      if (!ex) {
        ex = {
          exercise_id: row.exercise_id,
          exercise_name: row.exercise_name,
          sets: [],
        };
        list.push(ex);
      }
      ex.sets.push({
        value: row.value === null ? null : Number(row.value),
        unit: row.unit,
        reps: row.reps,
      });
      principalsByWeek.set(row.week, list);
    }
  }

  res.json(
    runs.map((r) => ({
      ...r,
      weights_bumped: r.weights_bumped.map((b) => ({
        ...b,
        exercise_name: names.get(b.exercise_id) ?? `#${b.exercise_id}`,
      })),
      principals: principalsByWeek.get(r.from_week) ?? [],
    }))
  );
});

// Log of the automatic exercise rotation (one accessory every 2 program weeks).
router.get('/users/:id/rotations', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.created_at, r.program_week, r.day_of_week, r.muscle_group,
            r.from_exercise_id, fe.name AS from_name,
            r.to_exercise_id, te.name AS to_name
       FROM exercise_rotations r
       JOIN exercises fe ON fe.id = r.from_exercise_id
       JOIN exercises te ON te.id = r.to_exercise_id
      WHERE r.athlete_id = $1
      ORDER BY r.created_at DESC
      LIMIT 50`,
    [req.params.id]
  );
  res.json(rows);
});

// Freeze/unfreeze the automatic rotation for one athlete.
router.get('/users/:id/rotation-lock', async (req: Request, res: Response) => {
  const { rows } = await pool.query<{ exercise_rotation_locked: boolean }>(
    `SELECT exercise_rotation_locked FROM users WHERE id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ locked: rows[0].exercise_rotation_locked });
});

router.put('/users/:id/rotation-lock', async (req: Request, res: Response) => {
  const parsed = z.object({ locked: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  const { rows } = await pool.query<{ exercise_rotation_locked: boolean }>(
    `UPDATE users SET exercise_rotation_locked = $1
      WHERE id = $2 RETURNING exercise_rotation_locked`,
    [parsed.data.locked, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ locked: rows[0].exercise_rotation_locked });
});

const patchBody = z
  .object({
    role: z.enum(['athlete', 'admin', 'superadmin']).optional(),
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
    email_verified: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { error: 'empty_patch' });

router.patch('/users/:id', async (req: Request, res: Response) => {
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'invalid_payload' });

  if (req.params.id === req.user!.id) {
    const me = req.user!;
    const wantsRoleChange =
      parsed.data.role !== undefined && parsed.data.role !== me.role;
    const wantsStatusChange =
      parsed.data.status !== undefined && parsed.data.status !== 'approved';
    if (wantsRoleChange || wantsStatusChange) {
      return res.status(400).json({ error: 'cannot_modify_self' });
    }
  }

  const before = await getUser(req.params.id);
  if (!before) return res.status(404).json({ error: 'not_found' });

  const touchingSuperadmin =
    parsed.data.role === 'superadmin' || before.role === 'superadmin';
  if (touchingSuperadmin && req.user!.role !== 'superadmin') {
    return res.status(403).json({ error: 'superadmin_only' });
  }

  await updateUser(req.params.id, parsed.data);
  const fresh = await getUser(req.params.id);

  const actor = await actorEmail(req);
  const target = fresh?.email ?? before.email;
  const target_id = req.params.id;

  if (parsed.data.status && parsed.data.status !== before.status) {
    if (parsed.data.status === 'approved') {
      await logAudit({
        type: 'user_approved',
        actor,
        target,
        target_id,
        severity: 'brand',
      });
    } else if (parsed.data.status === 'rejected') {
      await logAudit({
        type: 'user_rejected',
        actor,
        target,
        target_id,
        severity: 'destructive',
      });
    }
  }
  if (parsed.data.role && parsed.data.role !== before.role) {
    await logAudit({
      type: 'role_changed',
      actor,
      target,
      target_id,
      severity: 'warning',
      meta: { from: before.role, to: parsed.data.role },
    });
  }
  if (
    parsed.data.email_verified !== undefined &&
    parsed.data.email_verified !== before.email_verified
  ) {
    await logAudit({
      type: parsed.data.email_verified ? 'email_verified' : 'email_unverified',
      actor,
      target,
      target_id,
      severity: parsed.data.email_verified ? 'brand' : 'warning',
    });
  }

  await notifyApproved(before, fresh);
  res.json(fresh);
});

// @deprecated Superseded by POST /users/:id/payments (membership model). The
// tier concept it carries no longer gates anything. Kept until the admin
// dashboard switches to register-payment, then remove.
const subBody = z.object({
  tier: z.enum(['basico', 'full', 'premium']),
  status: z.enum(['pending', 'authorized', 'paused', 'cancelled']),
  current_period_end: z.string().datetime().nullish(),
});

router.put('/users/:id/subscription', async (req: Request, res: Response) => {
  const parsed = subBody.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'invalid_payload' });
  const before = await getUser(req.params.id);
  await upsertManualSubscription(req.params.id, {
    tier: parsed.data.tier,
    status: parsed.data.status,
    current_period_end: parsed.data.current_period_end ?? null,
  });
  const fresh = await getUser(req.params.id);
  const actor = await actorEmail(req);
  const target = fresh?.email ?? before?.email ?? null;
  const target_id = req.params.id;
  const hadSub = !!before?.subscription_tier;
  let type:
    | 'subscription_created'
    | 'subscription_updated'
    | 'subscription_authorized'
    | 'subscription_paused'
    | 'subscription_cancelled';
  let severity: 'brand' | 'warning' | 'destructive' | null = null;
  if (!hadSub) {
    type = 'subscription_created';
    severity = 'brand';
  } else if (parsed.data.status === 'cancelled') {
    type = 'subscription_cancelled';
    severity = 'destructive';
  } else if (parsed.data.status === 'paused') {
    type = 'subscription_paused';
    severity = 'warning';
  } else if (parsed.data.status === 'authorized') {
    type = 'subscription_authorized';
    severity = 'brand';
  } else {
    type = 'subscription_updated';
  }
  await logAudit({
    type,
    actor,
    target,
    target_id,
    severity,
    meta: { tier: parsed.data.tier, status: parsed.data.status },
  });
  res.json(fresh);
});

router.delete(
  '/users/:id/subscription',
  async (req: Request, res: Response) => {
    const before = await getUser(req.params.id);
    await cancelSubscription(req.params.id);
    const fresh = await getUser(req.params.id);
    await logAudit({
      type: 'subscription_cancelled',
      actor: await actorEmail(req),
      target: fresh?.email ?? before?.email ?? null,
      target_id: req.params.id,
      severity: 'destructive',
      meta: { tier: before?.subscription_tier ?? null },
    });
    res.json(fresh);
  }
);

const monthlyFeeBody = z.object({
  monthly_fee_ars: z.number().nonnegative({ error: 'out_of_range' }),
});

router.put('/users/:id/monthly-fee', async (req, res) => {
  const parsed = monthlyFeeBody.safeParse(req.body);
  if (!parsed.success) {
    const outOfRange = parsed.error.issues.some(
      (i) => i.message === 'out_of_range'
    );
    res
      .status(400)
      .json({ error: outOfRange ? 'fee_out_of_range' : 'invalid_payload' });
    return;
  }
  const value = await setAthleteMonthlyFee(
    req.params.id,
    parsed.data.monthly_fee_ars,
    req.user!.id
  );
  res.json({ monthly_fee_ars: value });
});

// ─── Athlete RM (rep-max) — manual/temporal edit ─────────────────
// The coach lowers an athlete's RM during injury/illness so prescribed weights
// drop. Reads engine's value_kg; edit is an upsert into rm_tests. "Temporal" is
// implemented as option (a): a manual value the coach sets and later restores by
// hand (see report). value/note give traceability; no auto-revert scheduling.
router.get('/users/:id/rms', async (req: Request, res: Response) => {
  const user = await getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  res.json({
    rms: await listAthleteRms(req.params.id),
    missing: await listMissingPrincipalRms(req.params.id),
  });
});

const rmBody = z.object({
  exercise_id: z.number().int().positive(),
  program_week: z.union([z.literal(10), z.literal(20), z.literal(30)]),
  value_kg: z.number().positive().max(1000),
  // The form sends null when the coach leaves the note blank. optional()
  // rejects null, so every save without a motivo came back 400.
  coach_note: z.string().max(200).nullish(),
});

router.put('/users/:id/rms', async (req: Request, res: Response) => {
  const parsed = rmBody.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'invalid_payload' });
  const user = await getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  try {
    const row = await setAthleteRm(
      req.params.id,
      {
        exerciseId: parsed.data.exercise_id,
        programWeek: parsed.data.program_week,
        valueKg: parsed.data.value_kg,
        coachNote: parsed.data.coach_note ?? null,
      },
      await actorEmail(req)
    );
    res.json({ rm: row });
  } catch (e) {
    if (e instanceof Error && e.message === 'exercise_not_found') {
      return res.status(404).json({ error: 'exercise_not_found' });
    }
    throw e;
  }
});

// Working weights the session engine prescribes (athlete_exercise_weights).
router.get('/users/:id/weights', async (req: Request, res: Response) => {
  const user = await getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  res.json({ weights: await listAthleteWeights(req.params.id) });
});

const weightBody = z.object({
  exercise_id: z.number().int().positive(),
  current_value: z.number().positive().max(1000),
  scheme: z.enum(['normal', 'dropset']).optional(),
});

router.put('/users/:id/weights', async (req: Request, res: Response) => {
  const parsed = weightBody.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'invalid_payload' });
  const user = await getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  try {
    const row = await setAthleteWeight(
      req.params.id,
      {
        exerciseId: parsed.data.exercise_id,
        currentValue: parsed.data.current_value,
        scheme: parsed.data.scheme,
      },
      await actorEmail(req)
    );
    res.json({ weight: row });
  } catch (e) {
    if (e instanceof Error && e.message === 'exercise_not_found') {
      return res.status(404).json({ error: 'exercise_not_found' });
    }
    throw e;
  }
});

// ─── Membership / manual payments ────────────────────────────────
const paymentBody = z.object({
  // nonnegative, not positive: courtesy athletes have a 0 fee and still need
  // a payment row to get/extend access (it's the only path that grants it).
  amount: z.number().nonnegative(),
  currency: z.string().min(1).max(8).optional(),
  method: z.enum(['transfer', 'cash', 'mercadopago', 'other']),
  paid_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference: z.string().max(200).optional(),
  period_days: z.number().int().min(1).max(366).optional(),
  covers_until: z.string().datetime().optional(),
});

// Register a manual payment: logs it, extends the membership, and ensures the
// account is approved — the single admin "enable / reactivate" action.
router.post('/users/:id/payments', async (req: Request, res: Response) => {
  const parsed = paymentBody.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'invalid_payload' });
  const before = await getUser(req.params.id);
  if (!before) return res.status(404).json({ error: 'not_found' });

  const membership = await registerPayment(req.params.id, {
    amount: parsed.data.amount,
    currency: parsed.data.currency,
    method: parsed.data.method,
    paidAt: parsed.data.paid_at,
    reference: parsed.data.reference ?? null,
    periodDays: parsed.data.period_days,
    coversUntil: parsed.data.covers_until,
    recordedBy: req.user!.id,
  });

  await logAudit({
    type: 'payment_registered',
    actor: await actorEmail(req),
    target: before.email,
    target_id: req.params.id,
    severity: 'brand',
    meta: {
      amount: parsed.data.amount,
      method: parsed.data.method,
      paid_until: membership.paid_until,
    },
  });

  const after = await getUser(req.params.id);
  await notifyApproved(before, after);

  res.status(201).json({ membership });
});

// Kill every active session of a user. Takes effect at the next token refresh
// (access tokens keep working until they expire, ≤15m).
router.post('/users/:id/force-logout', async (req: Request, res: Response) => {
  if (req.params.id === req.user!.id) {
    return res.status(400).json({ error: 'cannot_force_logout_self' });
  }
  const before = await getUser(req.params.id);
  if (!before) return res.status(404).json({ error: 'not_found' });
  await forceLogout(req.params.id);
  await logAudit({
    type: 'force_logout',
    actor: await actorEmail(req),
    target: before.email,
    target_id: req.params.id,
    severity: 'warning',
  });
  res.json({ ok: true });
});

const vacationBody = z.object({
  amount: z.number().nonnegative().optional(),
  currency: z.string().min(1).max(8).optional(),
  method: z.enum(['transfer', 'cash', 'mercadopago', 'other']).optional(),
  paid_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  paid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // false = only move Pagado hasta. true (default) also books the maintenance fee.
  record_payment: z.boolean().optional(),
});

// Vacation hold: block access, charge data-maintenance, set a real paid_until.
// Does not approve the account. A later normal payment brings them back.
router.post(
  '/users/:id/membership/vacation',
  async (req: Request, res: Response) => {
    const parsed = vacationBody.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: 'invalid_payload' });
    const recordPayment = parsed.data.record_payment !== false;
    if (recordPayment && parsed.data.amount == null) {
      return res.status(400).json({ error: 'invalid_payload' });
    }
    const before = await getUser(req.params.id);
    if (!before) return res.status(404).json({ error: 'not_found' });
    if (before.role !== 'athlete') {
      return res.status(409).json({ error: 'not_athlete' });
    }
    try {
      const membership = await registerVacation(req.params.id, {
        amount: parsed.data.amount,
        currency: parsed.data.currency,
        method: parsed.data.method,
        paidAt: parsed.data.paid_at,
        paidUntil: parsed.data.paid_until,
        recordPayment,
        recordedBy: req.user!.id,
      });
      await logAudit({
        type: 'membership_vacation',
        actor: await actorEmail(req),
        target: before.email,
        target_id: req.params.id,
        severity: 'warning',
        meta: {
          amount: recordPayment ? parsed.data.amount : null,
          paid_until: membership.paid_until,
          record_payment: recordPayment,
        },
      });
      return res.json({ membership });
    } catch (e) {
      if (
        e instanceof MembershipError &&
        (e.code === 'invalid_date' || e.code === 'invalid_amount')
      ) {
        return res.status(400).json({ error: e.code });
      }
      throw e;
    }
  }
);

// Freeze a membership (injury/vacation): blocks access, stops the paid clock.
router.post(
  '/users/:id/membership/pause',
  async (req: Request, res: Response) => {
    const before = await getUser(req.params.id);
    if (!before) return res.status(404).json({ error: 'not_found' });
    try {
      const membership = await pauseMembership(req.params.id);
      await logAudit({
        type: 'membership_paused',
        actor: await actorEmail(req),
        target: before.email,
        target_id: req.params.id,
        severity: 'warning',
      });
      return res.json({ membership });
    } catch (e) {
      if (e instanceof MembershipError) {
        return res.status(409).json({ error: 'membership_not_active' });
      }
      throw e;
    }
  }
);

// Unfreeze: credits the paused days back (paid_until shifts by the pause span).
router.post(
  '/users/:id/membership/resume',
  async (req: Request, res: Response) => {
    const before = await getUser(req.params.id);
    if (!before) return res.status(404).json({ error: 'not_found' });
    try {
      const membership = await resumeMembership(req.params.id);
      await logAudit({
        type: 'membership_resumed',
        actor: await actorEmail(req),
        target: before.email,
        target_id: req.params.id,
        severity: 'brand',
        meta: { paid_until: membership.paid_until },
      });
      return res.json({ membership });
    } catch (e) {
      if (e instanceof MembershipError) {
        return res.status(409).json({ error: 'membership_not_paused' });
      }
      throw e;
    }
  }
);

router.post(
  '/users/:id/membership/cancel',
  async (req: Request, res: Response) => {
    const before = await getUser(req.params.id);
    if (!before) return res.status(404).json({ error: 'not_found' });
    await cancelMembership(req.params.id);
    await logAudit({
      type: 'membership_cancelled',
      actor: await actorEmail(req),
      target: before.email,
      target_id: req.params.id,
      severity: 'destructive',
    });
    res.json({ ok: true });
  }
);

export default router;
