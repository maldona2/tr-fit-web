import { resetDatabase, ensureMigrated, closePool } from './helpers/test-db.js';
import { createAdmin, createAthlete } from './helpers/fixtures.js';
import {
  createPendingSkeleton,
  approveSkeleton,
} from '../../src/services/skeleton.service.js';
import { runWeeklyProgressionForAthlete } from '../../src/services/progression.service.js';
import { rotateOneExercise } from '../../src/services/exercise-rotation.service.js';
import pool from '../../src/db/connect.js';

beforeAll(async () => {
  await ensureMigrated();
});
beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

async function espaldaPair() {
  const r = await pool.query<{ id: number }>(
    `SELECT id FROM exercises
      WHERE muscle_group = 'Espalda' AND is_principal = FALSE
        AND modality = 'reps' AND archived_at IS NULL
        AND equipment = 'mancuerna'
      ORDER BY id LIMIT 1`
  );
  return r.rows[0].id;
}

async function setup(
  coach: string,
  ath: string,
  accesorioId: number,
  reps = '8'
) {
  const p = await pool.query<{ id: number }>(
    `SELECT id FROM exercises WHERE is_principal = TRUE ORDER BY id LIMIT 1`
  );
  const { skeletonId } = await createPendingSkeleton(
    { athleteId: ath, generationPrompt: {}, generationRationale: '' },
    {
      rationale: 'r',
      days: [
        {
          day_index: 1,
          focus: 'd',
          slots: [
            {
              slot_index: 1,
              exercise_id: p.rows[0].id,
              role: 'principal' as const,
              notes: null,
              series: null,
              reps: null,
              descanso: null,
            },
            {
              slot_index: 2,
              exercise_id: accesorioId,
              role: 'accesorio' as const,
              notes: null,
              series: 3,
              reps,
              descanso: '1 min',
            },
          ],
        },
      ],
    }
  );
  await approveSkeleton(skeletonId, coach);
  return skeletonId;
}

it('rotates one Espalda accessory, copies reps, logs and advances index', async () => {
  const coach = await createAdmin();
  const ath = await createAthlete(coach);
  const acc = await espaldaPair();
  const skeletonId = await setup(coach, ath, acc);
  await pool.query(
    `UPDATE athlete_exercise_weights SET current_reps_text = '10'
      WHERE athlete_id = $1 AND exercise_id = $2`,
    [ath, acc]
  );

  const client = await pool.connect();
  let rec;
  try {
    await client.query('BEGIN');
    rec = await rotateOneExercise(client, ath, skeletonId, 3, () => 0);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  expect(rec).not.toBeNull();
  expect(rec!.group).toBe('Espalda');
  expect(rec!.from_exercise_id).toBe(acc);
  expect(rec!.to_exercise_id).not.toBe(acc);

  const slot = await pool.query(
    `SELECT exercise_id FROM skeleton_slots WHERE skeleton_id = $1 AND slot_index = 2`,
    [skeletonId]
  );
  expect(slot.rows[0].exercise_id).toBe(rec!.to_exercise_id);

  const toEx = await pool.query(
    `SELECT muscle_group FROM exercises WHERE id = $1`,
    [rec!.to_exercise_id]
  );
  expect(toEx.rows[0].muscle_group).toBe('Espalda');

  const w = await pool.query(
    `SELECT current_reps_text FROM athlete_exercise_weights
      WHERE athlete_id = $1 AND exercise_id = $2 AND scheme = 'normal'`,
    [ath, rec!.to_exercise_id]
  );
  expect(w.rows[0].current_reps_text).toBe('10');

  const st = await pool.query(
    `SELECT rotation_index FROM athlete_program_state WHERE athlete_id = $1`,
    [ath]
  );
  expect(st.rows[0].rotation_index).toBe(1);

  const log = await pool.query(
    `SELECT count(*)::int AS n FROM exercise_rotations WHERE athlete_id = $1`,
    [ath]
  );
  expect(log.rows[0].n).toBe(1);
});

it('does not rotate dropset finishers', async () => {
  const coach = await createAdmin();
  const ath = await createAthlete(coach);
  const acc = await espaldaPair();
  const skeletonId = await setup(coach, ath, acc, '10x10x10');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rec = await rotateOneExercise(client, ath, skeletonId, 3, () => 0);
    await client.query('COMMIT');
    expect(rec).toBeNull();
  } finally {
    client.release();
  }
  const st = await pool.query(
    `SELECT rotation_index FROM athlete_program_state WHERE athlete_id = $1`,
    [ath]
  );
  expect(st.rows[0].rotation_index).toBe(0);
});

it('progression into week 3 rotates; into week 2 does not', async () => {
  const coach = await createAdmin();
  const ath = await createAthlete(coach);
  const acc = await espaldaPair();
  await setup(coach, ath, acc);

  // week 1 → 2 (no rotation). Force compliance with a completed set log.
  // set_logs requires day_of_week and set_index (009).
  await pool.query(
    `INSERT INTO set_logs (athlete_id, exercise_id, week, day_of_week, set_index, completed)
     VALUES ($1, $2, 1, 1, 1, true)`,
    [ath, acc]
  );
  const r1 = await runWeeklyProgressionForAthlete(ath);
  expect(r1.toWeek).toBe(2);
  expect(r1.rotation).toBeNull();

  await pool.query(
    `INSERT INTO set_logs (athlete_id, exercise_id, week, day_of_week, set_index, completed)
     VALUES ($1, $2, 2, 1, 1, true)`,
    [ath, acc]
  );
  const r2 = await runWeeklyProgressionForAthlete(ath);
  expect(r2.toWeek).toBe(3);
  expect(r2.rotation).not.toBeNull();
});

it('rotation failure does not block the week advance', async () => {
  const coach = await createAdmin();
  const ath = await createAthlete(coach);
  const acc = await espaldaPair();
  const skeletonId = await setup(coach, ath, acc);

  await pool.query(
    `INSERT INTO set_logs (athlete_id, exercise_id, week, day_of_week, set_index, completed)
     VALUES ($1, $2, 1, 1, 1, true)`,
    [ath, acc]
  );
  const r1 = await runWeeklyProgressionForAthlete(ath);
  expect(r1.toWeek).toBe(2);

  await pool.query(
    `INSERT INTO set_logs (athlete_id, exercise_id, week, day_of_week, set_index, completed)
     VALUES ($1, $2, 2, 1, 1, true)`,
    [ath, acc]
  );

  await pool.query(
    `ALTER TABLE exercise_rotations
       ADD CONSTRAINT tmp_block CHECK (false) NOT VALID`
  );
  try {
    const r2 = await runWeeklyProgressionForAthlete(ath);
    expect(r2.toWeek).toBe(3);
    expect(r2.rotation).toBeNull();
    const slot = await pool.query(
      `SELECT exercise_id FROM skeleton_slots
        WHERE skeleton_id = $1 AND slot_index = 2`,
      [skeletonId]
    );
    expect(slot.rows[0].exercise_id).toBe(acc);
  } finally {
    await pool.query(
      `ALTER TABLE exercise_rotations DROP CONSTRAINT IF EXISTS tmp_block`
    );
  }
});

it('skips rotation when the coach locked it for the athlete', async () => {
  const coach = await createAdmin();
  const ath = await createAthlete(coach);
  const acc = await espaldaPair();
  const skeletonId = await setup(coach, ath, acc);
  await pool.query(
    `UPDATE users SET exercise_rotation_locked = TRUE WHERE id = $1`,
    [ath]
  );

  const client = await pool.connect();
  let rec;
  try {
    rec = await rotateOneExercise(client, ath, skeletonId, 3, () => 0);
  } finally {
    client.release();
  }

  expect(rec).toBeNull();
  const slot = await pool.query(
    `SELECT exercise_id FROM skeleton_slots WHERE skeleton_id = $1 AND slot_index = 2`,
    [skeletonId]
  );
  expect(slot.rows[0].exercise_id).toBe(acc);
});
