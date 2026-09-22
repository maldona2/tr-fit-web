import pool from '../db/connect.js';
import { resolveUnit } from './equipment-units.service.js';
import { estimateEpley1RM } from './epley.service.js';

export interface RecordRmInput {
  athleteId: string;
  exerciseId: number;
  valueKg: number;
  week: 10 | 20 | 30;
  amrapWeight?: number;
  amrapReps?: number;
}

export async function recordRm(input: RecordRmInput): Promise<{ rmId: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Resolve the equipment for this exercise to determine unit
    const exR = await client.query<{ equipment: string }>(
      `SELECT equipment FROM exercises WHERE id = $1`,
      [input.exerciseId],
    );
    const equipment = exR.rows[0]?.equipment ?? 'barra';
    const unit = await resolveUnit(input.athleteId, equipment);

    const r = await client.query<{ id: string }>(
      `INSERT INTO rm_tests
         (athlete_id, exercise_id, program_week, value_kg, value, unit, amrap_weight, amrap_reps)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7)
       ON CONFLICT (athlete_id, exercise_id, program_week)
         DO UPDATE SET value_kg = EXCLUDED.value_kg,
                       value = EXCLUDED.value,
                       unit = EXCLUDED.unit,
                       amrap_weight = EXCLUDED.amrap_weight,
                       amrap_reps = EXCLUDED.amrap_reps,
                       tested_at = NOW()
       RETURNING id`,
      [input.athleteId, input.exerciseId, input.week, input.valueKg, unit,
       input.amrapWeight ?? null, input.amrapReps ?? null],
    );

    // Unblock: if all 7 principal exercises in skeleton have an RM for this week,
    // clear rm_test_blocking. Otherwise leave it as-is (still blocking).
    const stateR = await client.query<{ active_skeleton_id: string | null }>(
      `SELECT active_skeleton_id FROM athlete_program_state WHERE athlete_id = $1`,
      [input.athleteId],
    );
    const skeletonId = stateR.rows[0]?.active_skeleton_id;
    if (skeletonId) {
      const need = await client.query<{ exercise_id: number }>(
        `SELECT DISTINCT s.exercise_id
           FROM skeleton_slots s
           JOIN exercises e ON e.id = s.exercise_id
          WHERE s.skeleton_id = $1 AND e.is_principal = TRUE`,
        [skeletonId],
      );
      const got = await client.query<{ exercise_id: number }>(
        `SELECT exercise_id FROM rm_tests
          WHERE athlete_id = $1 AND program_week = $2`,
        [input.athleteId, input.week],
      );
      const needSet = new Set(need.rows.map((r) => r.exercise_id));
      const gotSet = new Set(got.rows.map((r) => r.exercise_id));
      const allRecorded = [...needSet].every((id) => gotSet.has(id));
      if (allRecorded) {
        await client.query(
          `UPDATE athlete_program_state
              SET rm_test_blocking = FALSE
            WHERE athlete_id = $1`,
          [input.athleteId],
        );
      }
    }

    await client.query('COMMIT');
    return { rmId: r.rows[0].id };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export interface RecordAmrapInput {
  athleteId: string;
  exerciseId: number;
  weightUsed: number;
  reps: number;
}

/**
 * Records a week-20 AMRAP test: derives the theoretical 1RM via Epley and
 * stores it in rm_tests(program_week=20), reusing recordRm's unblock logic.
 */
export async function recordAmrap(
  input: RecordAmrapInput,
): Promise<{ rmId: string; estimated1RM: number }> {
  const exR = await pool.query<{ equipment: string }>(
    `SELECT equipment FROM exercises WHERE id = $1`,
    [input.exerciseId],
  );
  const equipment = exR.rows[0]?.equipment ?? 'barra';
  const estimated1RM = estimateEpley1RM(input.weightUsed, input.reps, equipment);
  const { rmId } = await recordRm({
    athleteId: input.athleteId,
    exerciseId: input.exerciseId,
    valueKg: estimated1RM,
    week: 20,
    amrapWeight: input.weightUsed,
    amrapReps: input.reps,
  });
  return { rmId, estimated1RM };
}

/**
 * Persists an estimated 1RM for an RM-test week (10 / 30) only when none exists.
 * Never overwrites a real RM the athlete already logged via recordRm.
 * Reuses amrap_weight / amrap_reps to keep the source set that produced the estimate.
 */
export async function recordEstimatedRmIfAbsent(input: {
  athleteId: string;
  exerciseId: number;
  valueKg: number;
  week: 10 | 30;
  sourceWeight: number;
  sourceReps: number;
}): Promise<{ rmId: string | null; inserted: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const exR = await client.query<{ equipment: string }>(
      `SELECT equipment FROM exercises WHERE id = $1`,
      [input.exerciseId],
    );
    const equipment = exR.rows[0]?.equipment ?? 'barra';
    const unit = await resolveUnit(input.athleteId, equipment);

    const r = await client.query<{ id: string }>(
      `INSERT INTO rm_tests
         (athlete_id, exercise_id, program_week, value_kg, value, unit, amrap_weight, amrap_reps)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7)
       ON CONFLICT (athlete_id, exercise_id, program_week) DO NOTHING
       RETURNING id`,
      [
        input.athleteId,
        input.exerciseId,
        input.week,
        input.valueKg,
        unit,
        input.sourceWeight,
        input.sourceReps,
      ],
    );

    const inserted = r.rows.length > 0;
    if (inserted) {
      const stateR = await client.query<{ active_skeleton_id: string | null }>(
        `SELECT active_skeleton_id FROM athlete_program_state WHERE athlete_id = $1`,
        [input.athleteId],
      );
      const skeletonId = stateR.rows[0]?.active_skeleton_id;
      if (skeletonId) {
        const need = await client.query<{ exercise_id: number }>(
          `SELECT DISTINCT s.exercise_id
             FROM skeleton_slots s
             JOIN exercises e ON e.id = s.exercise_id
            WHERE s.skeleton_id = $1 AND e.is_principal = TRUE`,
          [skeletonId],
        );
        const got = await client.query<{ exercise_id: number }>(
          `SELECT exercise_id FROM rm_tests
            WHERE athlete_id = $1 AND program_week = $2`,
          [input.athleteId, input.week],
        );
        const needSet = new Set(need.rows.map((row) => row.exercise_id));
        const gotSet = new Set(got.rows.map((row) => row.exercise_id));
        if ([...needSet].every((id) => gotSet.has(id))) {
          await client.query(
            `UPDATE athlete_program_state
                SET rm_test_blocking = FALSE
              WHERE athlete_id = $1`,
            [input.athleteId],
          );
        }
      }
    }

    await client.query('COMMIT');
    return { rmId: inserted ? r.rows[0].id : null, inserted };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Fills missing rm_tests for an RM-test week from the best logged set of that
 * program week (Epley). Used when the athlete skips the explicit 1RM screen so
 * week 11+ can still prescribe RM × pct instead of raw AEW (ticket #20).
 */
export async function ensureEstimatedRmsFromWeekLogs(
  athleteId: string,
  programWeek: 10 | 30,
): Promise<{ filled: number }> {
  const bestR = await pool.query<{
    exercise_id: number;
    weight: string;
    reps: number;
    equipment: string;
  }>(
    `SELECT DISTINCT ON (sl.exercise_id)
            sl.exercise_id,
            COALESCE(sl.value, sl.weight_kg)::text AS weight,
            sl.reps,
            e.equipment
       FROM set_logs sl
       JOIN session_logs lg ON lg.id = sl.session_log_id
       JOIN exercises e ON e.id = sl.exercise_id
      WHERE lg.athlete_id = $1
        AND lg.program_week = $2
        AND sl.completed = TRUE
        AND e.is_principal = TRUE
        AND COALESCE(sl.value, sl.weight_kg) > 0
        AND sl.reps > 0
        AND NOT EXISTS (
          SELECT 1 FROM rm_tests r
           WHERE r.athlete_id = lg.athlete_id
             AND r.exercise_id = sl.exercise_id
             AND r.program_week = $2
        )
      ORDER BY sl.exercise_id,
               COALESCE(sl.value, sl.weight_kg) * (1 + sl.reps / 30.0) DESC`,
    [athleteId, programWeek],
  );

  let filled = 0;
  for (const row of bestR.rows) {
    const weightUsed = Number(row.weight);
    const estimated1RM = estimateEpley1RM(weightUsed, row.reps, row.equipment);
    const { inserted } = await recordEstimatedRmIfAbsent({
      athleteId,
      exerciseId: row.exercise_id,
      valueKg: estimated1RM,
      week: programWeek,
      sourceWeight: weightUsed,
      sourceReps: row.reps,
    });
    if (inserted) filled += 1;
  }
  return { filled };
}
