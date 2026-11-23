export {};
// GET /api/admin/users/:id/rotations lists the automatic accessory swaps with
// exercise names, newest first.
const { resetDatabase, ensureMigrated, closePool } =
  await import('./helpers/test-db.js');
const { signToken } = await import('../../src/middleware/auth.js');
const { createAdmin, createAthlete } = await import('./helpers/fixtures.js');
const { createPendingSkeleton, approveSkeleton } =
  await import('../../src/services/skeleton.service.js');
const poolMod = await import('../../src/db/connect.js');
const pool = poolMod.default;
const requestMod = await import('supertest');
const request = requestMod.default;
const appMod = await import('../../src/app.js');
const app = appMod.default;

beforeAll(async () => {
  await ensureMigrated();
});
beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

it('returns rotations with exercise names, newest first', async () => {
  const adminId = await createAdmin();
  const token = signToken({ id: adminId, role: 'admin' });
  const athleteId = await createAthlete(adminId);
  const ex = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM exercises ORDER BY id LIMIT 3`
  );
  const [a, b, c] = ex.rows;
  const { skeletonId } = await createPendingSkeleton(
    { athleteId, generationPrompt: {}, generationRationale: '' },
    {
      rationale: 'r',
      days: [
        {
          day_index: 1,
          focus: 'd',
          slots: [
            {
              slot_index: 1,
              exercise_id: a.id,
              role: 'accesorio' as const,
              notes: null,
              series: null,
              reps: null,
              descanso: null,
            },
          ],
        },
      ],
    }
  );
  await approveSkeleton(skeletonId, adminId);
  const slot = await pool.query<{ id: string }>(
    `SELECT id FROM skeleton_slots WHERE skeleton_id = $1`,
    [skeletonId]
  );
  await pool.query(
    `INSERT INTO exercise_rotations
       (athlete_id, skeleton_id, slot_id, day_of_week, program_week,
        muscle_group, from_exercise_id, to_exercise_id, created_at)
     VALUES ($1, $2, $3, 1, 3, 'Espalda', $4, $5, NOW() - INTERVAL '14 days'),
            ($1, $2, $3, 1, 5, 'Pecho', $5, $6, NOW())`,
    [athleteId, skeletonId, slot.rows[0].id, a.id, b.id, c.id]
  );

  const res = await request(app)
    .get(`/api/admin/users/${athleteId}/rotations`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(2);
  expect(res.body[0]).toMatchObject({
    program_week: 5,
    muscle_group: 'Pecho',
    from_name: b.name,
    to_name: c.name,
  });
  expect(res.body[1].program_week).toBe(3);
});

it('rejects non-admin users', async () => {
  const adminId = await createAdmin();
  const athleteId = await createAthlete(adminId);
  const token = signToken({ id: athleteId, role: 'athlete' });
  const res = await request(app)
    .get(`/api/admin/users/${athleteId}/rotations`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(403);
});

it('toggles the rotation lock', async () => {
  const adminId = await createAdmin();
  const token = signToken({ id: adminId, role: 'admin' });
  const athleteId = await createAthlete(adminId);
  const auth = { Authorization: `Bearer ${token}` };

  const g = await request(app)
    .get(`/api/admin/users/${athleteId}/rotation-lock`)
    .set(auth);
  expect(g.body).toEqual({ locked: false });

  const p = await request(app)
    .put(`/api/admin/users/${athleteId}/rotation-lock`)
    .set(auth)
    .send({ locked: true });
  expect(p.body).toEqual({ locked: true });

  const bad = await request(app)
    .put(`/api/admin/users/${athleteId}/rotation-lock`)
    .set(auth)
    .send({ locked: 'yes' });
  expect(bad.status).toBe(400);
});
