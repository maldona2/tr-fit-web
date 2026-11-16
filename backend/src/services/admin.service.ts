import bcrypt from 'bcrypt';
import pool from '../db/connect.js';
import {
  DEFAULT_UNIT_BY_EQUIPMENT,
  resolveUnit,
  type Unit,
} from './equipment-units.service.js';
import { FEE_EXPR } from './platform-fee.service.js';
import { deleteUserCommunityMedia } from './community-media.service.js';

const BCRYPT_COST = 10;

export class AdminError extends Error {
  constructor(public code: 'email_taken' | 'not_found' | 'cannot_modify_self') {
    super(code);
  }
}

export type Role = 'athlete' | 'admin' | 'superadmin';
export type UserStatus = 'pending' | 'approved' | 'rejected';
export type SubTier = 'basico' | 'full' | 'premium';
export type SubStatus = 'pending' | 'authorized' | 'paused' | 'cancelled';

export interface AdminUserRow {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  email_verified: boolean;
  email_verified_at: string | null;
  created_at: string;
  name: string | null;
  phone: string | null;
  subscription_tier: SubTier | null;
  subscription_status: SubStatus | null;
  current_period_end: string | null;
  membership_status:
    | 'active'
    | 'expiring'
    | 'expired'
    | 'cancelled'
    | 'paused'
    | 'vacation'
    | null;
  paid_until: string | number | null;
  monthly_fee_ars: number | null;
  last_session_at: string | null;
  days_per_week: number | null;
  days_specific: string[] | null;
  injuries: string[] | null;
  profile: AdminAthleteProfile | null;
}

export interface AdminAthleteProfile {
  name: string;
  gender: 'male' | 'female' | 'other';
  age: number;
  height_cm: number;
  weight_kg: number;
  level: string;
  goal: string;
  days_per_week: number;
  days_specific: string[] | null;
  equipment: string;
  injuries: string[];
  exercise_minutes: number | null;
  sport_focus: string | null;
}

export interface ListFilters {
  status?: UserStatus;
  role?: Role;
  search?: string;
}

export function buildListUsersSql(whereSql: string): string {
  return `
    SELECT
      u.id, u.email, u.role, u.status, u.email_verified, u.email_verified_at,
      u.created_at,
      COALESCE(
        ap.name,
        cp.name,
        NULLIF(CONCAT_WS(' ', u.first_name, u.last_name), '')
      ) AS name,
      COALESCE(ap.phone, u.phone) AS phone,
      COALESCE(u.monthly_fee_ars, ap.monthly_fee_ars) AS monthly_fee_ars,
      s.tier AS subscription_tier,
      s.status AS subscription_status,
      s.current_period_end,
      mem.status AS membership_status,
      mem.paid_until AS paid_until,
      (
        SELECT MAX(started_at) FROM session_logs
          WHERE athlete_id = u.id
      ) AS last_session_at
    FROM users u
    LEFT JOIN athlete_profiles ap ON ap.user_id = u.id
    LEFT JOIN coach_profiles cp ON cp.user_id = u.id
    LEFT JOIN memberships mem ON mem.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT tier, status, current_period_end
        FROM subscriptions
       WHERE athlete_id = u.id
       ORDER BY created_at DESC
       LIMIT 1
    ) s ON TRUE
    ${whereSql}
    ORDER BY u.created_at DESC
    LIMIT 500
  `;
}

export async function listUsers(filters: ListFilters): Promise<AdminUserRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    params.push(filters.status);
    where.push(`u.status = $${params.length}`);
  }
  if (filters.role) {
    params.push(filters.role);
    where.push(`u.role = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search.toLowerCase()}%`);
    where.push(`LOWER(u.email) LIKE $${params.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = buildListUsersSql(whereSql);
  const r = await pool.query<AdminUserRow>(sql, params);
  // pg returns NUMERIC as string; normalize so the frontend feeOf math works.
  return r.rows.map((row) => ({
    ...row,
    monthly_fee_ars:
      row.monthly_fee_ars == null ? null : Number(row.monthly_fee_ars),
  }));
}

type AdminUserQueryRow = Omit<AdminUserRow, 'profile'> & {
  gender: AdminAthleteProfile['gender'] | null;
  age: number | null;
  height_cm: number | null;
  weight_kg: string | number | null;
  level: string | null;
  goal: string | null;
  equipment: string | null;
  exercise_minutes: number | null;
  sport_focus: string | null;
  profile_name: string | null;
};

export async function getUser(id: string): Promise<AdminUserRow | null> {
  const r = await pool.query<AdminUserQueryRow>(
    `SELECT
       u.id, u.email, u.role, u.status, u.email_verified, u.email_verified_at,
       u.created_at,
       COALESCE(
         ap.name,
         cp.name,
         NULLIF(CONCAT_WS(' ', u.first_name, u.last_name), '')
       ) AS name,
       COALESCE(ap.phone, u.phone) AS phone,
       COALESCE(u.monthly_fee_ars, ap.monthly_fee_ars) AS monthly_fee_ars,
       s.tier AS subscription_tier,
       s.status AS subscription_status,
       s.current_period_end,
       mem.status AS membership_status,
       mem.paid_until AS paid_until,
       ap.days_per_week,
       ap.days_specific,
       ap.injuries,
       ap.gender,
       ap.age,
       ap.height_cm,
       ap.weight_kg,
       ap.level,
       ap.goal,
       ap.equipment,
       ap.exercise_minutes,
       ap.sport_focus,
       ap.name AS profile_name,
       (
         SELECT MAX(started_at) FROM session_logs
           WHERE athlete_id = u.id
       ) AS last_session_at
     FROM users u
     LEFT JOIN athlete_profiles ap ON ap.user_id = u.id
     LEFT JOIN coach_profiles cp ON cp.user_id = u.id
     LEFT JOIN memberships mem ON mem.user_id = u.id
     LEFT JOIN LATERAL (
       SELECT tier, status, current_period_end
         FROM subscriptions
        WHERE athlete_id = u.id
        ORDER BY created_at DESC
        LIMIT 1
     ) s ON TRUE
     WHERE u.id = $1`,
    [id]
  );
  const row = r.rows[0];
  if (!row) return null;
  const {
    profile_name,
    gender,
    age,
    height_cm,
    weight_kg,
    level,
    goal,
    equipment,
    exercise_minutes,
    sport_focus,
    ...rest
  } = row;
  const profile: AdminAthleteProfile | null =
    gender &&
    age != null &&
    height_cm != null &&
    weight_kg != null &&
    level &&
    goal &&
    equipment &&
    rest.days_per_week != null
      ? {
          name: profile_name ?? rest.name ?? '',
          gender,
          age: Number(age),
          height_cm: Number(height_cm),
          weight_kg: Number(weight_kg),
          level,
          goal,
          days_per_week: rest.days_per_week,
          days_specific: rest.days_specific,
          equipment,
          injuries: rest.injuries ?? [],
          exercise_minutes:
            exercise_minutes == null ? null : Number(exercise_minutes),
          sport_focus,
        }
      : null;
  return {
    ...rest,
    monthly_fee_ars:
      rest.monthly_fee_ars == null ? null : Number(rest.monthly_fee_ars),
    profile,
  };
}

export interface CreateUserInput {
  email: string;
  password: string;
  role?: Role;
  status?: UserStatus;
  email_verified?: boolean;
}

export async function createUser(
  input: CreateUserInput
): Promise<AdminUserRow> {
  const email = input.email.trim().toLowerCase();
  const exists = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [
    email,
  ]);
  if (exists.rowCount && exists.rowCount > 0) {
    throw new AdminError('email_taken');
  }
  const hash = await bcrypt.hash(input.password, BCRYPT_COST);
  const role = input.role ?? 'athlete';
  const status = input.status ?? 'approved';
  const verified = input.email_verified ?? true;

  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, status, email_verified, email_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [email, hash, role, status, verified, verified ? new Date() : null]
  );
  const fresh = await getUser(r.rows[0].id);
  if (!fresh) throw new AdminError('not_found');
  return fresh;
}

export async function deleteUser(id: string): Promise<void> {
  await deleteUserCommunityMedia(id);
  const r = await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
  if (!r.rowCount) throw new AdminError('not_found');
}

export interface UpdateUserPatch {
  role?: Role;
  status?: UserStatus;
  email_verified?: boolean;
}

export async function updateUser(
  id: string,
  patch: UpdateUserPatch
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.role !== undefined) {
    params.push(patch.role);
    sets.push(`role = $${params.length}`);
  }
  if (patch.status !== undefined) {
    params.push(patch.status);
    sets.push(`status = $${params.length}`);
  }
  if (patch.email_verified !== undefined) {
    params.push(patch.email_verified);
    sets.push(`email_verified = $${params.length}`);
    sets.push(
      patch.email_verified
        ? `email_verified_at = COALESCE(email_verified_at, NOW())`
        : `email_verified_at = NULL`
    );
  }
  if (!sets.length) return;

  params.push(id);
  await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`,
    params
  );
}

export interface UpsertSubInput {
  tier: SubTier;
  status: SubStatus;
  current_period_end?: string | null;
}

// Admin-managed manual subscription label. Bypasses MercadoPago. Uses a
// synthetic preapproval/plan id so we don't collide with real MP rows.
/**
 * @deprecated Writes the legacy MercadoPago-shaped subscriptions table with a
 * tier. Superseded by membership.service.registerPayment (membership model);
 * tiers no longer gate anything. Kept until the admin dashboard migrates.
 *
 * Cosmetic label only — does NOT touch memberships/paid_until. It used to
 * silently extend access on status 'authorized' with no payments row behind
 * it, which let "Real cobrado" count athletes who never actually paid. Use
 * registerPayment (the "Registrar pago" button) to grant/extend access.
 */
export async function upsertManualSubscription(
  userId: string,
  input: UpsertSubInput
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM subscriptions
        WHERE athlete_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId]
    );
    if (existing.rows[0]) {
      await client.query(
        `UPDATE subscriptions
            SET tier = $1, status = $2,
                current_period_end = $3, updated_at = NOW()
          WHERE id = $4`,
        [
          input.tier,
          input.status,
          input.current_period_end ?? null,
          existing.rows[0].id,
        ]
      );
    } else {
      const synthetic = `admin_${userId}_${Date.now()}`;
      await client.query(
        `INSERT INTO subscriptions
           (athlete_id, tier, mp_preapproval_id, mp_plan_id, status,
            current_period_end)
         VALUES ($1, $2, $3, 'admin_manual', $4, $5)`,
        [
          userId,
          input.tier,
          synthetic,
          input.status,
          input.current_period_end ?? null,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function cancelSubscription(userId: string): Promise<void> {
  await pool.query(
    `UPDATE subscriptions
        SET status = 'cancelled', updated_at = NOW()
      WHERE athlete_id = $1
        AND status <> 'cancelled'`,
    [userId]
  );
}

export type AuditType =
  | 'user_created'
  | 'user_approved'
  | 'user_rejected'
  | 'user_deleted'
  | 'role_changed'
  | 'email_verified'
  | 'email_unverified'
  | 'subscription_created'
  | 'subscription_updated'
  | 'subscription_cancelled'
  | 'subscription_authorized'
  | 'subscription_paused'
  | 'payment_registered'
  | 'membership_cancelled'
  | 'membership_paused'
  | 'membership_resumed'
  | 'membership_vacation'
  | 'athlete_fee_changed'
  | 'athlete_rm_changed'
  | 'athlete_weight_changed'
  | 'program_week_set'
  | 'force_logout';

export type AuditSeverity = 'brand' | 'warning' | 'destructive' | null;

export interface AuditEventRow {
  id: string;
  type: AuditType;
  actor: string;
  target: string | null;
  target_id: string | null;
  meta: Record<string, unknown> | null;
  severity: AuditSeverity;
  created_at: string;
}

export interface LogAuditInput {
  type: AuditType;
  actor: string;
  target?: string | null;
  target_id?: string | null;
  meta?: Record<string, unknown> | null;
  severity?: AuditSeverity;
}

export async function logAudit(input: LogAuditInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (type, actor, target, target_id, meta, severity)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.type,
        input.actor,
        input.target ?? null,
        input.target_id ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
        input.severity ?? null,
      ]
    );
  } catch (e) {
    // Audit must not break the user-facing operation.
    // eslint-disable-next-line no-console
    console.warn('audit_log_failed', e);
  }
}

export async function setAthleteMonthlyFee(
  athleteId: string,
  feeArs: number,
  actor: string
): Promise<number> {
  const prev = await pool.query<{ monthly_fee_ars: string }>(
    `SELECT COALESCE(u.monthly_fee_ars, ap.monthly_fee_ars, 25000)::text
              AS monthly_fee_ars
       FROM users u
       LEFT JOIN athlete_profiles ap ON ap.user_id = u.id
      WHERE u.id = $1 AND u.role = 'athlete'`,
    [athleteId]
  );
  if (!prev.rows[0]) throw new Error('athlete_not_found');
  const from = Number(prev.rows[0].monthly_fee_ars);
  await pool.query(`UPDATE users SET monthly_fee_ars = $1 WHERE id = $2`, [
    feeArs,
    athleteId,
  ]);
  await logAudit({
    type: 'athlete_fee_changed',
    actor,
    target: 'athlete',
    target_id: athleteId,
    meta: { from, to: feeArs },
  });
  return feeArs;
}

// ─── Athlete RM (rep-max) editing ────────────────────────────────
// The weight engine (engine.service) reads rm_tests.value_kg for the config's
// principal_rm_source week and multiplies by pct_rm. Lowering an RM here (e.g.
// injury/illness) directly lowers the prescribed weights for that athlete.
export interface AthleteRmRow {
  exercise_id: number;
  exercise_name: string;
  program_week: 10 | 20 | 30;
  value_kg: number;
  unit: string | null;
  coach_note: string | null;
  tested_at: string;
}

export async function listAthleteRms(
  athleteId: string
): Promise<AthleteRmRow[]> {
  const r = await pool.query<{
    exercise_id: number;
    exercise_name: string;
    program_week: 10 | 20 | 30;
    value_kg: string;
    unit: string | null;
    coach_note: string | null;
    tested_at: string;
  }>(
    `SELECT rt.exercise_id,
            e.name AS exercise_name,
            rt.program_week,
            rt.value_kg::text AS value_kg,
            rt.unit,
            rt.coach_note,
            rt.tested_at
       FROM rm_tests rt
       JOIN exercises e ON e.id = rt.exercise_id
      WHERE rt.athlete_id = $1
      ORDER BY e.name, rt.program_week`,
    [athleteId]
  );
  return r.rows.map((row) => ({ ...row, value_kg: Number(row.value_kg) }));
}

// A principal slot whose RM the current block already needs, but rm_tests has
// no row. Typical after an old "máquina ocupada" swap logged the test against
// the substitute: the coach sees only that stray row and cannot set the lift
// the engine multiplies (ticket #45). Weeks before the source week are omitted
// so week 1 does not ask for a week-30 RM that has not happened yet.
export interface MissingAthleteRm {
  exercise_id: number;
  exercise_name: string;
  program_week: 10 | 20 | 30;
  unit: Unit;
}

export async function listMissingPrincipalRms(
  athleteId: string
): Promise<MissingAthleteRm[]> {
  const r = await pool.query<{
    exercise_id: number;
    exercise_name: string;
    equipment: string;
    program_week: number;
  }>(
    `WITH state AS (
       SELECT current_week, active_skeleton_id
         FROM athlete_program_state
        WHERE athlete_id = $1
     ),
     targets AS (
       SELECT pc.principal_rm_source AS program_week
         FROM state s
         JOIN periodization_config pc ON pc.week_number = s.current_week
        WHERE pc.principal_rm_source IS NOT NULL
          AND s.current_week > pc.principal_rm_source
       UNION
       SELECT s.current_week AS program_week
         FROM state s
        WHERE s.current_week IN (10, 20, 30)
     )
     SELECT DISTINCT e.id AS exercise_id,
            e.name AS exercise_name,
            e.equipment,
            t.program_week
       FROM state s
       JOIN targets t ON TRUE
       JOIN skeleton_slots sl
         ON sl.skeleton_id = s.active_skeleton_id
        AND sl.role = 'principal'
       JOIN exercises e ON e.id = sl.exercise_id
      WHERE s.active_skeleton_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM rm_tests rt
           WHERE rt.athlete_id = $1
             AND rt.exercise_id = e.id
             AND rt.program_week = t.program_week
        )
      ORDER BY e.name, t.program_week`,
    [athleteId]
  );
  if (r.rows.length === 0) return [];

  const units = await pool.query<{ equipment: string; unit: Unit }>(
    `SELECT equipment, unit FROM athlete_equipment_units WHERE athlete_id = $1`,
    [athleteId]
  );
  const override = new Map(units.rows.map((row) => [row.equipment, row.unit]));
  const exUnits = await pool.query<{ exercise_id: number; unit: Unit }>(
    `SELECT exercise_id, unit FROM athlete_exercise_units WHERE athlete_id = $1`,
    [athleteId]
  );
  const exOverride = new Map(exUnits.rows.map((row) => [row.exercise_id, row.unit]));

  return r.rows.flatMap((row) => {
    if (
      row.program_week !== 10 &&
      row.program_week !== 20 &&
      row.program_week !== 30
    ) {
      return [];
    }
    return [
      {
        exercise_id: row.exercise_id,
        exercise_name: row.exercise_name,
        program_week: row.program_week,
        unit:
          exOverride.get(row.exercise_id) ??
          override.get(row.equipment) ??
          DEFAULT_UNIT_BY_EQUIPMENT[row.equipment] ??
          'kg',
      },
    ];
  });
}

export interface SetAthleteRmInput {
  exerciseId: number;
  programWeek: 10 | 20 | 30;
  valueKg: number;
  coachNote?: string | null;
}

/**
 * Manually set (upsert) an athlete's RM for one exercise/week — the coach's
 * "bajar RM temporal" control. Audit-logged with before/after so the change is
 * traceable and the coach can restore the prior value by hand. `unit` is
 * resolved from the exercise's equipment, mirroring rm.service.recordRm.
 */
export async function setAthleteRm(
  athleteId: string,
  input: SetAthleteRmInput,
  actor: string
): Promise<AthleteRmRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const exR = await client.query<{
      id: number;
      name: string;
      equipment: string;
    }>(`SELECT id, name, equipment FROM exercises WHERE id = $1`, [
      input.exerciseId,
    ]);
    if (!exR.rows[0]) throw new Error('exercise_not_found');
    const equipment = exR.rows[0].equipment ?? 'barra';
    const unit = await resolveUnit(athleteId, equipment, input.exerciseId);

    const prev = await client.query<{ value_kg: string }>(
      `SELECT value_kg::text AS value_kg FROM rm_tests
        WHERE athlete_id = $1 AND exercise_id = $2 AND program_week = $3`,
      [athleteId, input.exerciseId, input.programWeek]
    );
    const from = prev.rows[0] ? Number(prev.rows[0].value_kg) : null;

    const r = await client.query<{ tested_at: string }>(
      `INSERT INTO rm_tests
         (athlete_id, exercise_id, program_week, value_kg, value, unit, coach_note)
       VALUES ($1, $2, $3, $4, $4, $5, $6)
       ON CONFLICT (athlete_id, exercise_id, program_week)
         DO UPDATE SET value_kg = EXCLUDED.value_kg,
                       value = EXCLUDED.value,
                       unit = EXCLUDED.unit,
                       coach_note = EXCLUDED.coach_note,
                       tested_at = NOW()
       RETURNING tested_at`,
      [
        athleteId,
        input.exerciseId,
        input.programWeek,
        input.valueKg,
        unit,
        input.coachNote ?? null,
      ]
    );

    await client.query('COMMIT');

    await logAudit({
      type: 'athlete_rm_changed',
      actor,
      target: 'athlete',
      target_id: athleteId,
      severity: 'warning',
      meta: {
        exercise_id: input.exerciseId,
        exercise_name: exR.rows[0].name,
        program_week: input.programWeek,
        from,
        to: input.valueKg,
        note: input.coachNote ?? null,
      },
    });

    return {
      exercise_id: input.exerciseId,
      exercise_name: exR.rows[0].name,
      program_week: input.programWeek,
      value_kg: input.valueKg,
      unit,
      coach_note: input.coachNote ?? null,
      tested_at: r.rows[0].tested_at,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ─── Athlete working weights ─────────────────────────────────────
// The session engine reads athlete_exercise_weights.current_value (falling
// back to current_weight_kg) as the prescribed load. Coach edit here is a
// manual override of that casillero, same table the athlete/cron write.

export interface AthleteWeightRow {
  exercise_id: number;
  exercise_name: string;
  current_value: number | null;
  unit: string;
  scheme: 'normal' | 'dropset';
}

export async function listAthleteWeights(
  athleteId: string
): Promise<AthleteWeightRow[]> {
  const r = await pool.query<{
    exercise_id: number;
    exercise_name: string;
    current_value: string | null;
    unit: string;
    scheme: 'normal' | 'dropset';
  }>(
    `SELECT w.exercise_id,
            e.name AS exercise_name,
            COALESCE(w.current_value, w.current_weight_kg)::text AS current_value,
            COALESCE(w.unit, 'kg') AS unit,
            w.scheme
       FROM athlete_exercise_weights w
       JOIN exercises e ON e.id = w.exercise_id
      WHERE w.athlete_id = $1
      ORDER BY e.name, w.scheme`,
    [athleteId]
  );
  return r.rows.map((row) => ({
    exercise_id: row.exercise_id,
    exercise_name: row.exercise_name,
    current_value: row.current_value == null ? null : Number(row.current_value),
    unit: row.unit,
    scheme: row.scheme,
  }));
}

export interface SetAthleteWeightInput {
  exerciseId: number;
  currentValue: number;
  scheme?: 'normal' | 'dropset';
}

export async function setAthleteWeight(
  athleteId: string,
  input: SetAthleteWeightInput,
  actor: string
): Promise<AthleteWeightRow> {
  // Sin scheme explícito se edita la carga de las series rectas: es la que ve
  // el coach por default y la que existe para todos los ejercicios.
  const scheme = input.scheme ?? 'normal';

  const exR = await pool.query<{
    id: number;
    name: string;
    equipment: string;
  }>(`SELECT id, name, equipment FROM exercises WHERE id = $1`, [
    input.exerciseId,
  ]);
  if (!exR.rows[0]) throw new Error('exercise_not_found');
  const unit = await resolveUnit(athleteId, exR.rows[0].equipment ?? 'barra', input.exerciseId);

  const prev = await pool.query<{ current_value: string | null }>(
    `SELECT COALESCE(current_value, current_weight_kg)::text AS current_value
       FROM athlete_exercise_weights
      WHERE athlete_id = $1 AND exercise_id = $2 AND scheme = $3`,
    [athleteId, input.exerciseId, scheme]
  );
  const from =
    prev.rows[0]?.current_value == null
      ? null
      : Number(prev.rows[0].current_value);

  await pool.query(
    `INSERT INTO athlete_exercise_weights
       (athlete_id, exercise_id, current_weight_kg, current_value, unit,
        updated_by, scheme)
     VALUES ($1, $2, $3, $3, $4, 'coach', $5)
     ON CONFLICT (athlete_id, exercise_id, scheme)
       DO UPDATE SET current_weight_kg = EXCLUDED.current_weight_kg,
                     current_value = EXCLUDED.current_value,
                     unit = EXCLUDED.unit,
                     updated_by = 'coach',
                     updated_at = NOW()`,
    [athleteId, input.exerciseId, input.currentValue, unit, scheme]
  );

  await logAudit({
    type: 'athlete_weight_changed',
    actor,
    target: 'athlete',
    target_id: athleteId,
    severity: 'warning',
    meta: {
      exercise_id: input.exerciseId,
      exercise_name: exR.rows[0].name,
      from,
      to: input.currentValue,
      scheme,
    },
  });

  return {
    exercise_id: input.exerciseId,
    exercise_name: exR.rows[0].name,
    current_value: input.currentValue,
    unit,
    scheme,
  };
}

export type ActivityCategory = 'user' | 'sub' | 'auth';

const CATEGORY_TYPES: Record<ActivityCategory, AuditType[]> = {
  user: ['user_created', 'user_approved', 'user_rejected', 'user_deleted'],
  sub: [
    'subscription_created',
    'subscription_updated',
    'subscription_cancelled',
    'subscription_authorized',
    'subscription_paused',
  ],
  auth: ['email_verified', 'email_unverified', 'role_changed', 'force_logout'],
};

export interface ActivityFilters {
  category?: ActivityCategory;
  target_id?: string;
  before?: string;
  limit?: number;
}

export async function listActivity(
  filters: ActivityFilters
): Promise<AuditEventRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.category) {
    params.push(CATEGORY_TYPES[filters.category]);
    where.push(`type = ANY($${params.length})`);
  }
  if (filters.target_id) {
    params.push(filters.target_id);
    where.push(`target_id = $${params.length}`);
  }
  if (filters.before) {
    params.push(filters.before);
    where.push(`created_at < $${params.length}`);
  }
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const sql = `
    SELECT id, type, actor, target, target_id::text, meta, severity, created_at
      FROM admin_audit_log
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT ${limit}
  `;
  const r = await pool.query<AuditEventRow>(sql, params);
  return r.rows;
}

// ARS/mes per tier. Update here if pricing changes.
export const TIER_PRICE_ARS: Record<SubTier, number> = {
  basico: 15000,
  full: 25000,
  premium: 70000,
};

export interface AdminStats {
  signups_30d: number;
  signups_delta_pct: number;
  signups_trend: number[];
  pending_count: number;
  active_subs: number;
  active_subs_delta: number;
  mrr_estimated: number;
  mrr_delta_pct: number;
  mrr_trend: number[];
  churn_pct: number;
  churn_delta_pp: number;
  verified_pct: number;
}

export async function getStats(): Promise<AdminStats> {
  const signupsRes = await pool.query<{
    cur: string;
    prev: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS cur,
       COUNT(*) FILTER (
         WHERE created_at >= NOW() - INTERVAL '60 days'
           AND created_at <  NOW() - INTERVAL '30 days'
       ) AS prev
       FROM users`
  );
  const cur = Number(signupsRes.rows[0]?.cur ?? 0);
  const prev = Number(signupsRes.rows[0]?.prev ?? 0);
  const signupsDeltaPct =
    prev > 0 ? ((cur - prev) / prev) * 100 : cur > 0 ? 100 : 0;

  const trendRes = await pool.query<{ cnt: string }>(
    `SELECT COALESCE(c.cnt, 0)::text AS cnt
       FROM generate_series(
         (NOW() AT TIME ZONE 'UTC')::date - INTERVAL '29 days',
         (NOW() AT TIME ZONE 'UTC')::date,
         INTERVAL '1 day'
       ) d
       LEFT JOIN (
         SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS cnt
           FROM users
          WHERE created_at >= NOW() - INTERVAL '30 days'
          GROUP BY 1
       ) c ON c.day = d::date
       ORDER BY d`
  );
  const signupsTrend = trendRes.rows.map((r) => Number(r.cnt));

  const pendingRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM users WHERE status = 'pending'`
  );
  const pendingCount = Number(pendingRes.rows[0]?.n ?? 0);

  const verifiedRes = await pool.query<{ total: string; verified: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE email_verified) AS verified
       FROM users
      WHERE status = 'approved'`
  );
  const totalApproved = Number(verifiedRes.rows[0]?.total ?? 0);
  const verifiedCount = Number(verifiedRes.rows[0]?.verified ?? 0);
  const verifiedPct =
    totalApproved > 0 ? Math.round((verifiedCount / totalApproved) * 100) : 0;

  // Live membership state — "vigente hoy" is the paid_until clock, not the dead
  // MercadoPago `subscriptions` table these KPIs used to read. That table only
  // ever moved when someone pressed the legacy "Crear suscripción" button
  // (removed), so MRR never dropped when an athlete failed to renew.
  const liveRes = await pool.query<{ n: string; mrr: string; churned: string }>(
    `WITH athlete AS (
       SELECT u.id,
              ${FEE_EXPR} AS fee,
              m.status, m.paid_until
         FROM users u
         LEFT JOIN athlete_profiles ap ON ap.user_id = u.id
         JOIN memberships m ON m.user_id = u.id
        WHERE u.role = 'athlete' AND u.status = 'approved'
     ),
     vigente AS (
       SELECT * FROM athlete
        WHERE status NOT IN ('cancelled', 'paused', 'vacation')
          AND (paid_until = 'infinity' OR paid_until >= NOW())
     )
     SELECT
       (SELECT COUNT(*) FROM vigente) AS n,
       (SELECT COALESCE(SUM(fee), 0) FROM vigente) AS mrr,
       (SELECT COUNT(*) FROM athlete
         WHERE status IN ('expired', 'cancelled')
           AND paid_until >= NOW() - INTERVAL '30 days'
           AND paid_until <  NOW()) AS churned`
  );
  const activeSubs = Number(liveRes.rows[0]?.n ?? 0);
  const mrr = Number(liveRes.rows[0]?.mrr ?? 0);
  const churned = Number(liveRes.rows[0]?.churned ?? 0);
  const churnBase = activeSubs + churned;
  const churnPct = churnBase > 0 ? (churned / churnBase) * 100 : 0;

  // ponytail: no history table for memberships, so month-over-month deltas and
  // the 12-month sparkline aren't reconstructible — paid_until is overwritten
  // on every renewal. Left empty rather than faked; add a monthly snapshot
  // (like platform_fee_history) if the trend is worth having.
  const activeSubsDelta = 0;
  const mrrDeltaPct = 0;
  const mrrTrend: number[] = [];
  const churnDeltaPp = 0;

  return {
    signups_30d: cur,
    signups_delta_pct: Number(signupsDeltaPct.toFixed(1)),
    signups_trend: signupsTrend,
    pending_count: pendingCount,
    active_subs: activeSubs,
    active_subs_delta: activeSubsDelta,
    mrr_estimated: mrr,
    mrr_delta_pct: Number(mrrDeltaPct.toFixed(1)),
    mrr_trend: mrrTrend,
    churn_pct: Number(churnPct.toFixed(1)),
    churn_delta_pp: Number(churnDeltaPp.toFixed(1)),
    verified_pct: verifiedPct,
  };
}
