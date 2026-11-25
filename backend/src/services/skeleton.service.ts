import pool from '../db/connect.js';
import type {
  AthleteSkeleton,
  SkeletonSlot,
  SkeletonStatus,
} from '../domain/types.js';
import type { AiSkeletonOutput } from '../domain/schemas.js';
import type { PoolClient } from 'pg';

export interface CreateSkeletonInput {
  athleteId: string;
  generationPrompt: unknown;
  generationRationale: string | null;
  rejectionFeedback?: string;
}

/** Inserts a pending skeleton on the caller's transaction. Does not commit. */
export async function writePendingSkeleton(
  client: PoolClient,
  input: CreateSkeletonInput,
  aiOutput: AiSkeletonOutput,
): Promise<{ skeletonId: string }> {
  const sk = await client.query<AthleteSkeleton>(
    `INSERT INTO athlete_skeletons
       (athlete_id, status, generated_by, generation_prompt,
        generation_rationale, rejection_feedback)
     VALUES ($1, 'pending_review', 'ai', $2::jsonb, $3, $4)
     RETURNING id`,
    [
      input.athleteId,
      JSON.stringify(input.generationPrompt),
      input.generationRationale,
      input.rejectionFeedback ?? null,
    ]
  );
  const skeletonId = sk.rows[0].id;
  await writeSkeletonContent(client, skeletonId, aiOutput);
  return { skeletonId };
}

async function writeSkeletonContent(
  client: PoolClient,
  skeletonId: string,
  aiOutput: AiSkeletonOutput,
): Promise<void> {
  for (const day of aiOutput.days) {
    for (const slot of day.slots) {
      // Per-slot prescription only applies to accessories; null it out for
      // principals/warmups so they keep periodization / warmup defaults even
      // if the model returned stray values.
      const isAccessory = slot.role === 'accesorio';
      await client.query(
        `INSERT INTO skeleton_slots
           (skeleton_id, day_of_week, slot_index, exercise_id, role, notes,
            series, reps, descanso)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          skeletonId,
          day.day_index,
          slot.slot_index,
          slot.exercise_id,
          slot.role,
          slot.notes,
          isAccessory ? (slot.series ?? null) : null,
          isAccessory ? (slot.reps ?? null) : null,
          isAccessory ? (slot.descanso ?? null) : null,
        ]
      );
    }
  }

  for (const day of aiOutput.days) {
    await client.query(
      `INSERT INTO skeleton_days (skeleton_id, day_of_week, focus)
       VALUES ($1, $2, $3)
       ON CONFLICT (skeleton_id, day_of_week) DO NOTHING`,
      [skeletonId, day.day_index, day.focus]
    );
  }
}

/**
 * Swaps the whole content (slots, day labels, rationale) of a pending
 * skeleton, keeping its id so the review queue position is unchanged.
 * Returns false when the skeleton is missing or no longer pending.
 */
export async function replacePendingSkeletonContent(
  skeletonId: string,
  aiOutput: AiSkeletonOutput,
  promptPatch: Record<string, unknown>,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE athlete_skeletons
          SET generation_rationale = $2,
              generation_prompt = COALESCE(generation_prompt, '{}'::jsonb) || $3::jsonb
        WHERE id = $1 AND status = 'pending_review'
        RETURNING id`,
      [skeletonId, aiOutput.rationale, JSON.stringify(promptPatch)]
    );
    if (r.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(`DELETE FROM skeleton_slots WHERE skeleton_id = $1`, [skeletonId]);
    await client.query(`DELETE FROM skeleton_days WHERE skeleton_id = $1`, [skeletonId]);
    await writeSkeletonContent(client, skeletonId, aiOutput);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function createPendingSkeleton(
  input: CreateSkeletonInput,
  aiOutput: AiSkeletonOutput
): Promise<{ skeletonId: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await writePendingSkeleton(client, input, aiOutput);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function findSkeleton(
  id: string
): Promise<AthleteSkeleton | null> {
  const { rows } = await pool.query<AthleteSkeleton>(
    `SELECT * FROM athlete_skeletons WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function listSlots(skeletonId: string): Promise<SkeletonSlot[]> {
  const { rows } = await pool.query<SkeletonSlot>(
    `SELECT s.*, e.name AS exercise_name, e.muscle_group, e.equipment
     FROM skeleton_slots s
     JOIN exercises e ON e.id = s.exercise_id
     WHERE s.skeleton_id = $1
     ORDER BY s.day_of_week, s.slot_index`,
    [skeletonId]
  );
  return rows;
}

export interface SlotEditOptions {
  /** Exercise/notes/set-scheme edits made by the admin before approving. */
  slotOverrides?: {
    slot_id: string;
    exercise_id: number;
    notes?: string | null;
    // Per-slot set scheme (accessories only at runtime). When a key is present
    // it is written as-is; null clears it back to the periodization default.
    series?: number | null;
    reps?: string | null;
    descanso?: string | null;
  }[];
  /** Full reordering of the skeleton's slots (every slot, new day/index). */
  slotOrder?: {
    slot_id: string;
    day_of_week: number;
    slot_index: number;
  }[];
  /** Slots removed by the admin before approving. */
  deletedSlotIds?: string[];
  /** Brand-new slots added by the admin (client-generated id) before approving. */
  addedSlots?: {
    id: string;
    day_of_week: number;
    exercise_id: number;
    role: string;
    notes?: string | null;
    series?: number | null;
    reps?: string | null;
    descanso?: string | null;
  }[];
  /** Renamed muscle-group labels (the day subtitle) per training day. */
  dayFocus?: { day_of_week: number; focus: string }[];
}

export interface ApproveSkeletonOptions extends SlotEditOptions {
  startDate?: Date;
}

/**
 * Applies staged slot edits inside the caller's transaction. Keeping this
 * shared with approval prevents the two editing flows from drifting apart.
 */
export async function applySlotEdits(
  client: PoolClient,
  skeletonId: string,
  opts: SlotEditOptions
): Promise<void> {
  for (const day of opts.dayFocus ?? []) {
    if (day.focus === '') {
      // Blank clears the label. Deleting is what "no focus" already renders as,
      // and reordering days needs to move a blank onto a day that had one.
      await client.query(
        `DELETE FROM skeleton_days WHERE skeleton_id = $1 AND day_of_week = $2`,
        [skeletonId, day.day_of_week]
      );
      continue;
    }
    await client.query(
      `INSERT INTO skeleton_days (skeleton_id, day_of_week, focus)
       VALUES ($1, $2, $3)
       ON CONFLICT (skeleton_id, day_of_week) DO UPDATE SET focus = EXCLUDED.focus`,
      [skeletonId, day.day_of_week, day.focus]
    );
  }

  if (opts.deletedSlotIds && opts.deletedSlotIds.length > 0) {
    await client.query(
      `DELETE FROM skeleton_slots
        WHERE id = ANY($1::uuid[]) AND skeleton_id = $2`,
      [opts.deletedSlotIds, skeletonId]
    );
  }

  if (opts.addedSlots && opts.addedSlots.length > 0) {
    for (const added of opts.addedSlots) {
      const occupiedR = await client.query<{ slot_index: number }>(
        `SELECT slot_index FROM skeleton_slots
          WHERE skeleton_id = $1 AND day_of_week = $2`,
        [skeletonId, added.day_of_week]
      );
      const occupied = new Set(occupiedR.rows.map((row) => row.slot_index));
      let idx = 1;
      while (occupied.has(idx)) idx += 1;
      if (idx > 12) throw new Error('day exceeds 12 slots');
      await client.query(
        `INSERT INTO skeleton_slots
           (id, skeleton_id, day_of_week, slot_index, exercise_id, role, notes,
            series, reps, descanso)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          added.id,
          skeletonId,
          added.day_of_week,
          idx,
          added.exercise_id,
          added.role,
          added.notes ?? null,
          added.series ?? null,
          added.reps ?? null,
          added.descanso ?? null,
        ]
      );
    }
  }

  for (const override of opts.slotOverrides ?? []) {
    const hasScheme =
      'series' in override || 'reps' in override || 'descanso' in override;
    if (hasScheme) {
      await client.query(
        `UPDATE skeleton_slots
            SET exercise_id = $1, notes = $2,
                series = $3, reps = $4, descanso = $5
          WHERE id = $6 AND skeleton_id = $7`,
        [
          override.exercise_id,
          override.notes ?? null,
          override.series ?? null,
          override.reps ?? null,
          override.descanso ?? null,
          override.slot_id,
          skeletonId,
        ]
      );
    } else {
      await client.query(
        `UPDATE skeleton_slots
            SET exercise_id = $1, notes = $2
          WHERE id = $3 AND skeleton_id = $4`,
        [
          override.exercise_id,
          override.notes ?? null,
          override.slot_id,
          skeletonId,
        ]
      );
    }
  }

  if (opts.slotOrder && opts.slotOrder.length > 0) {
    const orderIds = opts.slotOrder.map((slot) => slot.slot_id);
    const moved = await client.query<{
      id: string;
      exercise_id: number;
      role: string;
      notes: string | null;
      series: number | null;
      reps: string | null;
      descanso: string | null;
    }>(
      `DELETE FROM skeleton_slots
        WHERE id = ANY($1::uuid[]) AND skeleton_id = $2
        RETURNING id, exercise_id, role, notes, series, reps, descanso`,
      [orderIds, skeletonId]
    );
    if (moved.rowCount !== orderIds.length) {
      throw new Error('slot_order references slot not in skeleton');
    }
    const byId = new Map(moved.rows.map((row) => [row.id, row]));
    for (const slot of opts.slotOrder) {
      const original = byId.get(slot.slot_id)!;
      await client.query(
        `INSERT INTO skeleton_slots
           (id, skeleton_id, day_of_week, slot_index, exercise_id, role, notes,
            series, reps, descanso)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          original.id,
          skeletonId,
          slot.day_of_week,
          slot.slot_index,
          original.exercise_id,
          original.role,
          original.notes,
          original.series,
          original.reps,
          original.descanso,
        ]
      );
    }
  }
}

export async function approveSkeleton(
  skeletonId: string,
  reviewerId: string,
  opts: ApproveSkeletonOptions = {}
): Promise<void> {
  const startDate = opts.startDate ?? new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sk = await client.query<AthleteSkeleton>(
      `SELECT * FROM athlete_skeletons WHERE id = $1 FOR UPDATE`,
      [skeletonId]
    );
    if (!sk.rows[0]) throw new Error('skeleton not found');
    if (sk.rows[0].status !== 'pending_review') {
      throw new Error(`cannot approve skeleton in status=${sk.rows[0].status}`);
    }
    const athleteId = sk.rows[0].athlete_id;

    await applySlotEdits(client, skeletonId, opts);

    // Supersede previous approved skeleton (if any)
    await client.query(
      `UPDATE athlete_skeletons
         SET status = 'superseded'
       WHERE athlete_id = $1 AND status = 'approved'`,
      [athleteId]
    );

    // Approve this one
    await client.query(
      `UPDATE athlete_skeletons
         SET status = 'approved',
             reviewed_at = NOW(),
             reviewed_by = $1
       WHERE id = $2`,
      [reviewerId, skeletonId]
    );

    // Upsert program_state
    await client.query(
      `INSERT INTO athlete_program_state
         (athlete_id, active_skeleton_id, current_week, start_date, rm_test_blocking)
       VALUES ($1, $2, 1, $3::date, false)
       ON CONFLICT (athlete_id) DO UPDATE
         SET active_skeleton_id = EXCLUDED.active_skeleton_id`,
      [athleteId, skeletonId, startDate.toISOString().slice(0, 10)]
    );

    // Seed athlete_exercise_weights with NULL for every distinct exercise in slots
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

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function rejectSkeleton(
  skeletonId: string,
  reviewerId: string,
  feedback: string
): Promise<void> {
  await pool.query(
    `UPDATE athlete_skeletons
       SET status = 'rejected',
           rejection_feedback = $1,
           reviewed_at = NOW(),
           reviewed_by = $2
     WHERE id = $3 AND status = 'pending_review'`,
    [feedback, reviewerId, skeletonId]
  );
}

// Coach discards the pending queue entry (e.g. already built a routine by
// hand): supersede EVERY pending skeleton of the athlete, not just the visible
// one, so an older hidden pending doesn't resurface via DISTINCT ON. No
// regeneration, no athlete notification.
export async function discardPendingForAthlete(
  athleteId: string,
  reviewerId: string
): Promise<void> {
  await pool.query(
    `UPDATE athlete_skeletons
       SET status = 'superseded',
           reviewed_at = NOW(),
           reviewed_by = $1
     WHERE athlete_id = $2 AND status = 'pending_review'`,
    [reviewerId, athleteId]
  );
}

export async function listPendingForCoach(coachId: string) {
  const { rows } = await pool.query(
    `SELECT id, athlete_id, created_at, generation_rationale, athlete_name
       FROM (
         SELECT DISTINCT ON (s.athlete_id)
                s.id, s.athlete_id, s.created_at, s.generation_rationale,
                ap.name AS athlete_name
           FROM athlete_skeletons s
           JOIN athlete_profiles ap ON ap.user_id = s.athlete_id
          WHERE s.status = 'pending_review' AND ap.coach_id = $1
          ORDER BY s.athlete_id, s.created_at DESC
       ) t
      ORDER BY created_at ASC`,
    [coachId]
  );
  return rows;
}

export async function findActiveByAthlete(athleteId: string): Promise<{
  state: { current_week: number; rm_test_blocking: boolean } | null;
  skeleton: AthleteSkeleton | null;
  status: SkeletonStatus | null;
}> {
  const stateR = await pool.query(
    `SELECT current_week, rm_test_blocking, active_skeleton_id
       FROM athlete_program_state WHERE athlete_id = $1`,
    [athleteId]
  );
  if (!stateR.rows[0]) {
    // Maybe a pending skeleton without state yet
    const pendingR = await pool.query<AthleteSkeleton>(
      `SELECT * FROM athlete_skeletons
        WHERE athlete_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [athleteId]
    );
    return {
      state: null,
      skeleton: pendingR.rows[0] ?? null,
      status: pendingR.rows[0]?.status ?? null,
    };
  }
  const state = stateR.rows[0];
  if (!state.active_skeleton_id) {
    return { state, skeleton: null, status: null };
  }
  const sk = await findSkeleton(state.active_skeleton_id);
  return { state, skeleton: sk, status: sk?.status ?? null };
}
