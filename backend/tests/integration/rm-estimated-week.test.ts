import { resetDatabase, ensureMigrated, closePool } from './helpers/test-db.js';
import { createAdmin, createAthlete } from './helpers/fixtures.js';
import { createPendingSkeleton, approveSkeleton } from '../../src/services/skeleton.service.js';
import {
  recordRm,
  recordEstimatedRmIfAbsent,
  ensureEstimatedRmsFromWeekLogs,
} from '../../src/services/rm.service.js';
import { estimateEpley1RM } from '../../src/services/epley.service.js';
import pool from '../../src/db/connect.js';

beforeAll(async () => { await ensureMigrated(); });
beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

async function setup(coachId: string, athleteId: string, principals: number[]) {
  const ai = {
    rationale: 'r',
    days: principals.map((id, i) => ({
      day_index: i + 1, focus: 'd',
      slots: [{ slot_index: 1, exercise_id: id, role: 'principal' as const, notes: null, series: null, reps: null, descanso: null }],
    })),
  };
  const { skeletonId } = await createPendingSkeleton(
    { athleteId, generationPrompt: {}, generationRationale: '' }, ai,
  );
  await approveSkeleton(skeletonId, coachId);
  return skeletonId;
}

async function seedWeek10Set(
  athleteId: string,
  skeletonId: string,
  exerciseId: number,
  weight: number,
  reps: number,
) {
  const s = await pool.query<{ id: string }>(
    `INSERT INTO session_logs
       (athlete_id, skeleton_id, program_week, day_of_week, started_at, finished_at)
     VALUES ($1, $2, 10, 1, NOW() - INTERVAL '1 hour', NOW())
     RETURNING id`,
    [athleteId, skeletonId],
  );
  await pool.query(
    `INSERT INTO set_logs
       (athlete_id, exercise_id, week, day_of_week, set_index,
        weight_kg, value, reps, completed, session_log_id)
     VALUES ($1, $2, 10, 1, 1, $3, $3, $4, TRUE, $5)`,
    [athleteId, exerciseId, weight, reps, s.rows[0].id],
  );
}

it('does not overwrite a real RM with an estimate', async () => {
  const coach = await createAdmin();
  const ath = await createAthlete(coach);
  const ex = await pool.query<{ id: number }>(
    `SELECT id FROM exercises WHERE is_principal = TRUE LIMIT 1`,
  );
  await setup(coach, ath, [ex.rows[0].id]);
  await recordRm({
    athleteId: ath, exerciseId: ex.rows[0].id, valueKg: 200, week: 10,
  });
  const { inserted } = await recordEstimatedRmIfAbsent({
    athleteId: ath,
    exerciseId: ex.rows[0].id,
    valueKg: 150,
    week: 10,
    sourceWeight: 100,
    sourceReps: 5,
  });
  expect(inserted).toBe(false);
  const r = await pool.query(
    `SELECT value_kg::float8 AS v FROM rm_tests WHERE athlete_id = $1`, [ath],
  );
  expect(r.rows).toHaveLength(1);
  expect(Number(r.rows[0].v)).toBe(200);
});

it('backfills estimated RM from week-10 logs for missing principals', async () => {
  const coach = await createAdmin();
  const ath = await createAthlete(coach);
  const ex = await pool.query<{ id: number; equipment: string }>(
    `SELECT id, equipment FROM exercises WHERE is_principal = TRUE LIMIT 1`,
  );
  const skeletonId = await setup(coach, ath, [ex.rows[0].id]);
  await seedWeek10Set(ath, skeletonId, ex.rows[0].id, 100, 5);

  const { filled } = await ensureEstimatedRmsFromWeekLogs(ath, 10);
  expect(filled).toBe(1);

  const expected = estimateEpley1RM(100, 5, ex.rows[0].equipment);
  const r = await pool.query(
    `SELECT value_kg::float8 AS v, amrap_weight::float8 AS sw, amrap_reps AS sr
       FROM rm_tests WHERE athlete_id = $1 AND program_week = 10`,
    [ath],
  );
  expect(r.rows).toHaveLength(1);
  expect(Number(r.rows[0].v)).toBe(expected);
  expect(Number(r.rows[0].sw)).toBe(100);
  expect(Number(r.rows[0].sr)).toBe(5);

  const again = await ensureEstimatedRmsFromWeekLogs(ath, 10);
  expect(again.filled).toBe(0);
});

it('skips principals that already have a real RM when backfilling', async () => {
  const coach = await createAdmin();
  const ath = await createAthlete(coach);
  const ex = await pool.query<{ id: number }>(
    `SELECT id FROM exercises WHERE is_principal = TRUE LIMIT 1`,
  );
  const skeletonId = await setup(coach, ath, [ex.rows[0].id]);
  await recordRm({
    athleteId: ath, exerciseId: ex.rows[0].id, valueKg: 180, week: 10,
  });
  await seedWeek10Set(ath, skeletonId, ex.rows[0].id, 100, 5);
  const { filled } = await ensureEstimatedRmsFromWeekLogs(ath, 10);
  expect(filled).toBe(0);
  const r = await pool.query(
    `SELECT value_kg::float8 AS v FROM rm_tests WHERE athlete_id = $1`, [ath],
  );
  expect(Number(r.rows[0].v)).toBe(180);
});
