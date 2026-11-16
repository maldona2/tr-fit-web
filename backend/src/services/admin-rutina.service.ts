import pool from '../db/connect.js';
import { weightScheme } from './progression-helpers.js';
import type { AthleteSkeleton, SkeletonSlot } from '../domain/types.js';
import type {
  AdminSlotCreate,
  AdminSlotPatch,
  AdminReorderInput,
  AdminTrainingDaysInput,
  AdminApplyEditsInput,
} from '../domain/schemas.js';
import { applySlotEdits } from './skeleton.service.js';
import type { PoolClient } from 'pg';

export type AdminRutinaErrorCode =
  | 'not_found'
  | 'rutina_not_active'
  | 'invalid_exercise'
  | 'invalid_payload'
  | 'invalid_week'
  | 'session_in_progress'
  | 'empty_patch'
  | 'regen_pending';

export class AdminRutinaError extends Error {
  constructor(
    public code: AdminRutinaErrorCode,
    message?: string
  ) {
    super(message ?? code);
  }
}

export interface ActiveAthleteRow {
  athlete_id: string;
  name: string;
  skeleton_id: string;
  reviewed_at: string | null;
  days_per_week: number;
}

export async function listActiveAthletes(opts: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: ActiveAthleteRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const q = opts.q ? `%${opts.q.toLowerCase()}%` : null;

  const params: unknown[] = [];
  // Inner-joins drop athletes without active_skeleton_id / no program_state.
  // That is intentional: this endpoint lists athletes with a fully-activated routine.
  let where = `s.status = 'approved' AND ps.active_skeleton_id = s.id`;
  if (q) {
    params.push(q);
    where += ` AND LOWER(ap.name) LIKE $${params.length}`;
  }

  const totalSql = `
    SELECT COUNT(*)::int AS c
      FROM athlete_skeletons s
      JOIN athlete_program_state ps ON ps.athlete_id = s.athlete_id
      JOIN athlete_profiles ap ON ap.user_id = s.athlete_id
     WHERE ${where}`;
  const total = (await pool.query<{ c: number }>(totalSql, params)).rows[0].c;

  params.push(limit, offset);
  const sql = `
    SELECT s.athlete_id, ap.name, s.id AS skeleton_id,
           s.reviewed_at, ap.days_per_week
      FROM athlete_skeletons s
      JOIN athlete_program_state ps ON ps.athlete_id = s.athlete_id
      JOIN athlete_profiles ap ON ap.user_id = s.athlete_id
     WHERE ${where}
     ORDER BY s.reviewed_at DESC NULLS LAST
     LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const { rows } = await pool.query<ActiveAthleteRow>(sql, params);
  return { items: rows, total };
}

export interface RutinaDetail {
  skeleton: AthleteSkeleton;
  slots: SkeletonSlot[];
  days: { day_of_week: number; focus: string | null }[];
  profile: {
    user_id: string;
    name: string;
    days_per_week: number;
    days_specific: string[] | null;
  };
  has_active_session: boolean;
  current_week: number;
  total_weeks: number;
  /**
   * Session ordinals the athlete already finished in the current program week.
   * Reordering days remaps ordinals, so days already logged this week keep
   * counting as done for whatever now sits at that ordinal — the editor warns
   * on these.
   */
  trained_days_this_week: number[];
}

export async function getPendingSkeletonId(
  athleteId: string
): Promise<string | null> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM athlete_skeletons
      WHERE athlete_id = $1 AND status = 'pending_review'
      ORDER BY created_at DESC
      LIMIT 1`,
    [athleteId]
  );
  return r.rows[0]?.id ?? null;
}

export async function getActiveRutina(
  athleteId: string
): Promise<RutinaDetail | null> {
  const state = await pool.query<{
    active_skeleton_id: string | null;
    current_week: number | null;
    total_weeks: number | null;
  }>(
    `SELECT active_skeleton_id, current_week,
            (SELECT COUNT(*)::int FROM periodization_config) AS total_weeks
       FROM athlete_program_state WHERE athlete_id = $1`,
    [athleteId]
  );
  const skId = state.rows[0]?.active_skeleton_id;
  if (!skId) return null;

  const skR = await pool.query<AthleteSkeleton>(
    `SELECT * FROM athlete_skeletons WHERE id = $1 AND status = 'approved'`,
    [skId]
  );
  if (!skR.rows[0]) return null;

  const profR = await pool.query<{
    user_id: string;
    name: string;
    days_per_week: number;
    days_specific: string[] | null;
  }>(
    `SELECT user_id, name, days_per_week, days_specific FROM athlete_profiles
      WHERE user_id = $1`,
    [athleteId]
  );
  if (!profR.rows[0]) return null;

  const slotsR = await pool.query<SkeletonSlot>(
    `SELECT s.*, e.name AS exercise_name, e.muscle_group, e.equipment,
            e.archived_at AS exercise_archived_at
       FROM skeleton_slots s
       JOIN exercises e ON e.id = s.exercise_id
      WHERE s.skeleton_id = $1
      ORDER BY s.day_of_week, s.slot_index`,
    [skId]
  );
  const daysR = await pool.query<{ day_of_week: number; focus: string | null }>(
    `SELECT day_of_week, focus FROM skeleton_days WHERE skeleton_id = $1
      ORDER BY day_of_week`,
    [skId]
  );
  const sessR = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM session_logs
        WHERE athlete_id = $1 AND finished_at IS NULL
     ) AS exists`,
    [athleteId]
  );
  const trainedR = await pool.query<{ day_of_week: number }>(
    `SELECT DISTINCT l.day_of_week
       FROM session_logs l
       JOIN athlete_program_state s ON s.athlete_id = l.athlete_id
      WHERE l.athlete_id = $1
        AND l.program_week = COALESCE(s.current_week, 0)
        AND l.finished_at IS NOT NULL
        AND l.started_at >= COALESCE(s.program_reset_at, '-infinity')
      ORDER BY l.day_of_week`,
    [athleteId]
  );

  return {
    skeleton: skR.rows[0],
    slots: slotsR.rows,
    days: daysR.rows,
    profile: profR.rows[0],
    has_active_session: sessR.rows[0].exists,
    current_week: state.rows[0].current_week ?? 1,
    total_weeks: state.rows[0].total_weeks ?? 30,
    trained_days_this_week: trainedR.rows.map((r) => r.day_of_week),
  };
}

/**
 * Manda al atleta a una semana del plan. La pasada anterior de esa semana
 * deja de contar (program_reset_at): vuelve a entrenarla, y al cerrarla la
 * progresión sigue con la siguiente. No toca cargas, RM ni historial.
 */
export async function setProgramWeek(
  athleteId: string,
  week: number,
  actor: string
): Promise<{ current_week: number; rm_test_blocking: boolean }> {
  const client = await pool.connect();
  let changed = false;
  let blocking = false;
  let fromWeek = week;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      athleteId,
    ]);
    const stateR = await client.query<{
      current_week: number;
      active_skeleton_id: string | null;
      rm_test_blocking: boolean;
    }>(
      `SELECT current_week, active_skeleton_id, rm_test_blocking
         FROM athlete_program_state WHERE athlete_id = $1
         FOR UPDATE`,
      [athleteId]
    );
    const state = stateR.rows[0];
    if (!state?.active_skeleton_id) throw new AdminRutinaError('not_found');
    fromWeek = state.current_week;
    blocking = state.rm_test_blocking;
    if (week === state.current_week) {
      await client.query('COMMIT');
      return { current_week: week, rm_test_blocking: blocking };
    }

    const open = await client.query(
      `SELECT 1 FROM session_logs
        WHERE athlete_id = $1 AND finished_at IS NULL
        LIMIT 1`,
      [athleteId]
    );
    if ((open.rowCount ?? 0) > 0) {
      throw new AdminRutinaError('session_in_progress');
    }

    const cfg = await client.query<{
      is_rm_test: boolean;
      is_amrap: boolean;
    }>(
      `SELECT is_rm_test, is_amrap FROM periodization_config WHERE week_number = $1`,
      [week]
    );
    if (!cfg.rows[0]) throw new AdminRutinaError('invalid_week');
    blocking = !!(cfg.rows[0].is_rm_test || cfg.rows[0].is_amrap);

    await client.query(
      `UPDATE athlete_program_state
          SET current_week = $2,
              program_reset_at = NOW(),
              last_week_advanced_at = NOW(),
              rm_test_blocking = $3
        WHERE athlete_id = $1`,
      [athleteId, week, blocking]
    );
    await client.query('COMMIT');
    changed = true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (changed) {
    await pool
      .query(
        `INSERT INTO admin_audit_log (type, actor, target, target_id, meta, severity)
         VALUES ('program_week_set', $1, 'athlete', $2, $3, 'warning')`,
        [
          actor,
          athleteId,
          JSON.stringify({ from_week: fromWeek, to_week: week }),
        ]
      )
      .catch(() => {});
  }
  return { current_week: week, rm_test_blocking: blocking };
}

export async function changeTrainingDays(
  athleteId: string,
  input: AdminTrainingDaysInput
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      athleteId,
    ]);
    const blocked = await client.query<{ exists: boolean }>(
      `SELECT (
         EXISTS(SELECT 1 FROM skeleton_regen_jobs WHERE athlete_id = $1 AND status IN ('queued','running'))
         OR EXISTS(SELECT 1 FROM athlete_skeletons WHERE athlete_id = $1 AND status = 'pending_review')
       ) AS exists`,
      [athleteId]
    );
    if (blocked.rows[0].exists) {
      throw new AdminRutinaError('regen_pending');
    }
    const updated = await client.query(
      `UPDATE athlete_profiles
          SET days_per_week = $2, days_specific = $3
        WHERE user_id = $1`,
      [athleteId, input.days_specific.length, input.days_specific]
    );
    if (!updated.rowCount) throw new AdminRutinaError('not_found');
    await client.query(
      `INSERT INTO skeleton_regen_jobs (athlete_id, status) VALUES ($1, 'queued')`,
      [athleteId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function assertAthleteActiveSkeleton(
  client: PoolClient,
  athleteId: string
): Promise<string> {
  const r = await client.query<{ skeleton_id: string }>(
    `SELECT s.id AS skeleton_id
       FROM athlete_program_state ps
       JOIN athlete_skeletons s
         ON s.id = ps.active_skeleton_id AND s.status = 'approved'
      WHERE ps.athlete_id = $1
      FOR UPDATE OF ps, s`,
    [athleteId]
  );
  if (!r.rows[0]) throw new AdminRutinaError('rutina_not_active');
  return r.rows[0].skeleton_id;
}

async function assertExerciseAvailable(
  client: PoolClient,
  exerciseId: number
): Promise<void> {
  const r = await client.query<{ id: number }>(
    `SELECT id FROM exercises WHERE id = $1 AND archived_at IS NULL`,
    [exerciseId]
  );
  if (!r.rows[0]) throw new AdminRutinaError('invalid_exercise');
}

async function seedAthleteExerciseWeight(
  client: PoolClient,
  athleteId: string,
  exerciseId: number
): Promise<void> {
  await client.query(
    `INSERT INTO athlete_exercise_weights
       (athlete_id, exercise_id, current_weight_kg, current_reps_text, updated_by)
     VALUES ($1, $2, NULL, NULL, 'athlete_initial')
     ON CONFLICT (athlete_id, exercise_id, scheme) DO NOTHING`,
    [athleteId, exerciseId]
  );
}

export async function createSlot(
  athleteId: string,
  input: AdminSlotCreate
): Promise<SkeletonSlot> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const skId = await assertAthleteActiveSkeleton(client, athleteId);
    await assertExerciseAvailable(client, input.exercise_id);
    const r = await client.query<SkeletonSlot>(
      `INSERT INTO skeleton_slots
         (skeleton_id, day_of_week, slot_index, exercise_id, role, notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        skId,
        input.day_of_week,
        input.slot_index,
        input.exercise_id,
        input.role,
        input.notes ?? null,
      ]
    );
    await seedAthleteExerciseWeight(client, athleteId, input.exercise_id);
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore — preserve the original error
    }
    throw e;
  } finally {
    client.release();
  }
}

async function assertSlotInActiveSkeleton(
  client: PoolClient,
  slotId: string
): Promise<{ athleteId: string; skeletonId: string }> {
  const r = await client.query<{ athlete_id: string; skeleton_id: string }>(
    `SELECT s.athlete_id, s.id AS skeleton_id
       FROM skeleton_slots sl
       JOIN athlete_skeletons s ON s.id = sl.skeleton_id
       JOIN athlete_program_state ps
         ON ps.athlete_id = s.athlete_id
        AND ps.active_skeleton_id = s.id
      WHERE sl.id = $1 AND s.status = 'approved'`,
    [slotId]
  );
  if (!r.rows[0]) throw new AdminRutinaError('rutina_not_active');
  return {
    athleteId: r.rows[0].athlete_id,
    skeletonId: r.rows[0].skeleton_id,
  };
}

export async function deleteSlot(slotId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertSlotInActiveSkeleton(client, slotId);
    await client.query(`DELETE FROM skeleton_slots WHERE id = $1`, [slotId]);
    await client.query('COMMIT');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore — preserve original error
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function updateSlot(
  slotId: string,
  patch: AdminSlotPatch
): Promise<SkeletonSlot> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { athleteId } = await assertSlotInActiveSkeleton(client, slotId);
    if (patch.exercise_id !== undefined) {
      await assertExerciseAvailable(client, patch.exercise_id);
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      values.push(v);
      sets.push(`${k} = $${values.length}`);
    }
    values.push(slotId);
    const r = await client.query<SkeletonSlot>(
      `UPDATE skeleton_slots SET ${sets.join(', ')}
        WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (patch.exercise_id !== undefined) {
      await seedAthleteExerciseWeight(client, athleteId, patch.exercise_id);
    }
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore — preserve original error
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function reorderSlots(
  athleteId: string,
  input: AdminReorderInput
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const skId = await assertAthleteActiveSkeleton(client, athleteId);

    const totalR = await client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM skeleton_slots WHERE skeleton_id = $1`,
      [skId]
    );
    if (totalR.rows[0].c !== input.slots.length) {
      throw new AdminRutinaError(
        'not_found',
        'reorder payload must include every slot of the skeleton'
      );
    }

    const slotIds = input.slots.map((s) => s.slot_id);
    const check = await client.query<{ id: string }>(
      `SELECT id FROM skeleton_slots
        WHERE id = ANY($1::uuid[]) AND skeleton_id = $2`,
      [slotIds, skId]
    );
    if (check.rowCount !== slotIds.length) {
      throw new AdminRutinaError('not_found', 'slot not in active skeleton');
    }

    // Use a temporary unique key (skeleton_id, id) trick: set all targeted
    // slots to (day_of_week=0, slot_index=0) to vacate the unique positions,
    // then apply the new values. day_of_week=0 is outside CHECK (1–7) so we
    // instead use a two-phase approach: first move slots OUT of the way by
    // nulling their position within a deferred constraint — but since the
    // constraint is not DEFERRABLE we delete + re-insert within the same txn.
    //
    // Delete the targeted slots, then re-insert with new positions to avoid
    // any intermediate UNIQUE(skeleton_id, day_of_week, slot_index) violation.
    const targetedSlotIds = input.slots.map((s) => s.slot_id);
    const existing = await client.query<{
      id: string;
      exercise_id: number;
      role: string;
      notes: string | null;
      series: number | null;
      reps: string | null;
      descanso: string | null;
    }>(
      `DELETE FROM skeleton_slots
        WHERE id = ANY($1::uuid[])
        RETURNING id, exercise_id, role, notes, series, reps, descanso`,
      [targetedSlotIds]
    );

    const existingById = new Map(existing.rows.map((r) => [r.id, r]));

    for (const s of input.slots) {
      const orig = existingById.get(s.slot_id);
      if (!orig) continue; // already validated above
      await client.query(
        `INSERT INTO skeleton_slots
           (id, skeleton_id, day_of_week, slot_index, exercise_id, role, notes,
            series, reps, descanso)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          orig.id,
          skId,
          s.day_of_week,
          s.slot_index,
          orig.exercise_id,
          orig.role,
          orig.notes,
          orig.series,
          orig.reps,
          orig.descanso,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore — preserve original error
    }
    throw e;
  } finally {
    client.release();
  }
}

/** Applies the activas editor draft atomically to the active routine. */
export async function applyEdits(
  athleteId: string,
  input: AdminApplyEditsInput
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      athleteId,
    ]);
    const skeletonId = await assertAthleteActiveSkeleton(client, athleteId);

    const currentR = await client.query<{
      id: string;
      day_of_week: number;
      exercise_id: number;
    }>(
      `SELECT id, day_of_week, exercise_id
         FROM skeleton_slots
        WHERE skeleton_id = $1`,
      [skeletonId]
    );
    const currentById = new Map(currentR.rows.map((slot) => [slot.id, slot]));
    const deletedIds = new Set(input.deleted_slot_ids ?? []);
    const addedById = new Map(
      (input.added_slots ?? []).map((slot) => [slot.id, slot])
    );

    if (
      deletedIds.size !== (input.deleted_slot_ids?.length ?? 0) ||
      [...deletedIds].some((id) => !currentById.has(id)) ||
      addedById.size !== (input.added_slots?.length ?? 0) ||
      [...addedById].some(([id]) => currentById.has(id))
    ) {
      throw new AdminRutinaError('not_found', 'invalid slot ids');
    }

    for (const added of input.added_slots ?? []) {
      await assertExerciseAvailable(client, added.exercise_id);
    }

    const finalIds = new Set([
      ...currentR.rows
        .filter((slot) => !deletedIds.has(slot.id))
        .map((slot) => slot.id),
      ...addedById.keys(),
    ]);

    for (const override of input.slot_overrides ?? []) {
      if (!finalIds.has(override.slot_id)) {
        throw new AdminRutinaError('not_found', 'slot override not in routine');
      }
      const currentExerciseId =
        currentById.get(override.slot_id)?.exercise_id ??
        addedById.get(override.slot_id)?.exercise_id;
      if (override.exercise_id !== currentExerciseId) {
        await assertExerciseAvailable(client, override.exercise_id);
      }
    }

    if (input.slot_order) {
      const orderIds = new Set(input.slot_order.map((slot) => slot.slot_id));
      if (
        orderIds.size !== input.slot_order.length ||
        orderIds.size !== finalIds.size ||
        [...finalIds].some((id) => !orderIds.has(id))
      ) {
        throw new AdminRutinaError(
          'not_found',
          'slot_order must include every slot of the skeleton'
        );
      }
      const positions = new Set(
        input.slot_order.map((slot) => `${slot.day_of_week}:${slot.slot_index}`)
      );
      if (positions.size !== input.slot_order.length) {
        throw new AdminRutinaError(
          'invalid_payload',
          'slot_order positions must be unique'
        );
      }
    } else {
      const counts = new Map<number, number>();
      for (const slot of currentR.rows) {
        if (!deletedIds.has(slot.id)) {
          counts.set(slot.day_of_week, (counts.get(slot.day_of_week) ?? 0) + 1);
        }
      }
      for (const slot of input.added_slots ?? []) {
        counts.set(slot.day_of_week, (counts.get(slot.day_of_week) ?? 0) + 1);
      }
      if ([...counts.values()].some((count) => count > 12)) {
        throw new AdminRutinaError(
          'invalid_payload',
          'a training day cannot have more than 12 slots'
        );
      }
    }

    await applySlotEdits(client, skeletonId, {
      slotOverrides: input.slot_overrides,
      slotOrder: input.slot_order,
      deletedSlotIds: input.deleted_slot_ids,
      addedSlots: input.added_slots,
      dayFocus: input.day_focus,
    });

    await client.query(
      `INSERT INTO athlete_exercise_weights
         (athlete_id, exercise_id, current_weight_kg, current_reps_text, updated_by, scheme)
       SELECT $1, exercise_id, NULL, NULL, 'athlete_initial',
              CASE WHEN reps ~ '^[[:space:]]*[0-9]+[[:space:]]*[x×][[:space:]]*[0-9]+[[:space:]]*[x×]'
                   THEN 'dropset' ELSE 'normal' END
         FROM (SELECT DISTINCT exercise_id, reps FROM skeleton_slots
                WHERE skeleton_id = $2) s
       ON CONFLICT (athlete_id, exercise_id, scheme) DO NOTHING`,
      [athleteId, skeletonId]
    );

    const editedRepsByExercise = new Map<number, string | null>();
    for (const override of input.slot_overrides ?? []) {
      if ('reps' in override) {
        editedRepsByExercise.set(override.exercise_id, override.reps ?? null);
      }
    }
    for (const added of input.added_slots ?? []) {
      if (added.reps != null) {
        editedRepsByExercise.set(added.exercise_id, added.reps);
      }
    }
    for (const [exerciseId, reps] of editedRepsByExercise) {
      await client.query(
        `UPDATE athlete_exercise_weights
            SET current_reps_text = $3, updated_at = NOW(), updated_by = 'coach'
          WHERE athlete_id = $1 AND exercise_id = $2 AND scheme = $4`,
        [athleteId, exerciseId, reps, weightScheme(reps)]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore — preserve original error
    }
    throw e;
  } finally {
    client.release();
  }
}
