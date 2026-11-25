import request from 'supertest';
import { resetDatabase, ensureMigrated, closePool } from './helpers/test-db.js';
import pool from '../../src/db/connect.js';
import { signToken } from '../../src/middleware/auth.js';
import { createAdmin, createAthlete } from './helpers/fixtures.js';
import {
  createPendingSkeleton,
  approveSkeleton,
  listPendingForCoach,
} from '../../src/services/skeleton.service.js';
import { buildTodaySession } from '../../src/services/engine.service.js';
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

// Minimal AI output fixture — uses exercise_ids 1 and 2 which are seeded.
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
        {
          slot_index: 2,
          exercise_id: 2,
          role: 'accesorio' as const,
          notes: null,
          series: 2,
          reps: '10x10x10',
          descanso: '2 min',
        },
      ],
    },
    {
      day_index: 2,
      focus: 'espalda',
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

/** Helper: create admin + athlete + approved skeleton. Returns ids + admin token. */
async function setupActiveRutina() {
  const adminId = await createAdmin();
  const athleteId = await createAthlete(adminId);
  const { skeletonId } = await createPendingSkeleton(
    { athleteId, generationPrompt: {}, generationRationale: 'r' },
    aiOut
  );
  await approveSkeleton(skeletonId, adminId);
  const tok = signToken({ id: adminId, role: 'admin' });
  return { adminId, athleteId, skeletonId, tok };
}

// ── Test 1: GET /api/admin/rutinas/atleta lists athletes with active skeleton ──

describe('GET /api/admin/rutinas/atleta', () => {
  it('200 returns list including athlete with active approved skeleton', async () => {
    const { athleteId, tok } = await setupActiveRutina();

    const r = await request(app)
      .get('/api/admin/rutinas/atleta')
      .set('Authorization', `Bearer ${tok}`);

    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('items');
    expect(Array.isArray(r.body.items)).toBe(true);
    expect(r.body.items.length).toBeGreaterThanOrEqual(1);
    const athleteIds = r.body.items.map(
      (a: { athlete_id: string }) => a.athlete_id
    );
    expect(athleteIds).toContain(athleteId);
  });

  // ── Test 2: 403 for non-admin token ──
  it('403 for athlete token', async () => {
    const adminId = await createAdmin();
    const athleteId = await createAthlete(adminId);
    const tok = signToken({ id: athleteId, role: 'athlete' });

    const r = await request(app)
      .get('/api/admin/rutinas/atleta')
      .set('Authorization', `Bearer ${tok}`);

    expect(r.status).toBe(403);
  });
});

// ── Test 3: GET /api/admin/rutinas/atleta/:athleteId envelope when no active routine ──

describe('GET /api/admin/rutinas/atleta/:athleteId', () => {
  it('200 with rutina=null, pending_skeleton_id=null when athlete has no skeleton', async () => {
    const adminId = await createAdmin();
    const athleteId = await createAthlete(adminId);
    const tok = signToken({ id: adminId, role: 'admin' });

    const r = await request(app)
      .get(`/api/admin/rutinas/atleta/${athleteId}`)
      .set('Authorization', `Bearer ${tok}`);

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ rutina: null, pending_skeleton_id: null });
  });

  it('200 surfaces pending_skeleton_id when athlete has pending_review skeleton but no active', async () => {
    const adminId = await createAdmin();
    const athleteId = await createAthlete(adminId);
    const { skeletonId } = await createPendingSkeleton(
      { athleteId, generationPrompt: {}, generationRationale: 'r' },
      aiOut
    );
    const tok = signToken({ id: adminId, role: 'admin' });

    const r = await request(app)
      .get(`/api/admin/rutinas/atleta/${athleteId}`)
      .set('Authorization', `Bearer ${tok}`);

    expect(r.status).toBe(200);
    expect(r.body.rutina).toBeNull();
    expect(r.body.pending_skeleton_id).toBe(skeletonId);
  });

  it('200 returns rutina with pending_skeleton_id=null when active routine exists', async () => {
    const { athleteId, tok } = await setupActiveRutina();

    const r = await request(app)
      .get(`/api/admin/rutinas/atleta/${athleteId}`)
      .set('Authorization', `Bearer ${tok}`);

    expect(r.status).toBe(200);
    expect(r.body.pending_skeleton_id).toBeNull();
    expect(r.body.rutina).not.toBeNull();
    expect(r.body.rutina.profile.user_id).toBe(athleteId);
  });

  it('returns 400 for malformed athlete UUID', async () => {
    const adminId = await createAdmin();
    const adminToken = signToken({ id: adminId, role: 'admin' });

    const r = await request(app)
      .get('/api/admin/rutinas/atleta/not-a-uuid')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_uuid');
  });
});

// ── Test 4: PATCH /api/admin/rutinas/slots/:slotId updates notes ──

describe('PATCH /api/admin/rutinas/slots/:slotId', () => {
  it('200 updates notes and persists to DB', async () => {
    const { athleteId, skeletonId, tok } = await setupActiveRutina();

    // Fetch the first slot id
    const slotsR = await pool.query<{ id: string }>(
      `SELECT id FROM skeleton_slots WHERE skeleton_id = $1 ORDER BY day_of_week, slot_index LIMIT 1`,
      [skeletonId]
    );
    const slotId = slotsR.rows[0].id;

    const r = await request(app)
      .patch(`/api/admin/rutinas/slots/${slotId}`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ notes: 'updated' });

    expect(r.status).toBe(200);
    expect(r.body.slot.notes).toBe('updated');

    // Verify DB
    const dbRow = await pool.query<{ notes: string }>(
      `SELECT notes FROM skeleton_slots WHERE id = $1`,
      [slotId]
    );
    expect(dbRow.rows[0].notes).toBe('updated');
    void athleteId; // suppress unused warning
  });

  // ── Test 5: 409 when parent skeleton is superseded ──
  it('409 when parent skeleton is superseded', async () => {
    const { skeletonId, tok } = await setupActiveRutina();

    const slotsR = await pool.query<{ id: string }>(
      `SELECT id FROM skeleton_slots WHERE skeleton_id = $1 LIMIT 1`,
      [skeletonId]
    );
    const slotId = slotsR.rows[0].id;

    // Manually supersede the skeleton
    await pool.query(
      `UPDATE athlete_skeletons SET status = 'superseded' WHERE id = $1`,
      [skeletonId]
    );

    const r = await request(app)
      .patch(`/api/admin/rutinas/slots/${slotId}`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ notes: 'should fail' });

    expect(r.status).toBe(409);
    expect(r.body.error).toBe('rutina_not_active');
  });

  // ── Test 6: 400 when exercise_id is invalid / archived ──
  it('400 when exercise_id does not exist', async () => {
    const { skeletonId, tok } = await setupActiveRutina();

    const slotsR = await pool.query<{ id: string }>(
      `SELECT id FROM skeleton_slots WHERE skeleton_id = $1 LIMIT 1`,
      [skeletonId]
    );
    const slotId = slotsR.rows[0].id;

    const r = await request(app)
      .patch(`/api/admin/rutinas/slots/${slotId}`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ exercise_id: 999999 });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_exercise');
  });
});

// ── Test 7: POST /api/admin/rutinas/atleta/:athleteId/slots creates a slot ──

describe('POST /api/admin/rutinas/atleta/:athleteId/slots', () => {
  it('201 creates a slot with day_of_week', async () => {
    const { athleteId, tok } = await setupActiveRutina();

    const payload = {
      day_of_week: 1,
      slot_index: 3,
      exercise_id: 1,
      role: 'accesorio',
      notes: null,
    };

    const r = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/slots`)
      .set('Authorization', `Bearer ${tok}`)
      .send(payload);

    expect(r.status).toBe(201);
    expect(r.body).toHaveProperty('slot');
    expect(r.body.slot.day_of_week).toBe(payload.day_of_week);
    expect(r.body.slot.slot_index).toBe(payload.slot_index);
  });
});

// ── Test 8: DELETE /api/admin/rutinas/slots/:slotId returns 204 and removes ──

describe('DELETE /api/admin/rutinas/slots/:slotId', () => {
  it('204 deletes slot and row is gone from DB', async () => {
    const { skeletonId, tok } = await setupActiveRutina();

    const slotsR = await pool.query<{ id: string }>(
      `SELECT id FROM skeleton_slots WHERE skeleton_id = $1 LIMIT 1`,
      [skeletonId]
    );
    const slotId = slotsR.rows[0].id;

    const r = await request(app)
      .delete(`/api/admin/rutinas/slots/${slotId}`)
      .set('Authorization', `Bearer ${tok}`);

    expect(r.status).toBe(204);

    // Verify row is gone
    const check = await pool.query(
      `SELECT id FROM skeleton_slots WHERE id = $1`,
      [slotId]
    );
    expect(check.rowCount).toBe(0);
  });
});

// ── Test 9: POST /api/admin/rutinas/atleta/:athleteId/reorder reorders slots ──

describe('POST /api/admin/rutinas/atleta/:athleteId/reorder', () => {
  it('204 reorders 2 slots in the same day and persists new slot_indices', async () => {
    const { athleteId, skeletonId, tok } = await setupActiveRutina();

    // Fetch ALL slots for the skeleton — reorder requires a complete set
    const allSlotsR = await pool.query<{
      id: string;
      day_of_week: number;
      slot_index: number;
    }>(
      `SELECT id, day_of_week, slot_index FROM skeleton_slots
        WHERE skeleton_id = $1
        ORDER BY day_of_week, slot_index`,
      [skeletonId]
    );
    expect(allSlotsR.rows.length).toBeGreaterThanOrEqual(3);

    // Fetch the 2 slots in day 1 (aiOut has 2 slots on day_index 1)
    const day1Slots = allSlotsR.rows.filter((s) => s.day_of_week === 1);
    expect(day1Slots.length).toBeGreaterThanOrEqual(2);
    const [slotA, slotB] = day1Slots;

    // Build payload with ALL slots; swap the two day-1 slots, keep others unchanged
    const payload = {
      slots: allSlotsR.rows.map((s) => {
        if (s.id === slotA.id)
          return {
            slot_id: s.id,
            day_of_week: s.day_of_week,
            slot_index: slotB.slot_index,
          };
        if (s.id === slotB.id)
          return {
            slot_id: s.id,
            day_of_week: s.day_of_week,
            slot_index: slotA.slot_index,
          };
        return {
          slot_id: s.id,
          day_of_week: s.day_of_week,
          slot_index: s.slot_index,
        };
      }),
    };

    const r = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/reorder`)
      .set('Authorization', `Bearer ${tok}`)
      .send(payload);

    expect(r.status).toBe(204);

    // Verify DB — the two swapped slots have exchanged slot_index values
    const after = await pool.query<{ id: string; slot_index: number }>(
      `SELECT id, slot_index FROM skeleton_slots
        WHERE id = ANY($1::uuid[])`,
      [[slotA.id, slotB.id]]
    );
    const byId = Object.fromEntries(
      after.rows.map((row) => [row.id, row.slot_index])
    );
    expect(byId[slotA.id]).toBe(slotB.slot_index);
    expect(byId[slotB.id]).toBe(slotA.slot_index);
  });

  it('preserves per-slot prescription (series/reps/descanso) after reorder', async () => {
    const { athleteId, skeletonId, tok } = await setupActiveRutina();

    // aiOut seeds one accesorio with series=2, reps='10x10x10', descanso='2 min'
    const allSlotsR = await pool.query<{
      id: string;
      day_of_week: number;
      slot_index: number;
      series: number | null;
      reps: string | null;
      descanso: string | null;
    }>(
      `SELECT id, day_of_week, slot_index, series, reps, descanso
         FROM skeleton_slots
        WHERE skeleton_id = $1
        ORDER BY day_of_week, slot_index`,
      [skeletonId]
    );
    const accesorio = allSlotsR.rows.find((s) => s.series !== null);
    expect(accesorio).toBeDefined();

    // Swap the two day-1 slots (accesorio lives on day 1)
    const day1Slots = allSlotsR.rows.filter((s) => s.day_of_week === 1);
    const [slotA, slotB] = day1Slots;
    const payload = {
      slots: allSlotsR.rows.map((s) => {
        if (s.id === slotA.id)
          return {
            slot_id: s.id,
            day_of_week: s.day_of_week,
            slot_index: slotB.slot_index,
          };
        if (s.id === slotB.id)
          return {
            slot_id: s.id,
            day_of_week: s.day_of_week,
            slot_index: slotA.slot_index,
          };
        return {
          slot_id: s.id,
          day_of_week: s.day_of_week,
          slot_index: s.slot_index,
        };
      }),
    };

    const r = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/reorder`)
      .set('Authorization', `Bearer ${tok}`)
      .send(payload);
    expect(r.status).toBe(204);

    const after = await pool.query<{
      series: number | null;
      reps: string | null;
      descanso: string | null;
    }>(`SELECT series, reps, descanso FROM skeleton_slots WHERE id = $1`, [
      accesorio!.id,
    ]);
    expect(after.rows[0]).toEqual({
      series: 2,
      reps: '10x10x10',
      descanso: '2 min',
    });
  });
});

// ── apply-edits: atomic batched draft save from the activas editor ──

describe('POST /api/admin/rutinas/atleta/:athleteId/apply-edits', () => {
  it('uses an edited 10x10x10 prescription instead of stale progressed reps', async () => {
    const { athleteId, skeletonId, tok } = await setupActiveRutina();
    const slotR = await pool.query<{
      id: string;
      day_of_week: number;
      exercise_id: number;
    }>(
      `SELECT id, day_of_week, exercise_id
         FROM skeleton_slots
        WHERE skeleton_id = $1 AND role = 'accesorio'
        LIMIT 1`,
      [skeletonId]
    );
    const slot = slotR.rows[0];
    await pool.query(
      `UPDATE athlete_exercise_weights
          SET current_reps_text = '8 a 10', updated_by = 'progression_cron'
        WHERE athlete_id = $1 AND exercise_id = $2`,
      [athleteId, slot.exercise_id]
    );

    const response = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/apply-edits`)
      .set('Authorization', `Bearer ${tok}`)
      .send({
        slot_overrides: [
          {
            slot_id: slot.id,
            exercise_id: slot.exercise_id,
            notes: null,
            series: 2,
            reps: '10x10x10',
            descanso: '2 min',
          },
        ],
      });

    expect(response.status).toBe(204);
    const session = await buildTodaySession(athleteId, slot.day_of_week);
    expect(
      session.find((item) => item.exercise.id === slot.exercise_id)?.reps
    ).toBe('10x10x10');
  });

  it('renames a day muscle-group label, inserting the row if missing', async () => {
    const { athleteId, skeletonId, tok } = await setupActiveRutina();
    await pool.query(
      `DELETE FROM skeleton_days WHERE skeleton_id = $1 AND day_of_week = 2`,
      [skeletonId],
    );

    const r = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/apply-edits`)
      .set('Authorization', `Bearer ${tok}`)
      .send({
        day_focus: [
          { day_of_week: 1, focus: 'Espalda' },
          { day_of_week: 2, focus: 'Hombros' },
        ],
      });
    expect(r.status).toBe(204);

    const after = await pool.query<{ day_of_week: number; focus: string }>(
      `SELECT day_of_week, focus FROM skeleton_days
        WHERE skeleton_id = $1 ORDER BY day_of_week`,
      [skeletonId],
    );
    expect(after.rows).toEqual([
      { day_of_week: 1, focus: 'Espalda' },
      { day_of_week: 2, focus: 'Hombros' },
    ]);
  });

  it('swaps two whole days: slots and labels move together', async () => {
    const { athleteId, skeletonId, tok } = await setupActiveRutina();
    // Day 2 has no label, so the swap must clear day 1's rather than leave it.
    await pool.query(
      `DELETE FROM skeleton_days WHERE skeleton_id = $1 AND day_of_week = 2`,
      [skeletonId],
    );
    await pool.query(
      `INSERT INTO skeleton_days (skeleton_id, day_of_week, focus)
       VALUES ($1, 1, 'Pecho')
       ON CONFLICT (skeleton_id, day_of_week) DO UPDATE SET focus = 'Pecho'`,
      [skeletonId],
    );

    const before = await pool.query<{
      id: string;
      day_of_week: number;
      slot_index: number;
    }>(
      `SELECT id, day_of_week, slot_index FROM skeleton_slots
        WHERE skeleton_id = $1 ORDER BY day_of_week, slot_index`,
      [skeletonId],
    );

    const r = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/apply-edits`)
      .set('Authorization', `Bearer ${tok}`)
      .send({
        slot_order: before.rows.map((slot) => ({
          slot_id: slot.id,
          day_of_week: slot.day_of_week === 1 ? 2 : 1,
          slot_index: slot.slot_index,
        })),
        day_focus: [
          { day_of_week: 1, focus: '' },
          { day_of_week: 2, focus: 'Pecho' },
        ],
      });
    expect(r.status).toBe(204);

    const after = await pool.query<{ id: string; day_of_week: number }>(
      `SELECT id, day_of_week FROM skeleton_slots WHERE skeleton_id = $1`,
      [skeletonId],
    );
    const dayById = new Map(after.rows.map((slot) => [slot.id, slot.day_of_week]));
    for (const slot of before.rows) {
      expect(dayById.get(slot.id)).toBe(slot.day_of_week === 1 ? 2 : 1);
    }

    const days = await pool.query<{ day_of_week: number; focus: string }>(
      `SELECT day_of_week, focus FROM skeleton_days
        WHERE skeleton_id = $1 ORDER BY day_of_week`,
      [skeletonId],
    );
    expect(days.rows).toEqual([{ day_of_week: 2, focus: 'Pecho' }]);
  });

  it('204 applies override + add + delete + reorder in one call', async () => {
    const { athleteId, skeletonId, tok } = await setupActiveRutina();
    const slotsR = await pool.query<{
      id: string;
      day_of_week: number;
      slot_index: number;
      role: string;
    }>(
      `SELECT id, day_of_week, slot_index, role FROM skeleton_slots
        WHERE skeleton_id = $1 ORDER BY day_of_week, slot_index`,
      [skeletonId]
    );
    const day1 = slotsR.rows.filter((s) => s.day_of_week === 1);
    const day2 = slotsR.rows.filter((s) => s.day_of_week === 2);
    const [d1s1, d1s2] = day1;
    const addedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    const r = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/apply-edits`)
      .set('Authorization', `Bearer ${tok}`)
      .send({
        slot_overrides: [
          {
            slot_id: d1s2.id,
            exercise_id: 2,
            notes: 'editado',
            series: 3,
            reps: '8 a 10',
            descanso: '1 min',
          },
        ],
        deleted_slot_ids: [day2[0].id],
        added_slots: [
          {
            id: addedId,
            day_of_week: 1,
            exercise_id: 1,
            role: 'accesorio',
            notes: null,
            series: null,
            reps: null,
            descanso: null,
          },
        ],
        slot_order: [
          { slot_id: d1s2.id, day_of_week: 1, slot_index: 1 },
          { slot_id: d1s1.id, day_of_week: 1, slot_index: 2 },
          { slot_id: addedId, day_of_week: 1, slot_index: 3 },
        ],
      });
    expect(r.status).toBe(204);

    const after = await pool.query<{
      id: string;
      day_of_week: number;
      slot_index: number;
      notes: string | null;
      series: number | null;
      reps: string | null;
      descanso: string | null;
    }>(
      `SELECT id, day_of_week, slot_index, notes, series, reps, descanso
         FROM skeleton_slots WHERE skeleton_id = $1
        ORDER BY day_of_week, slot_index`,
      [skeletonId]
    );
    expect(after.rows).toHaveLength(3);
    expect(after.rows.map((s) => s.id)).toEqual([d1s2.id, d1s1.id, addedId]);
    expect(after.rows.find((s) => s.id === d1s2.id)).toMatchObject({
      notes: 'editado',
      series: 3,
      reps: '8 a 10',
      descanso: '1 min',
    });
  });

  it('rolls back everything when slot_order is incomplete', async () => {
    const { athleteId, skeletonId, tok } = await setupActiveRutina();
    const slotsR = await pool.query<{ id: string; day_of_week: number }>(
      `SELECT id, day_of_week FROM skeleton_slots WHERE skeleton_id = $1`,
      [skeletonId]
    );
    const day2Slot = slotsR.rows.find((s) => s.day_of_week === 2)!;
    const aDay1Slot = slotsR.rows.find((s) => s.day_of_week === 1)!;

    const r = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/apply-edits`)
      .set('Authorization', `Bearer ${tok}`)
      .send({
        deleted_slot_ids: [day2Slot.id],
        slot_order: [{ slot_id: aDay1Slot.id, day_of_week: 1, slot_index: 1 }],
      });
    expect(r.status).toBe(404);

    const count = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM skeleton_slots WHERE skeleton_id = $1`,
      [skeletonId]
    );
    expect(count.rows[0].c).toBe(3);
  });

  it('409 when athlete has no active skeleton', async () => {
    const adminId = await createAdmin();
    const athleteId = await createAthlete(adminId);
    const tok = signToken({ id: adminId, role: 'admin' });

    const r = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/apply-edits`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ deleted_slot_ids: [] });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('rutina_not_active');
  });

  it('seeds athlete_exercise_weights for added exercises', async () => {
    const { athleteId, tok } = await setupActiveRutina();
    const addedId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

    const r = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/apply-edits`)
      .set('Authorization', `Bearer ${tok}`)
      .send({
        added_slots: [
          {
            id: addedId,
            day_of_week: 2,
            exercise_id: 3,
            role: 'accesorio',
            notes: null,
            series: null,
            reps: null,
            descanso: null,
          },
        ],
      });
    expect(r.status).toBe(204);
    const weight = await pool.query(
      `SELECT 1 FROM athlete_exercise_weights
        WHERE athlete_id = $1 AND exercise_id = 3`,
      [athleteId]
    );
    expect(weight.rowCount).toBe(1);
  });

  it('can add into a day with a gap when its highest slot_index is 12', async () => {
    const { athleteId, skeletonId, tok } = await setupActiveRutina();
    const day1 = await pool.query<{ id: string; slot_index: number }>(
      `SELECT id, slot_index FROM skeleton_slots
        WHERE skeleton_id = $1 AND day_of_week = 1
        ORDER BY slot_index`,
      [skeletonId]
    );
    await pool.query(
      `UPDATE skeleton_slots SET slot_index = 12 WHERE id = $1`,
      [day1.rows[1].id]
    );
    const day2 = await pool.query<{ id: string }>(
      `SELECT id FROM skeleton_slots
        WHERE skeleton_id = $1 AND day_of_week = 2`,
      [skeletonId]
    );
    const addedId = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';

    const response = await request(app)
      .post(`/api/admin/rutinas/atleta/${athleteId}/apply-edits`)
      .set('Authorization', `Bearer ${tok}`)
      .send({
        deleted_slot_ids: [day1.rows[0].id],
        added_slots: [
          {
            id: addedId,
            day_of_week: 1,
            exercise_id: 3,
            role: 'accesorio',
          },
        ],
        slot_order: [
          { slot_id: day1.rows[1].id, day_of_week: 1, slot_index: 1 },
          { slot_id: addedId, day_of_week: 1, slot_index: 2 },
          {
            slot_id: day2.rows[0].id,
            day_of_week: 2,
            slot_index: 1,
          },
        ],
      });

    expect(response.status).toBe(204);
  });
});

// ── Test: listPendingForCoach dedups to one row per athlete ──

describe('listPendingForCoach', () => {
  it('returns one row per athlete (latest pending)', async () => {
    const coach = await createAdmin();
    const athlete = await createAthlete(coach);

    // Two accumulated pending skeletons for the same athlete.
    await pool.query(
      `INSERT INTO athlete_skeletons
         (athlete_id, status, generated_by, generation_prompt, generation_rationale)
       VALUES
         ($1,'pending_review','ai','{}'::jsonb,'older'),
         ($1,'pending_review','ai','{}'::jsonb,'newer')`,
      [athlete]
    );
    // Force a deterministic ordering: make 'newer' the latest.
    await pool.query(
      `UPDATE athlete_skeletons SET created_at = now() - interval '1 hour'
        WHERE athlete_id = $1 AND generation_rationale = 'older'`,
      [athlete]
    );

    const list = await listPendingForCoach(coach);
    const forAthlete = list.filter((r) => r.athlete_id === athlete);
    expect(forAthlete).toHaveLength(1);
    expect(forAthlete[0].generation_rationale).toBe('newer');
  });
});

describe('POST /api/admin/rutinas/:id/discard', () => {
  it('supersedes every pending skeleton of the athlete without regenerating', async () => {
    const adminId = await createAdmin();
    const athleteId = await createAthlete(adminId);
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO athlete_skeletons
         (athlete_id, status, generated_by, generation_prompt, generation_rationale, created_at)
       VALUES
         ($1,'pending_review','ai','{}'::jsonb,'older', now() - interval '1 hour'),
         ($1,'pending_review','ai','{}'::jsonb,'newer', now())
       RETURNING id`,
      [athleteId]
    );
    const newerId = ins.rows[1].id;
    const tok = signToken({ id: adminId, role: 'admin' });

    const before = await pool.query(
      `SELECT count(*)::int AS n FROM athlete_skeletons WHERE athlete_id = $1`,
      [athleteId]
    );

    const r = await request(app)
      .post(`/api/admin/rutinas/${newerId}/discard`)
      .set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(204);

    // Both pendings (visible + hidden older one) are superseded and reviewed.
    const rows = await pool.query(
      `SELECT status, reviewed_by FROM athlete_skeletons WHERE athlete_id = $1`,
      [athleteId]
    );
    expect(rows.rows).toHaveLength(before.rows[0].n);
    for (const row of rows.rows) {
      expect(row.status).toBe('superseded');
      expect(row.reviewed_by).toBe(adminId);
    }

    // Gone from the queue, and no regenerated replacement.
    const list = await listPendingForCoach(adminId);
    expect(list.filter((p) => p.athlete_id === athleteId)).toHaveLength(0);
  });

  it('returns 409 when the skeleton was already processed', async () => {
    const { skeletonId, tok } = await setupActiveRutina();
    const r = await request(app)
      .post(`/api/admin/rutinas/${skeletonId}/discard`)
      .set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('not_pending');
  });

  it('returns 404 for an unknown skeleton', async () => {
    const adminId = await createAdmin();
    const tok = signToken({ id: adminId, role: 'admin' });
    const r = await request(app)
      .post(`/api/admin/rutinas/00000000-0000-4000-8000-000000000000/discard`)
      .set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(404);
  });
});

describe('Admin picks a coach template for a pending rutina', () => {
  it('lists templates and replaces the pending slots in place', async () => {
    const adminId = await createAdmin();
    const athleteId = await createAthlete(adminId);
    const { skeletonId } = await createPendingSkeleton(
      { athleteId, generationPrompt: {}, generationRationale: 'r' },
      aiOut
    );
    const tok = signToken({ id: adminId, role: 'admin' });

    const list = await request(app)
      .get('/api/admin/rutinas/templates')
      .set('Authorization', `Bearer ${tok}`);
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(0);
    const source = list.body.find(
      (t: { days: number; gender: string }) => t.days === 4 && t.gender === 'male'
    ).source;

    const r = await request(app)
      .post(`/api/admin/rutinas/${skeletonId}/template`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ source });
    expect(r.status).toBe(204);

    const detail = await request(app)
      .get(`/api/admin/rutinas/${skeletonId}`)
      .set('Authorization', `Bearer ${tok}`);
    expect(detail.body.skeleton.status).toBe('pending_review');
    expect(detail.body.skeleton.generation_prompt.template).toBe(source);
    expect(detail.body.skeleton.generation_rationale).toContain(source);
    const days = new Set(
      detail.body.slots.map((s: { day_of_week: number }) => s.day_of_week)
    );
    expect(days.size).toBe(4);
  });

  it('rejects unknown templates and processed skeletons', async () => {
    const { skeletonId, tok } = await setupActiveRutina();
    const bad = await request(app)
      .post(`/api/admin/rutinas/${skeletonId}/template`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ source: 'nope.xlsx' });
    expect(bad.status).toBe(404);

    const list = await request(app)
      .get('/api/admin/rutinas/templates')
      .set('Authorization', `Bearer ${tok}`);
    const r = await request(app)
      .post(`/api/admin/rutinas/${skeletonId}/template`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ source: list.body[0].source });
    expect(r.status).toBe(409);
  });
});

// ── Test 10: Fall-through to queue router for /:skeletonId ──

describe('Fall-through to queue router', () => {
  it('GET /api/admin/rutinas/:skeletonId hits the queue router and returns 200', async () => {
    const adminId = await createAdmin();
    const athleteId = await createAthlete(adminId);
    const { skeletonId } = await createPendingSkeleton(
      { athleteId, generationPrompt: {}, generationRationale: 'r' },
      aiOut
    );
    const tok = signToken({ id: adminId, role: 'admin' });

    // The skeleton is pending_review — admin-rutinas router has no route for /:id,
    // so it falls through to the rutinas (queue) router which handles GET /:id.
    const r = await request(app)
      .get(`/api/admin/rutinas/${skeletonId}`)
      .set('Authorization', `Bearer ${tok}`);

    expect(r.status).toBe(200);
    expect(r.body.skeleton.id).toBe(skeletonId);
  });
});

describe('GET /admin/rutinas/pending/stuck', () => {
  it('lists athletes whose generation failed', async () => {
    const coachId = await createAdmin();
    const adminToken = signToken({ id: coachId, role: 'admin' });
    const athleteId = await createAthlete(coachId);
    await pool.query(
      `INSERT INTO skeleton_regen_jobs (athlete_id, status, last_error, finished_at)
       VALUES ($1, 'failed', 'Request timed out.', now())`,
      [athleteId],
    );
    const r = await request(app)
      .get('/api/admin/rutinas/pending/stuck')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].athlete_id).toBe(athleteId);
    expect(r.body[0].status).toBe('failed');
    expect(r.body[0].last_error).toBe('Request timed out.');
  });

  it('flags a job stuck in queued for over 15 minutes', async () => {
    const coachId = await createAdmin();
    const adminToken = signToken({ id: coachId, role: 'admin' });
    const athleteId = await createAthlete(coachId);
    await pool.query(
      `INSERT INTO skeleton_regen_jobs (athlete_id, status, created_at)
       VALUES ($1, 'queued', now() - interval '30 minutes')`,
      [athleteId],
    );
    const r = await request(app)
      .get('/api/admin/rutinas/pending/stuck')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].status).toBe('stalled');
  });

  it('ignores athletes that already have a skeleton', async () => {
    const coachId = await createAdmin();
    const adminToken = signToken({ id: coachId, role: 'admin' });
    const athleteId = await createAthlete(coachId);
    await pool.query(
      `INSERT INTO skeleton_regen_jobs (athlete_id, status, finished_at)
       VALUES ($1, 'failed', now())`,
      [athleteId],
    );
    await pool.query(
      `INSERT INTO athlete_skeletons (athlete_id, status, generated_by, generation_prompt)
       VALUES ($1, 'pending_review', 'ai', '{}'::jsonb)`,
      [athleteId],
    );
    const r = await request(app)
      .get('/api/admin/rutinas/pending/stuck')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.body).toHaveLength(0);
  });

  it('does not leak another coach\'s athletes', async () => {
    const coachA = await createAdmin();
    const coachB = await createAdmin();
    const athleteId = await createAthlete(coachA);
    await pool.query(
      `INSERT INTO skeleton_regen_jobs (athlete_id, status, finished_at)
       VALUES ($1, 'failed', now())`,
      [athleteId],
    );
    const r = await request(app)
      .get('/api/admin/rutinas/pending/stuck')
      .set('Authorization', `Bearer ${signToken({ id: coachB, role: 'admin' })}`);
    expect(r.body).toHaveLength(0);
  });
});
