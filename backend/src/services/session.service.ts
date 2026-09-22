import pool from '../db/connect.js';
import type { SessionSummary } from '../domain/types.js';
import type { SetLogPayload } from '../domain/schemas.js';
import {
  buildTodaySession, listPendingDays, TodayBlockedError,
} from './engine.service.js';
import { dominantGroupByDay } from './day-focus.service.js';
import { runWeeklyProgressionForAthlete } from './progression.service.js';
import { recordAmrap, ensureEstimatedRmsFromWeekLogs } from './rm.service.js';
import { isWarmupName } from './warmup-rule.js';
import logger from '../utils/logger.js';

export class SessionError extends Error {
  constructor(public reason:
    'session_in_progress' | 'session_finished' | 'not_found' |
    'no_active_skeleton' | 'already_finished' | 'already_trained_today' |
    'day_not_pending' | 'same_focus_back_to_back') {
    super(reason);
  }
}

/**
 * Series efectivas: los calentamientos y los abdominales no cuentan ni en el
 * total ni en el cumplimiento (la historia compartida muestra solo el trabajo
 * real). Misma regla para el target al iniciar y el conteo al terminar.
 */
function countsAsEffectiveSeries(
  role: string | null,
  ex: { name: string; muscle_group: string; movement_pattern: string },
): boolean {
  return (
    role !== 'calentamiento' &&
    !isWarmupName(ex.name) &&
    ex.movement_pattern !== 'core' &&
    !ex.muscle_group.trim().toLowerCase().startsWith('abdom')
  );
}

interface StartSessionResult {
  sessionId: string;
  expectedDay: number;
  items: Awaited<ReturnType<typeof buildTodaySession>>;
}

export async function startSession(
  athleteId: string,
  clientId: string,
  opts: { force?: boolean; dayOfWeek?: number } = {},
): Promise<StartSessionResult> {
  const stateR = await pool.query<{
    current_week: number; active_skeleton_id: string | null;
  }>(
    `SELECT current_week, active_skeleton_id
       FROM athlete_program_state WHERE athlete_id = $1`,
    [athleteId],
  );
  const state = stateR.rows[0];
  if (!state || !state.active_skeleton_id) {
    throw new SessionError('no_active_skeleton');
  }

  // El día lo decide el servidor. Sin elección explícita, el primer pendiente
  // (lo de siempre). Con elección, tiene que estar pendiente y no repetir el
  // grupo dominante de la última sesión: ese orden es la separación muscular
  // que armó el coach, y por eso no hay override.
  const pending = await listPendingDays(athleteId);
  let dayOfWeek = pending[0] ?? 1;
  if (opts.dayOfWeek != null) {
    if (!pending.includes(opts.dayOfWeek)) {
      throw new SessionError('day_not_pending');
    }
    const dominant = await dominantGroupByDay(state.active_skeleton_id);
    // Last finished session overall, not scoped to current week/skeleton.
    // After a routine change the day_of_week may map to a different group
    // on the new skeleton; that fails open (does not over-block).
    const lastR = await pool.query<{ day_of_week: number }>(
      `SELECT day_of_week FROM session_logs
        WHERE athlete_id = $1 AND finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1`,
      [athleteId],
    );
    const lastGroup = lastR.rows[0]
      ? dominant[lastR.rows[0].day_of_week] ?? null
      : null;
    const picked = dominant[opts.dayOfWeek] ?? null;
    // Si TODOS los pendientes chocan, no bloqueamos ninguno: el atleta no
    // puede quedar sin poder entrenar.
    const hasFreeAlternative = pending.some(
      (d) => (dominant[d] ?? null) !== lastGroup,
    );
    if (lastGroup && picked === lastGroup && hasFreeAlternative) {
      throw new SessionError('same_focus_back_to_back');
    }
    dayOfWeek = opts.dayOfWeek;
  }
  const expectedDay = dayOfWeek;

  const activeR = await pool.query<{ id: string }>(
    `SELECT id FROM session_logs
      WHERE athlete_id = $1 AND finished_at IS NULL LIMIT 1`,
    [athleteId],
  );
  if (activeR.rows[0]) {
    throw new SessionError('session_in_progress');
  }

  // Rest guard: one workout per day. If the athlete already finished a session
  // today (UTC day, matching the streak logic), block — unless they explicitly
  // override with "Entrenar de todas formas" (opts.force).
  if (!opts.force) {
    const trainedTodayR = await pool.query<{ id: string }>(
      `SELECT id FROM session_logs
        WHERE athlete_id = $1 AND finished_at IS NOT NULL
          AND date_trunc('day', finished_at AT TIME ZONE 'UTC')
              = date_trunc('day', now() AT TIME ZONE 'UTC')
        LIMIT 1`,
      [athleteId],
    );
    if (trainedTodayR.rows[0]) {
      throw new SessionError('already_trained_today');
    }
  }

  const items = await buildTodaySession(athleteId, dayOfWeek);
  const totalSetsTarget = items
    .filter((it) => countsAsEffectiveSeries(it.role, it.exercise))
    .reduce((sum, it) => sum + it.series, 0);

  const ins = await pool.query<{ id: string }>(
    `INSERT INTO session_logs
       (athlete_id, skeleton_id, program_week, day_of_week,
        total_sets_target, total_sets_completed, client_id)
     VALUES ($1, $2, $3, $4, $5, 0, $6)
     ON CONFLICT (client_id) DO UPDATE SET athlete_id = EXCLUDED.athlete_id
     RETURNING id`,
    [athleteId, state.active_skeleton_id, state.current_week,
     dayOfWeek, totalSetsTarget, clientId],
  );

  return { sessionId: ins.rows[0].id, expectedDay, items };
}

export async function logSet(
  sessionId: string,
  athleteId: string,
  payload: SetLogPayload,
): Promise<{ setId: string; created: boolean }> {
  const s = await pool.query<{
    id: string; athlete_id: string; finished_at: string | null;
    program_week: number; day_of_week: number;
  }>(
    `SELECT id, athlete_id, finished_at, program_week, day_of_week
       FROM session_logs WHERE id = $1`,
    [sessionId],
  );
  const session = s.rows[0];
  if (!session || session.athlete_id !== athleteId) {
    throw new SessionError('not_found');
  }
  if (session.finished_at) {
    throw new SessionError('session_finished');
  }

  const r = await pool.query<{ id: string; was_insert: boolean }>(
    `INSERT INTO set_logs
       (athlete_id, exercise_id, week, day_of_week, set_index,
        value, unit, reps, completed, rpe, drop_index,
        session_log_id, client_id, client_ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (client_id) WHERE client_id IS NOT NULL DO UPDATE SET
       value = EXCLUDED.value,
       unit = EXCLUDED.unit,
       reps = EXCLUDED.reps,
       completed = EXCLUDED.completed,
       rpe = EXCLUDED.rpe,
       drop_index = EXCLUDED.drop_index,
       synced_at = NOW()
     RETURNING id, (xmax = 0) AS was_insert`,
    [athleteId, payload.exercise_id, session.program_week, session.day_of_week,
     payload.set_index, payload.value, payload.unit, payload.reps,
     payload.completed, payload.rpe ?? null, payload.drop_index ?? null,
     sessionId, payload.client_id, payload.client_ts],
  );

  await pool.query(
    // Count DISTINCT planned series (exercise_id + set_index), not raw rows, so
    // a dropset's per-drop rows count as the single series they belong to. Keeps
    // this running counter consistent with finishSession's numerator.
    `UPDATE session_logs
       SET total_sets_completed = (
         SELECT COUNT(DISTINCT (exercise_id, set_index)) FROM set_logs
          WHERE session_log_id = $1 AND completed = TRUE)
     WHERE id = $1`,
    [sessionId],
  );

  // Persist the logged weight as the athlete's current suggestion for this
  // exercise, so the next session pre-fills it (instead of "— kg"). Skips
  // warmup/bodyweight/time/distance sets, where value is null. For dropsets
  // only the heaviest drop (drop_index = 1) seeds; the lighter drops (2, 3 …)
  // must not drag the suggestion down. Normal sets carry drop_index = NULL.
  const seedsWeight = payload.drop_index == null || payload.drop_index === 1;
  // El bucket sale del propio set: un dropset/superserie loguea un drop_index
  // por serie, un set normal lo manda en NULL. Así el peso del primer drop no
  // pisa la carga de las series rectas del mismo ejercicio.
  const scheme = payload.drop_index == null ? 'normal' : 'dropset';
  if (payload.completed && payload.value != null && seedsWeight) {
    await pool.query(
      `INSERT INTO athlete_exercise_weights
         (athlete_id, exercise_id, current_weight_kg, current_value, unit, current_reps_text, updated_by, scheme)
       VALUES ($1, $2, $3, $3, $4, NULL, 'athlete_correction', $5)
       ON CONFLICT (athlete_id, exercise_id, scheme) DO UPDATE SET
         current_weight_kg = EXCLUDED.current_weight_kg,
         current_value = EXCLUDED.current_value,
         unit = EXCLUDED.unit,
         updated_by = 'athlete_correction',
         updated_at = NOW()`,
      [athleteId, payload.exercise_id, payload.value, payload.unit, scheme],
    );
  }

  return { setId: r.rows[0].id, created: r.rows[0].was_insert };
}

export async function getActive(
  athleteId: string,
): Promise<{
  session: {
    id: string;
    day_of_week: number;
    started_at: string;
    items: import('../domain/types.js').SessionItem[];
    sets: import('../domain/types.js').SetLog[];
    current_slot_index: number;
  } | null;
}> {
  const r = await pool.query<{
    id: string; day_of_week: number; started_at: string;
  }>(
    `SELECT id, day_of_week, started_at
       FROM session_logs
      WHERE athlete_id = $1 AND finished_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
    [athleteId],
  );
  const row = r.rows[0];
  if (!row) return { session: null };

  let items: import('../domain/types.js').SessionItem[] = [];
  try {
    items = await buildTodaySession(athleteId, row.day_of_week, {
      ignoreRmsOnOrAfter: row.started_at,
    });
  } catch (e) {
    if (!(e instanceof TodayBlockedError)) throw e;
    // Allow stale active sessions to surface even if engine refuses to
    // rebuild items (e.g. skeleton replaced). UI handles empty items.
  }

  const setsR = await pool.query<import('../domain/types.js').SetLog>(
    `SELECT * FROM set_logs
      WHERE session_log_id = $1
      ORDER BY client_ts ASC`,
    [row.id],
  );
  const sets = setsR.rows;

  let currentSlotIndex = 0;
  for (const item of items) {
    const completed = sets.filter(
      (s) => s.exercise_id === item.exercise.id && s.completed,
    ).length;
    if (completed >= item.series) currentSlotIndex += 1;
    else break;
  }

  return {
    session: {
      id: row.id,
      day_of_week: row.day_of_week,
      started_at: row.started_at,
      items,
      sets,
      current_slot_index: currentSlotIndex,
    },
  };
}

/**
 * Semana AMRAP (`periodization_config.is_amrap`): el testeo ES la sesión — una
 * serie al 85% del RM y las reps que salgan. Nada en la app postea a
 * /athlete/amrap, así que el RM teórico se deriva de los sets que el atleta ya
 * logueó. Sale de `set_logs`, que es por donde pasan todos los sets, también
 * los que llegaron tarde por la cola de sync offline.
 *
 * Corre ANTES de `closeWeekIfComplete`: esa progresión puede mover
 * `current_week` a la 21 y dejar la semana de testeo sin registrar.
 *
 * Best-effort: la sesión ya está commiteada y `recordAmrap` es un upsert por
 * (atleta, ejercicio, semana), así que se puede reintentar sin duplicar.
 */
async function recordAmrapIfTestingWeek(
  sessionId: string,
  athleteId: string,
): Promise<void> {
  const cfgR = await pool.query<{ is_amrap: boolean }>(
    `SELECT p.is_amrap
       FROM athlete_program_state s
       JOIN periodization_config p ON p.week_number = s.current_week
      WHERE s.athlete_id = $1`,
    [athleteId],
  );
  if (!cfgR.rows[0]?.is_amrap) return;

  // Mejor serie por ejercicio principal, ordenada por Epley crudo. El redondeo
  // por equipamiento lo hace recordAmrap; acá sólo hace falta el ranking.
  const bestR = await pool.query<{
    exercise_id: number; weight: string; reps: number;
  }>(
    `SELECT DISTINCT ON (sl.exercise_id)
            sl.exercise_id,
            COALESCE(sl.value, sl.weight_kg)::text AS weight,
            sl.reps
       FROM set_logs sl
       JOIN exercises e ON e.id = sl.exercise_id
      WHERE sl.session_log_id = $1
        AND sl.completed = TRUE
        AND e.is_principal = TRUE
        AND COALESCE(sl.value, sl.weight_kg) > 0
        AND sl.reps > 0
      ORDER BY sl.exercise_id,
               COALESCE(sl.value, sl.weight_kg) * (1 + sl.reps / 30.0) DESC`,
    [sessionId],
  );

  for (const row of bestR.rows) {
    await recordAmrap({
      athleteId,
      exerciseId: row.exercise_id,
      weightUsed: Number(row.weight),
      reps: row.reps,
    });
  }
}

/**
 * Semana de testeo de RM (`is_rm_test`, tipicamente 10 / 30): si el atleta no
 * cargó el 1RM explícito, deriva un estimado Epley de la mejor serie logueada
 * en esa semana de programa y lo persiste en rm_tests SIN pisar un RM real.
 * Así la semana siguiente (11 / 1) puede aplicar pct × RM en vez de caer al
 * fallback de última carga (ticket #20).
 */
async function recordEstimatedRmIfTestingWeek(
  athleteId: string,
): Promise<void> {
  const cfgR = await pool.query<{ is_rm_test: boolean; current_week: number }>(
    `SELECT p.is_rm_test, s.current_week
       FROM athlete_program_state s
       JOIN periodization_config p ON p.week_number = s.current_week
      WHERE s.athlete_id = $1`,
    [athleteId],
  );
  const row = cfgR.rows[0];
  if (!row?.is_rm_test) return;
  const week = row.current_week;
  if (week !== 10 && week !== 30) return;
  await ensureEstimatedRmsFromWeekLogs(athleteId, week);
}

/**
 * Cierra la semana de programa cuando el atleta terminó TODOS sus días.
 *
 * `current_week` la subía sólo el cron de los domingos, así que completar la
 * semana antes dejaba `listPendingDays` vacío y el dashboard volvía a ofrecer
 * el día 1 de la MISMA semana — sesión duplicada y "se me cambió el día solo"
 * (bug 2026-08-14). Corre la misma progresión que el cron (pesos, reps,
 * rm_test_blocking, progression_runs), que mantiene su propio gate de
 * compliance: con la semana floja no sube y la semana se repite, como antes.
 *
 * Best-effort: la sesión ya quedó terminada, y si esto falla el cron reintenta.
 */
async function closeWeekIfComplete(athleteId: string): Promise<void> {
  const pending = await listPendingDays(athleteId);
  if (pending.length > 0) return;
  try {
    await runWeeklyProgressionForAthlete(athleteId);
  } catch {
    // Ya queda logueado adentro de la progresión.
  }
}

export async function finishSession(
  sessionId: string,
  athleteId: string,
  fatigueRating: 'suave' | 'normal' | 'exigente',
  note?: string,
): Promise<SessionSummary> {
  const client = await pool.connect();
  let summary: SessionSummary;
  try {
    await client.query('BEGIN');

    const r = await client.query<{
      id: string; athlete_id: string; finished_at: string | null;
      started_at: string; total_sets_target: number | null;
    }>(
      `SELECT id, athlete_id, finished_at, started_at, total_sets_target
         FROM session_logs WHERE id = $1 FOR UPDATE`,
      [sessionId],
    );
    const session = r.rows[0];
    if (!session || session.athlete_id !== athleteId) {
      throw new SessionError('not_found');
    }
    if (session.finished_at) {
      throw new SessionError('already_finished');
    }

    const seriesR = await client.query<{
      role: string | null;
      name: string;
      muscle_group: string;
      movement_pattern: string;
    }>(
      // One row per planned series with at least one
      // completed row — grouped by (exercise_id, set_index), which together
      // identify a single planned series. A dropset / superserie logs one
      // set_log row PER DROP (all sharing the same exercise_id + set_index,
      // differing only by drop_index), so counting raw rows inflated the
      // numerator past the target (e.g. 39/22). Counting distinct series makes
      // a 3-drop dropset count as the ONE series it is → completed can no
      // longer exceed planned for a normally-executed session.
      // The day's slot role comes along to drop warm-ups.
      `SELECT DISTINCT ON (sl.exercise_id, sl.set_index)
              (SELECT s.role FROM skeleton_slots s
                WHERE s.skeleton_id = lg.skeleton_id
                  AND s.day_of_week = lg.day_of_week
                  AND s.exercise_id = sl.exercise_id
                ORDER BY (s.role = 'calentamiento') DESC LIMIT 1) AS role,
              e.name, e.muscle_group, e.movement_pattern
         FROM set_logs sl
         JOIN session_logs lg ON lg.id = sl.session_log_id
         JOIN exercises e ON e.id = sl.exercise_id
        WHERE sl.session_log_id = $1 AND sl.completed = TRUE`,
      [sessionId],
    );
    const setsCompleted = seriesR.rows.filter((r) =>
      countsAsEffectiveSeries(r.role, r),
    ).length;

    const aggR = await client.query<{
      total_volume: string | null;
    }>(
      `SELECT
         COALESCE(SUM(COALESCE(value, weight_kg) * reps) FILTER (WHERE completed = TRUE), 0)::text AS total_volume
         FROM set_logs WHERE session_log_id = $1`,
      [sessionId],
    );
    const agg = aggR.rows[0];
    const setsTarget = session.total_sets_target ?? 0;
    const totalVolumeKg = Number(agg.total_volume ?? 0);
    // Defensive clamp only. With `setsCompleted` now counting distinct planned
    // series (not raw rows), a normally-executed session cannot exceed 100%.
    // The clamp stays as a harmless safety net (e.g. if the athlete logs extra
    // series beyond the plan) so compliance is never reported above 100%.
    const compliancePct =
      setsTarget > 0 ? Math.min(100, (setsCompleted / setsTarget) * 100) : 0;

    const now = new Date();
    const durationSeconds = Math.floor(
      (now.getTime() - new Date(session.started_at).getTime()) / 1000,
    );

    const prR = await client.query<{
      exercise_id: number; name: string; kg: string; reps: number;
    }>(
      `WITH cur AS (
         SELECT exercise_id, MAX(COALESCE(value, weight_kg) * reps) AS cur_max,
                COALESCE(value, weight_kg) AS weight_kg, reps
           FROM set_logs
          WHERE session_log_id = $1 AND completed = TRUE
          GROUP BY exercise_id, COALESCE(value, weight_kg), reps
       ), best_old AS (
         SELECT sl.exercise_id, COALESCE(MAX(COALESCE(sl.value, sl.weight_kg) * sl.reps), 0) AS old_max
           FROM set_logs sl
          WHERE sl.athlete_id = $2 AND sl.completed = TRUE
            AND sl.session_log_id IS DISTINCT FROM $1
          GROUP BY sl.exercise_id
       )
       SELECT DISTINCT ON (c.exercise_id)
              c.exercise_id, e.name, c.weight_kg::text AS kg, c.reps
         FROM cur c
         LEFT JOIN best_old b ON b.exercise_id = c.exercise_id
         JOIN exercises e ON e.id = c.exercise_id
        WHERE c.cur_max > COALESCE(b.old_max, 0)
        ORDER BY c.exercise_id, c.cur_max DESC`,
      [sessionId, athleteId],
    );
    const newPRs = prR.rows.map((p) => ({
      exerciseId: p.exercise_id, name: p.name,
      kg: Number(p.kg), reps: p.reps,
    }));

    await client.query(
      `UPDATE session_logs
         SET finished_at = NOW(),
             fatigue_rating = $1,
             total_sets_completed = $2,
             compliance_pct = $3,
             total_volume_kg = $4,
             duration_seconds = $5,
             note = $6
       WHERE id = $7`,
      [fatigueRating, setsCompleted, compliancePct, totalVolumeKg,
       durationSeconds, note?.trim() || null, sessionId],
    );

    await client.query('COMMIT');

    summary = {
      totalVolumeKg, setsCompleted, setsTarget, compliancePct,
      durationSeconds, newPRs,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Fuera de la transacción a propósito: la progresión toma su propia conexión
  // y un advisory lock, y no tiene que poder tumbar un finish ya commiteado.
  try {
    await recordAmrapIfTestingWeek(sessionId, athleteId);
  } catch (e) {
    logger.error({ err: e, sessionId, athleteId }, 'amrap derivation failed');
  }
  try {
    await recordEstimatedRmIfTestingWeek(athleteId);
  } catch (e) {
    logger.error({ err: e, sessionId, athleteId }, 'estimated RM backfill failed');
  }
  await closeWeekIfComplete(athleteId);
  return summary;
}
