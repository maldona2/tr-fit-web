import type { PoolClient } from 'pg';
import type { AthleteProfile, Exercise } from '../domain/types.js';
import { listExercisesForAthlete } from './exercise.service.js';
import { pickRotation, type RotationSlot } from './exercise-rotation.js';

export interface RotationRecord {
  slot_id: string;
  day_of_week: number;
  group: string;
  from_exercise_id: number;
  from_name: string;
  to_exercise_id: number;
  to_name: string;
}

/**
 * Cambia 1 accesorio del esqueleto activo (permanente) y deja log.
 * Corre dentro de la transacción del caller (progresión semanal).
 */
export async function rotateOneExercise(
  client: PoolClient,
  athleteId: string,
  skeletonId: string,
  programWeek: number,
  rng: () => number = Math.random
): Promise<RotationRecord | null> {
  // Coach froze the plan (e.g. ACL rehab): no automatic changes.
  const lockR = await client.query<{ exercise_rotation_locked: boolean }>(
    `SELECT exercise_rotation_locked FROM users WHERE id = $1`,
    [athleteId]
  );
  if (lockR.rows[0]?.exercise_rotation_locked) return null;

  const profR = await client.query<AthleteProfile>(
    `SELECT * FROM athlete_profiles WHERE user_id = $1`,
    [athleteId]
  );
  const profile = profR.rows[0];
  if (!profile) return null;

  const stateR = await client.query<{ rotation_index: number }>(
    `SELECT rotation_index FROM athlete_program_state WHERE athlete_id = $1`,
    [athleteId]
  );
  const startIndex = stateR.rows[0]?.rotation_index ?? 0;

  const slotsR = await client.query<RotationSlot>(
    `SELECT id, day_of_week, exercise_id, role, reps
       FROM skeleton_slots
      WHERE skeleton_id = $1
      ORDER BY day_of_week, slot_index`,
    [skeletonId]
  );
  if (slotsR.rows.length === 0) return null;

  const exR = await client.query<Exercise>(
    `SELECT * FROM exercises WHERE id = ANY($1::int[])`,
    [slotsR.rows.map((s) => s.exercise_id)]
  );
  const exById = new Map(exR.rows.map((e) => [e.id, e]));
  const allowed = await listExercisesForAthlete(profile, athleteId);

  const pick = pickRotation(slotsR.rows, exById, allowed, startIndex, rng);
  if (!pick) return null;

  await client.query(
    `UPDATE skeleton_slots SET exercise_id = $1
      WHERE id = $2 AND skeleton_id = $3`,
    [pick.to.id, pick.slotId, skeletonId]
  );

  // Sigue el ciclo de reps del ejercicio reemplazado. Si el nuevo ya tiene
  // historial propio, manda el suyo (mismo criterio que el swap del atleta).
  await client.query(
    `INSERT INTO athlete_exercise_weights
       (athlete_id, exercise_id, current_weight_kg, current_reps_text,
        updated_by, scheme)
     SELECT $1, $2, NULL,
            (SELECT current_reps_text FROM athlete_exercise_weights
              WHERE athlete_id = $1 AND exercise_id = $3 AND scheme = 'normal'),
            'progression_cron', 'normal'
     ON CONFLICT (athlete_id, exercise_id, scheme) DO NOTHING`,
    [athleteId, pick.to.id, pick.from.id]
  );

  await client.query(
    `INSERT INTO exercise_rotations
       (athlete_id, skeleton_id, slot_id, day_of_week, program_week,
        muscle_group, from_exercise_id, to_exercise_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      athleteId,
      skeletonId,
      pick.slotId,
      pick.dayOfWeek,
      programWeek,
      pick.group,
      pick.from.id,
      pick.to.id,
    ]
  );

  await client.query(
    `UPDATE athlete_program_state SET rotation_index = $1
      WHERE athlete_id = $2`,
    [pick.nextIndex, athleteId]
  );

  return {
    slot_id: pick.slotId,
    day_of_week: pick.dayOfWeek,
    group: pick.group,
    from_exercise_id: pick.from.id,
    from_name: pick.from.name,
    to_exercise_id: pick.to.id,
    to_name: pick.to.name,
  };
}
