import { resetDatabase, ensureMigrated, closePool } from './helpers/test-db.js';
import { createAdmin, createAthlete } from './helpers/fixtures.js';
import { createPendingSkeleton, approveSkeleton } from '../../src/services/skeleton.service.js';
import { startSession, closeStaleSessions } from '../../src/services/session.service.js';
import pool from '../../src/db/connect.js';
import { randomUUID } from 'node:crypto';

// Sesiones olvidadas abiertas trababan al atleta al día siguiente
// (session_in_progress). Se cierran solas al iniciar, y el cron del domingo
// barre las que quedan antes de la progresión.

beforeAll(async () => { await ensureMigrated(); });
beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

async function setup() {
  const coach = await createAdmin();
  const ath = await createAthlete(coach, { days_per_week: 3 });
  const ex = await pool.query<{ id: number }>(
    `SELECT id FROM exercises WHERE is_principal = TRUE ORDER BY id LIMIT 1`,
  );
  const exId = ex.rows[0].id;
  const day = (d: number) => ({
    day_index: d, focus: `D${d}`,
    slots: [{ slot_index: 1, exercise_id: exId, role: 'principal' as const, notes: null, series: null, reps: null, descanso: null }],
  });
  const { skeletonId } = await createPendingSkeleton(
    { athleteId: ath, generationPrompt: {}, generationRationale: 'r' },
    { rationale: 'r', days: [day(1), day(2), day(3)] },
  );
  await approveSkeleton(skeletonId, coach);
  return { ath, skeletonId, exId };
}

/** Open (unfinished) session on day 1, optionally with one completed set. */
async function openSession(
  ath: string, sk: string, startedAt: string, set?: { exId: number; at: string },
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO session_logs
       (athlete_id, skeleton_id, program_week, day_of_week,
        total_sets_target, total_sets_completed, client_id, started_at)
     SELECT $1, $2, current_week, 1, 1, 0, gen_random_uuid(), $3
       FROM athlete_program_state WHERE athlete_id = $1
     RETURNING id`,
    [ath, sk, startedAt],
  );
  const id = r.rows[0].id;
  if (set) {
    await pool.query(
      `INSERT INTO set_logs
         (athlete_id, exercise_id, week, day_of_week, set_index, value, unit,
          reps, completed, session_log_id, client_id, client_ts)
       VALUES ($1, $2, 1, 1, 1, 50, 'kg', 8, TRUE, $3, gen_random_uuid(), $4)`,
      [ath, set.exId, id, set.at],
    );
  }
  return id;
}

const at = (iso: string) => new Date(iso);

it('yesterday open session with sets is closed at its last set; today starts', async () => {
  const { ath, skeletonId, exId } = await setup();
  const old = await openSession(ath, skeletonId, '2026-10-07T10:00:00-03:00',
    { exId, at: '2026-10-07T10:40:00-03:00' });

  const out = await startSession(ath, randomUUID(), { dayOfWeek: 2, now: at('2026-10-08T09:00:00-03:00') });
  expect(out.expectedDay).toBe(2);

  const r = await pool.query(
    `SELECT finished_at, fatigue_rating, duration_seconds FROM session_logs WHERE id = $1`, [old],
  );
  expect(new Date(r.rows[0].finished_at).toISOString()).toBe('2026-10-07T13:40:00.000Z');
  expect(r.rows[0].fatigue_rating).toBeNull();
  expect(r.rows[0].duration_seconds).toBe(40 * 60);
});

it('yesterday open session with no sets is deleted (day stays pending)', async () => {
  const { ath, skeletonId } = await setup();
  const old = await openSession(ath, skeletonId, '2026-10-07T10:00:00-03:00');

  const out = await startSession(ath, randomUUID(), { now: at('2026-10-08T09:00:00-03:00') });
  expect(out.expectedDay).toBe(1);
  const r = await pool.query(`SELECT 1 FROM session_logs WHERE id = $1`, [old]);
  expect(r.rowCount).toBe(0);
});

it('an open session from today is left alone', async () => {
  const { ath, skeletonId } = await setup();
  await openSession(ath, skeletonId, '2026-10-08T08:00:00-03:00');
  await expect(
    startSession(ath, randomUUID(), { dayOfWeek: 2, now: at('2026-10-08T09:00:00-03:00') }),
  ).rejects.toMatchObject({ reason: 'session_in_progress' });
});

it('cron sweep closes sessions open longer than N hours only', async () => {
  const { ath, skeletonId, exId } = await setup();
  const old = await openSession(ath, skeletonId, '2026-10-11T15:00:00-03:00',
    { exId, at: '2026-10-11T15:30:00-03:00' });
  const closed = await closeStaleSessions({ olderThanHours: 3, now: at('2026-10-11T23:00:00-03:00') });
  expect(closed).toBe(1);
  const r = await pool.query(`SELECT finished_at FROM session_logs WHERE id = $1`, [old]);
  expect(r.rows[0].finished_at).not.toBeNull();

  const fresh = await openSession(ath, skeletonId, '2026-10-11T22:00:00-03:00');
  expect(await closeStaleSessions({ olderThanHours: 3, now: at('2026-10-11T23:00:00-03:00') })).toBe(0);
  const f = await pool.query(`SELECT finished_at FROM session_logs WHERE id = $1`, [fresh]);
  expect(f.rows[0].finished_at).toBeNull();
});
