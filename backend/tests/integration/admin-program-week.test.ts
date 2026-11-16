import request from 'supertest';
import { resetDatabase, ensureMigrated, closePool } from './helpers/test-db.js';
import pool from '../../src/db/connect.js';
import { signToken } from '../../src/middleware/auth.js';
import { createAdmin, createAthlete } from './helpers/fixtures.js';
import {
  createPendingSkeleton,
  approveSkeleton,
} from '../../src/services/skeleton.service.js';
import {
  buildTodaySession,
  listPendingDays,
} from '../../src/services/engine.service.js';
import { runWeeklyProgressionForAthlete } from '../../src/services/progression.service.js';
import app from '../../src/app.js';

beforeAll(async () => {
  await ensureMigrated();
});
beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

const aiOut = {
  rationale: 'test split',
  days: [
    {
      day_index: 1,
      focus: 'pecho',
      slots: [
        {
          slot_index: 1,
          exercise_id: 1,
          role: 'principal' as const,
          notes: null,
          series: null,
          reps: null,
          descanso: null,
        },
      ],
    },
  ],
};

async function setup() {
  const adminId = await createAdmin();
  const athleteId = await createAthlete(adminId, { days_per_week: 4 });
  const { skeletonId } = await createPendingSkeleton(
    { athleteId, generationPrompt: {}, generationRationale: 'r' },
    aiOut
  );
  await approveSkeleton(skeletonId, adminId);
  const tok = signToken({ id: adminId, role: 'admin' });
  return { adminId, athleteId, skeletonId, tok };
}

async function logSet(
  athleteId: string,
  skeletonId: string,
  week: number,
  kg: number,
  daysAgo: number
) {
  const sess = await pool.query<{ id: string }>(
    `INSERT INTO session_logs
       (athlete_id, skeleton_id, program_week, day_of_week, started_at, finished_at)
     VALUES ($1, $2, $3, 1, NOW() - ($4 || ' days')::interval,
             NOW() - ($4 || ' days')::interval)
     RETURNING id`,
    [athleteId, skeletonId, week, String(daysAgo)]
  );
  await pool.query(
    `INSERT INTO set_logs
       (athlete_id, exercise_id, week, day_of_week, set_index,
        weight_kg, value, unit, reps, completed, rpe, session_log_id, logged_at)
     VALUES ($1, 1, $2, 1, 1, $3, $3, 'kg', 6, TRUE, 9, $4,
             NOW() - ($5 || ' days')::interval)`,
    [athleteId, week, kg, sess.rows[0].id, String(daysAgo)]
  );
}

describe('POST /api/admin/rutinas/atleta/:id/program-week', () => {
  it('sends the athlete back to a week and makes them train it again', async () => {
    const { athleteId, skeletonId, tok } = await setup();
    await pool.query(
      `UPDATE athlete_program_state SET current_week = 9 WHERE athlete_id = $1`,
      [athleteId]
    );
    await pool.query(
      `UPDATE athlete_exercise_weights
          SET current_value = 90, current_weight_kg = 90, unit = 'kg'
        WHERE athlete_id = $1 AND exercise_id = 1 AND scheme = 'normal'`,
      [athleteId]
    );
    // Semana 5 es la base de la 6. La 6 ya fue entrenada: no debe contar.
    await logSet(athleteId, skeletonId, 5, 60, 20);
    await logSet(athleteId, skeletonId, 6, 100, 10);

    const same = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/program-week`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ week: 9 });
    expect(same.status).toBe(200);
    expect(same.body.current_week).toBe(9);
    const untouched = await pool.query<{ program_reset_at: Date | null }>(
      `SELECT program_reset_at FROM athlete_program_state WHERE athlete_id = $1`,
      [athleteId]
    );
    expect(untouched.rows[0].program_reset_at).toBeNull();

    const res = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/program-week`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ week: 6 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      current_week: 6,
      rm_test_blocking: false,
    });

    const state = await pool.query<{
      current_week: number;
      program_reset_at: Date | null;
      last_week_advanced_at: Date | null;
    }>(
      `SELECT current_week, program_reset_at, last_week_advanced_at
         FROM athlete_program_state WHERE athlete_id = $1`,
      [athleteId]
    );
    expect(state.rows[0].current_week).toBe(6);
    expect(state.rows[0].program_reset_at).not.toBeNull();
    expect(state.rows[0].last_week_advanced_at).not.toBeNull();

    const weight = await pool.query<{ current_value: string }>(
      `SELECT current_value::text FROM athlete_exercise_weights
        WHERE athlete_id = $1 AND exercise_id = 1 AND scheme = 'normal'`,
      [athleteId]
    );
    expect(Number(weight.rows[0].current_value)).toBe(90);

    // El día 1 de la semana 6 vieja no cuenta: hay que volver a hacerlo.
    expect(await listPendingDays(athleteId)).toEqual([1, 2, 3, 4]);

    const session = await buildTodaySession(athleteId, 1);
    const principal = session.find((item) => item.exercise.id === 1);
    expect(principal?.series).toBe(3);
    expect(principal?.reps).toBe('6');
    // Prescripción de la semana 6 desde la semana 5 (60), no el AEW de la 9 (90)
    // ni el log viejo de la 6 (100). RPE 9 frena el incremento.
    expect(principal?.suggested_value).toBe(60);

    const progression = await runWeeklyProgressionForAthlete(athleteId);
    expect(progression.fromWeek).toBe(6);
    expect(progression.toWeek).toBe(6);

    const audit = await pool.query<{
      meta: { from_week: number; to_week: number };
    }>(
      `SELECT meta FROM admin_audit_log
        WHERE target_id = $1 AND type = 'program_week_set'`,
      [athleteId]
    );
    expect(audit.rows[0].meta).toMatchObject({ from_week: 9, to_week: 6 });

    const detail = await request(app)
      .get(`/api/admin/rutinas/atleta/${athleteId}`)
      .set('Authorization', `Bearer ${tok}`);
    expect(detail.body.rutina.current_week).toBe(6);
    expect(detail.body.rutina.total_weeks).toBeGreaterThanOrEqual(30);
  });

  it('rejects an open session and a week outside the plan', async () => {
    const { athleteId, skeletonId, tok } = await setup();
    await pool.query(
      `INSERT INTO session_logs (athlete_id, skeleton_id, program_week, day_of_week)
       VALUES ($1, $2, 1, 1)`,
      [athleteId, skeletonId]
    );
    const blocked = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/program-week`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ week: 6 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('session_in_progress');

    const bad = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/program-week`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ week: 31 });
    expect(bad.status).toBe(400);
  });

  it('marks an RM week as blocking when the coach sends them there', async () => {
    const { athleteId, tok } = await setup();
    const res = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/program-week`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ week: 10 });
    expect(res.status).toBe(200);
    expect(res.body.rm_test_blocking).toBe(true);
  });
});
