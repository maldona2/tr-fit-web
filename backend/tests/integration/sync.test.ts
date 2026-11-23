import { resetDatabase, ensureMigrated, closePool } from './helpers/test-db.js';
import { createAdmin, createAthlete } from './helpers/fixtures.js';
import { createPendingSkeleton, approveSkeleton } from '../../src/services/skeleton.service.js';
import { startSession } from '../../src/services/session.service.js';
import { syncSets } from '../../src/services/sync.service.js';
import pool from '../../src/db/connect.js';
import { randomUUID } from 'crypto';

beforeAll(async () => { await ensureMigrated(); });
beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

async function setupSession() {
  const coach = await createAdmin();
  const ath = await createAthlete(coach);
  const p = await pool.query<{ id: number }>(
    `SELECT id FROM exercises WHERE is_principal = TRUE LIMIT 1`,
  );
  const ai = {
    rationale: 'r',
    days: [1, 2, 3, 4].map((d) => ({
      day_index: d, focus: 'd',
      slots: [{ slot_index: 1, exercise_id: p.rows[0].id, role: 'principal' as const, notes: null, series: null, reps: null, descanso: null }],
    })),
  };
  const sk = await createPendingSkeleton(
    { athleteId: ath, generationPrompt: {}, generationRationale: '' }, ai,
  );
  await approveSkeleton(sk.skeletonId, coach);
  await pool.query(
    `UPDATE athlete_program_state SET current_week = 3 WHERE athlete_id = $1`,
    [ath],
  );
  const { sessionId } = await startSession(ath, randomUUID());
  return { ath, sessionId, principalId: p.rows[0].id };
}

it('syncSets accepts all on first sync, idempotent on re-sync', async () => {
  const { ath, sessionId, principalId } = await setupSession();
  const sets = [1, 2, 3].map((i) => ({
    exercise_id: principalId, set_index: i, unit: 'kg' as const, value: 80, reps: 8,
    completed: true, client_id: randomUUID(),
    client_ts: new Date().toISOString(),
  }));
  const r1 = await syncSets(ath, sessionId, sets);
  expect(r1.accepted).toHaveLength(3);
  expect(r1.conflicts).toHaveLength(0);

  const r2 = await syncSets(ath, sessionId, sets);
  expect(r2.accepted).toHaveLength(3);
  const cnt = await pool.query(
    `SELECT COUNT(*)::int AS n FROM set_logs WHERE session_log_id = $1`,
    [sessionId],
  );
  expect(cnt.rows[0].n).toBe(3);
});

it('syncSets rejects with older_ts when existing has newer ts', async () => {
  const { ath, sessionId, principalId } = await setupSession();
  const clientId = randomUUID();
  const newer = new Date(Date.now() + 60_000).toISOString();
  const older = new Date(Date.now() - 60_000).toISOString();

  await syncSets(ath, sessionId, [{
    exercise_id: principalId, set_index: 1, unit: 'kg' as const, value: 80, reps: 8,
    completed: true, client_id: clientId, client_ts: newer,
  }]);

  const r2 = await syncSets(ath, sessionId, [{
    exercise_id: principalId, set_index: 1, unit: 'kg' as const, value: 70, reps: 8,
    completed: true, client_id: clientId, client_ts: older,
  }]);
  expect(r2.conflicts).toHaveLength(1);
  expect(r2.conflicts[0].reason).toBe('older_ts');
});

it('syncSets returns not_found for foreign session', async () => {
  const { sessionId, principalId } = await setupSession();
  const otherR = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role)
     VALUES ('foreign@t.local', 'x', 'athlete') RETURNING id`,
  );
  const r = await syncSets(otherR.rows[0].id, sessionId, [{
    exercise_id: principalId, set_index: 1, unit: 'kg' as const, value: 80, reps: 8,
    completed: true, client_id: randomUUID(),
    client_ts: new Date().toISOString(),
  }]);
  expect(r.conflicts).toHaveLength(1);
  expect(r.conflicts[0].reason).toBe('not_found');
});

it('syncSets seeds the weight suggestion, also for a swapped exercise (máquina ocupada offline)', async () => {
  const { ath, sessionId, principalId } = await setupSession();
  // Ejercicio fuera de la rutina: lo que loguea el atleta tras un swap.
  const alt = await pool.query<{ id: number }>(
    `SELECT id FROM exercises WHERE id <> $1 AND equipment <> 'bw' LIMIT 1`,
    [principalId],
  );
  const altId = alt.rows[0].id;
  const r = await syncSets(ath, sessionId, [{
    exercise_id: altId, set_index: 1, unit: 'kg' as const, value: 42.5, reps: 10,
    completed: true, client_id: randomUUID(), client_ts: new Date().toISOString(),
  }]);
  expect(r.accepted).toHaveLength(1);

  const w = await pool.query<{ v: string; scheme: string }>(
    `SELECT current_value::text AS v, scheme FROM athlete_exercise_weights
      WHERE athlete_id = $1 AND exercise_id = $2`,
    [ath, altId],
  );
  expect(w.rows.map((x) => [Number(x.v), x.scheme])).toEqual([[42.5, 'normal']]);
});

it('syncSets counts a dropset series once and seeds only the heaviest drop', async () => {
  const { ath, sessionId, principalId } = await setupSession();
  const drops = [60, 45, 30].map((value, i) => ({
    exercise_id: principalId, set_index: 1, unit: 'kg' as const, value, reps: 8,
    completed: true, drop_index: i + 1, client_id: randomUUID(),
    client_ts: new Date().toISOString(),
  }));
  await syncSets(ath, sessionId, drops);

  const s = await pool.query<{ n: number }>(
    `SELECT total_sets_completed AS n FROM session_logs WHERE id = $1`,
    [sessionId],
  );
  expect(s.rows[0].n).toBe(1);
  const w = await pool.query<{ v: string }>(
    `SELECT current_value::text AS v FROM athlete_exercise_weights
      WHERE athlete_id = $1 AND exercise_id = $2 AND scheme = 'dropset'`,
    [ath, principalId],
  );
  expect(Number(w.rows[0].v)).toBe(60);
});
