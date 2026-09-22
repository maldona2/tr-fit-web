import pool from '../db/connect.js';
import {
  resolveAccessoryReps,
  roundWeightForEquipment,
  suggestDropWeights,
  weightScheme,
} from './progression-helpers.js';
import { resolveUnit } from './equipment-units.service.js';
import { applyOverridesToSlots } from './weekly-overrides.service.js';
import type { WeeklyOverride } from './weekly-overrides.service.js';
import { getExclusionMap } from './exclusions.service.js';
import { isWarmupName } from './warmup-rule.js';
import type {
import { ensureEstimatedRmsFromWeekLogs } from './rm.service.js';
  Exercise,
  PeriodizationConfig,
  SessionItem,
  SkeletonSlot,
  SlotRole,
} from '../domain/types.js';

export class TodayBlockedError extends Error {
  constructor(
    public reason: 'awaiting_review' | 'rm_test_required' | 'no_program'
  ) {
    super(reason);
  }
}

export async function buildTodaySession(
  athleteId: string,
  dayOfWeek: number,
  opts?: { ignoreRmsOnOrAfter?: Date | string | null }
): Promise<SessionItem[]> {
  const stateR = await pool.query<{
    current_week: number;
    active_skeleton_id: string | null;
  }>(
    `SELECT current_week, active_skeleton_id
       FROM athlete_program_state WHERE athlete_id = $1`,
    [athleteId]
  );
  if (!stateR.rows[0] || !stateR.rows[0].active_skeleton_id) {
    throw new TodayBlockedError('awaiting_review');
  }
  const state = stateR.rows[0];
  // La semana de testeo (is_rm_test / is_amrap) SE ENTRENA: el testeo ES la
  // sesión. `rm_test_blocking` cortaba acá, y como el único camino para
  // limpiarlo (cargar los RM) vive dentro de esa sesión, el atleta quedaba
  // trabado para siempre en la semana 10. La bandera queda como marcador
  // informativo; el flag por ítem 'rm_test' es lo que pide el registro del RM.

  const cfgR = await pool.query<PeriodizationConfig>(
    `SELECT * FROM periodization_config WHERE week_number = $1`,
    [state.current_week]
  );
  const cfg = cfgR.rows[0];
  if (!cfg)
    throw new Error(`no periodization_config for week ${state.current_week}`);

  const slotsR = await pool.query<SkeletonSlot>(
    `SELECT * FROM skeleton_slots
       WHERE skeleton_id = $1 AND day_of_week = $2
       ORDER BY slot_index ASC`,
    [state.active_skeleton_id, dayOfWeek]
  );
  if (slotsR.rows.length === 0) return [];

  // Apply permanent exclusions first: swap excluded exercise → replacement,
  // or drop the slot entirely when no replacement exists.
  const exclusions = await getExclusionMap(athleteId);
  const slotsAfterExclusion = slotsR.rows
    .map((slot) => {
      if (!exclusions.has(slot.exercise_id)) return slot;
      const repl = exclusions.get(slot.exercise_id) ?? null;
      return repl === null ? null : { ...slot, exercise_id: repl };
    })
    .filter((s): s is SkeletonSlot => s !== null);
  if (slotsAfterExclusion.length === 0) return [];

  const effectiveSlots = await applyOverridesToSlots(
    athleteId,
    state.current_week,
    dayOfWeek,
    slotsAfterExclusion
  );
  if (effectiveSlots.length === 0) return [];

  const exerciseIds = effectiveSlots.map((s) => s.exercise_id);
  const exR = await pool.query<Exercise>(
    `SELECT * FROM exercises WHERE id = ANY($1::int[])`,
    [exerciseIds]
  );
  const exById = new Map(exR.rows.map((e) => [e.id, e]));

  const wR = await pool.query<{
    exercise_id: number;
    scheme: string;
    current_weight_kg: number | null;
    current_value: number | null;
    unit: 'kg' | 'ladrillos' | null;
    current_reps_text: string | null;
  }>(
    `SELECT exercise_id,
            scheme,
            COALESCE(current_value, current_weight_kg) AS current_value,
            unit,
            current_weight_kg,
            current_reps_text
       FROM athlete_exercise_weights
      WHERE athlete_id = $1 AND exercise_id = ANY($2::int[])`,
    [athleteId, exerciseIds]
  );
  // Una carga por (ejercicio, esquema): el dropset del mismo ejercicio lleva la
  // suya. La clave se arma con la prescripción del SLOT, no con el estado
  // guardado, así que es estable aunque `current_reps_text` esté viejo.
  const wByEx = new Map(
    wR.rows.map((r) => [`${r.exercise_id}:${r.scheme}`, r])
  );

  let rmByEx = new Map<number, number>();
  // AMRAP weeks also resolve a prescribed weight from the RM source, so load
  // the RM map for them too (their config always sets pct_rm + rm_source).
  if (cfg.is_amrap || (cfg.principal_pct_rm && cfg.principal_rm_source)) {
    const sourceWeek = cfg.principal_rm_source;
    // Ticket #20: if week-after-RM has no rm_tests (athlete skipped the 1RM
    // screen), backfill estimates from that source week's logged sets before
    // resolving weights. No-ops when rows already exist or week is not 10/30.
    if (sourceWeek === 10 || sourceWeek === 30) {
      await ensureEstimatedRmsFromWeekLogs(athleteId, sourceWeek);
    }
    const rmR = await pool.query<{ exercise_id: number; value_kg: string }>(
      `SELECT exercise_id, value_kg::text
         FROM rm_tests
        WHERE athlete_id = $1 AND program_week = $2
          AND exercise_id = ANY($3::int[])`,
      [athleteId, sourceWeek, exerciseIds]
    );
    rmByEx = new Map(rmR.rows.map((r) => [r.exercise_id, Number(r.value_kg)]));
  }

  // RM week can list the same principal on two days (e.g. hip thrust Mon+Fri).
  // The program week does not roll until Sunday, so a test already logged
  // this week must not be asked again — except the test logged DURING the
  // in-progress session. GET /active rebuilds items; counting that RM turned
  // the same day's 1×1 rm_test into 3×8 rm_already_done (ticket #6).
  // The repeat day's 3×8 load comes from that fresh RM × the % of the first
  // week that uses it as rm_source (10→11, 30→1). The last logged weight IS
  // the RM itself (the RM screen logs the 1×1 set), so 3×8 at 100% (ticket #19).
  let alreadyTestedThisWeek = new Map<number, number>();
  let repeatDayPct: number | null = null;
  if (cfg.is_rm_test) {
    const testedR = await pool.query<{ exercise_id: number; value_kg: string }>(
      `SELECT exercise_id, value_kg::text
         FROM rm_tests
        WHERE athlete_id = $1 AND program_week = $2
          AND exercise_id = ANY($3::int[])
          AND ($4::timestamptz IS NULL OR tested_at < $4)`,
      [
        athleteId,
        state.current_week,
        exerciseIds,
        opts?.ignoreRmsOnOrAfter ?? null,
      ]
    );
    alreadyTestedThisWeek = new Map(
      testedR.rows.map((r) => [r.exercise_id, Number(r.value_kg)])
    );
    if (alreadyTestedThisWeek.size > 0) {
      const pctR = await pool.query<{ principal_pct_rm: string }>(
        `SELECT principal_pct_rm::text
           FROM periodization_config
          WHERE principal_rm_source = $1 AND principal_pct_rm IS NOT NULL
          ORDER BY (week_number > $1) DESC, week_number ASC
          LIMIT 1`,
        [state.current_week]
      );
      const pct = Number(pctR.rows[0]?.principal_pct_rm);
      repeatDayPct = pct > 0 ? pct : null;
    }
  }

  const lastDropsByEx = await loadLastDropWeights(athleteId, exerciseIds);

  return Promise.all(
    effectiveSlots.map((slot) =>
      buildItem(
        athleteId,
        slot,
        exById,
        wByEx,
        rmByEx,
        cfg,
        alreadyTestedThisWeek,
        repeatDayPct,
        lastDropsByEx
      )
    )
  );
}

/**
 * Last completed dropset series per exercise, ordered by drop_index.
 * AEW only keeps the heaviest; these gaps are what the next session prefills.
 */
async function loadLastDropWeights(
  athleteId: string,
  exerciseIds: number[]
): Promise<Map<number, number[]>> {
  if (exerciseIds.length === 0) return new Map();
  const r = await pool.query<{
    exercise_id: number;
    drop_index: number;
    value: string;
  }>(
    `WITH last_drop_series AS (
       SELECT DISTINCT ON (exercise_id)
              exercise_id, week, day_of_week, set_index
         FROM set_logs
        WHERE athlete_id = $1
          AND exercise_id = ANY($2::int[])
          AND drop_index IS NOT NULL
          AND completed = TRUE
          AND COALESCE(value, weight_kg) IS NOT NULL
        ORDER BY exercise_id, logged_at DESC, week DESC, set_index DESC
     )
     SELECT sl.exercise_id,
            sl.drop_index,
            COALESCE(sl.value, sl.weight_kg)::text AS value
       FROM set_logs sl
       JOIN last_drop_series ls
         ON sl.exercise_id = ls.exercise_id
        AND sl.week = ls.week
        AND sl.day_of_week = ls.day_of_week
        AND sl.set_index = ls.set_index
      WHERE sl.athlete_id = $1
        AND sl.drop_index IS NOT NULL
        AND sl.completed = TRUE
        AND COALESCE(sl.value, sl.weight_kg) IS NOT NULL
      ORDER BY sl.exercise_id, sl.drop_index`,
    [athleteId, exerciseIds]
  );
  const byEx = new Map<number, number[]>();
  for (const row of r.rows) {
    const arr = byEx.get(row.exercise_id) ?? [];
    arr[row.drop_index - 1] = Number(row.value);
    byEx.set(row.exercise_id, arr);
  }
  for (const [id, arr] of byEx) {
    byEx.set(
      id,
      arr.filter(
        (v): v is number => typeof v === 'number' && Number.isFinite(v)
      )
    );
  }
  return byEx;
}

async function buildItem(
  athleteId: string,
  slot: SkeletonSlot & { _override?: WeeklyOverride },
  exById: Map<number, Exercise>,
  wByEx: Map<
    string,
    {
      current_value: number | null;
      unit: 'kg' | 'ladrillos' | null;
      current_reps_text: string | null;
    }
  >,
  rmByEx: Map<number, number>,
  cfg: PeriodizationConfig,
  alreadyTestedThisWeek: Map<number, number>,
  repeatDayPct: number | null,
  lastDropsByEx: Map<number, number[]>
): Promise<SessionItem> {
  const exercise = exById.get(slot.exercise_id)!;
  // Accesorios: el bucket sale de la prescripción del slot (038), con el
  // default del bloque como fallback. Principales y calentamientos son siempre
  // 'normal' — no tienen esquema de dropset.
  const scheme =
    slot.role === 'accesorio'
      ? weightScheme(slot.reps ?? cfg.accesorio_reps)
      : 'normal';
  const w = wByEx.get(`${slot.exercise_id}:${scheme}`);
  // Profile preference (athlete_equipment_units) is source of truth for unit.
  // Falls back to equipment default. Previously prioritized AEW.unit, which
  // froze the unit to whatever was logged first and ignored later profile
  // changes (e.g. user switches polea from kg to ladrillos).
  const unit = await resolveUnit(athleteId, exercise.equipment);
  // Drop stale suggested value if the recorded unit no longer matches.
  const aewValue =
    !w?.unit || w.unit === unit ? (w?.current_value ?? null) : null;
  const notes = slot.notes ?? null;

  // Serve-time safety net (bug 2026-07-04): warm-up exercises occasionally
  // reached the DB mistagged (AI adjuster output pre-backstop, or manual
  // admin edits). Name-based detection wins over the stored role so the app
  // never asks RPE/reps after a mobility drill.
  const role: SlotRole =
    slot.role !== 'calentamiento' && isWarmupName(exercise.name)
      ? 'calentamiento'
      : slot.role;

  let item: SessionItem;

  if (role === 'calentamiento') {
    // Only honor an explicit series count on a correctly-tagged warm-up. A
    // legacy accessory detected by name may carry an unrelated accessory
    // prescription and must keep the safe one-series default.
    const warmupSeries = slot.role === 'calentamiento' ? (slot.series ?? 1) : 1;
    item = buildWarmupItem(
      exercise,
      unit,
      slot.slot_index,
      notes,
      warmupSeries
    );
  } else if (role === 'principal') {
    if (cfg.is_rm_test) {
      const testedRm = alreadyTestedThisWeek.get(slot.exercise_id);
      if (testedRm !== undefined) {
        // Repeat day after the test: 3×8 at a % of the RM just tested (free
        // choice if no week uses it). Never aewValue — that is the RM itself.
        const weight =
          repeatDayPct && testedRm > 0
            ? roundWeightForEquipment(testedRm * repeatDayPct, exercise.equipment)
            : null;
        item = baseItem(
          exercise,
          role,
          slot.slot_index,
          weight,
          unit,
          3,
          '8',
          '3 min',
          notes,
          'rm_already_done'
        );
      } else {
        item = baseItem(
          exercise,
          role,
          slot.slot_index,
          null,
          unit,
          cfg.principal_series,
          cfg.principal_reps,
          cfg.principal_descanso,
          notes,
          'rm_test'
        );
      }
    } else if (cfg.is_amrap) {
      const rm = rmByEx.get(slot.exercise_id);
      if (!rm) {
        // AMRAP weeks intentionally stay null (not aewValue): the athlete is
        // meant to find their working weight in-session, not anchor to a stale
        // logged weight. (The pct_rm branch below DOES fall back to aewValue.)
        item = baseItem(
          exercise,
          role,
          slot.slot_index,
          null,
          unit,
          cfg.principal_series,
          cfg.principal_reps,
          cfg.principal_descanso,
          notes,
          'missing_rm'
        );
      } else {
        const weight = roundWeightForEquipment(
          rm * Number(cfg.principal_pct_rm),
          exercise.equipment
        );
        item = baseItem(
          exercise,
          role,
          slot.slot_index,
          weight,
          unit,
          cfg.principal_series,
          cfg.principal_reps,
          cfg.principal_descanso,
          notes,
          'amrap'
        );
      }
    } else if (cfg.principal_pct_rm && cfg.principal_rm_source) {
      const rm = rmByEx.get(slot.exercise_id);
      if (!rm) {
        // No RM test yet: fall back to the athlete's last logged/corrected
        // weight so the next session isn't blank. Keep the missing_rm flag
        // so the "Anotá tu RM" nudge still shows.
        item = baseItem(
          exercise,
          role,
          slot.slot_index,
          aewValue,
          unit,
          cfg.principal_series,
          cfg.principal_reps,
          cfg.principal_descanso,
          notes,
          'missing_rm'
        );
      } else {
        const weight = roundWeightForEquipment(
          rm * Number(cfg.principal_pct_rm),
          exercise.equipment
        );
        item = baseItem(
          exercise,
          role,
          slot.slot_index,
          weight,
          unit,
          cfg.principal_series,
          cfg.principal_reps,
          cfg.principal_descanso,
          notes
        );
      }
    } else {
      // use_casilleros for principal
      item = baseItem(
        exercise,
        role,
        slot.slot_index,
        aewValue,
        unit,
        cfg.principal_series,
        cfg.principal_reps,
        cfg.principal_descanso,
        notes
      );
    }
  } else {
    // accesorio. Per-slot prescription (migration 038) is the coach-designed
    // set-scheme for this accessory; it takes precedence over the block-level
    // periodization defaults. Compatible progressed reps still win (e.g.
    // 10x10x10 -> 12x12x12), but a stale plain value cannot erase the slot's
    // dropset/pyramid/fixed format. Principals keep periodization above.
    const reps = resolveAccessoryReps(
      slot.reps,
      w?.current_reps_text,
      cfg.accesorio_reps
    );
    item = baseItem(
      exercise,
      role,
      slot.slot_index,
      aewValue,
      unit,
      slot.series ?? cfg.accesorio_series,
      reps,
      slot.descanso ?? cfg.accesorio_descanso,
      notes
    );
  }

  item = applyOverride(item, slot._override, exercise);
  if (weightScheme(item.reps) === 'dropset') {
    const dropCount = (item.reps.match(/\d+/g) ?? []).length;
    const suggestedDrops = suggestDropWeights(
      dropCount,
      item.suggested_value,
      lastDropsByEx.get(exercise.id) ?? []
    );
    if (suggestedDrops) item = { ...item, suggested_drops: suggestedDrops };
  }
  return item;
}

/**
 * Applies an active weekly override to an already-built SessionItem.
 * Only 'reduce_intensity' overrides reach here — 'swap' and 'skip' are
 * handled upstream by applyOverridesToSlots before buildItem is called.
 */
function applyOverride(
  item: SessionItem,
  override: WeeklyOverride | undefined,
  exercise: Exercise
): SessionItem {
  if (!override || override.override_type !== 'reduce_intensity') return item;

  const payload = override.intensity_payload as {
    sets_delta?: number;
    weight_pct?: number;
    rpe_delta?: number;
  };

  let { series, suggested_value } = item;

  if (typeof payload.sets_delta === 'number') {
    series = Math.max(1, series + payload.sets_delta);
  }

  if (typeof payload.weight_pct === 'number' && suggested_value !== null) {
    const adjusted = suggested_value * payload.weight_pct;
    suggested_value = roundWeightForEquipment(adjusted, exercise.equipment);
  }

  // TODO: rpe_delta is recorded in weekly_overrides.intensity_payload but
  // SessionItem does not currently expose a target_rpe field. Skip for now.

  return { ...item, series, suggested_value };
}

export function buildWarmupItem(
  exercise: Exercise,
  unit: 'kg' | 'ladrillos',
  slotIndex: number,
  notes: string | null,
  series = 1
): SessionItem {
  const warmupTarget =
    exercise.default_target ?? (exercise.modality === 'reps' ? '10' : '');
  // 1 serie SIEMPRE (coach-corrections-001 C1; was 2 before the coach's
  // video update).
  return baseItem(
    exercise,
    'calentamiento',
    slotIndex,
    null,
    unit,
    series,
    warmupTarget,
    '1 min',
    notes
  );
}

function baseItem(
  ex: Exercise,
  role: SlotRole,
  slotIndex: number,
  weight: number | null,
  unit: 'kg' | 'ladrillos',
  series: number,
  reps: string,
  descanso: string,
  notes: string | null,
  flag?: 'rm_test' | 'missing_rm' | 'amrap' | 'rm_already_done'
): SessionItem {
  return {
    exercise: ex,
    role,
    slot_index: slotIndex,
    suggested_value: weight === null ? null : Number(weight),
    unit,
    series,
    reps,
    modality: ex.modality,
    descanso,
    notes,
    ...(flag ? { flag } : {}),
  };
}

/**
 * Días de la semana de programa que el atleta todavía no terminó, en orden.
 * Fuente única para "qué puedo entrenar hoy": la usa el arranque de sesión y
 * el dashboard. Vacío cuando la semana está completa.
 *
 * Antes esto era MAX(day_of_week) + 1, así que terminar un día fuera de orden
 * dejaba los anteriores inalcanzables para siempre. Un día postergado ahora
 * vuelve a ofrecerse.
 */
export async function listPendingDays(athleteId: string): Promise<number[]> {
  const stateR = await pool.query<{
    current_week: number | null;
    active_skeleton_id: string | null;
  }>(
    `SELECT current_week, active_skeleton_id
       FROM athlete_program_state WHERE athlete_id = $1`,
    [athleteId]
  );
  const state = stateR.rows[0];

  const profileR = await pool.query<{ days_per_week: number | null }>(
    `SELECT days_per_week FROM athlete_profiles WHERE user_id = $1`,
    [athleteId]
  );
  const daysPerWeek = profileR.rows[0]?.days_per_week ?? 7;

  if (!state || !state.active_skeleton_id) return [1];

  const doneR = await pool.query<{ day_of_week: number }>(
    `SELECT DISTINCT day_of_week
       FROM session_logs
      WHERE athlete_id = $1
        AND program_week = $2
        AND finished_at IS NOT NULL`,
    [athleteId, state.current_week ?? 0]
  );
  const done = new Set(doneR.rows.map((r) => r.day_of_week));

  const pending: number[] = [];
  for (let d = 1; d <= daysPerWeek; d++) {
    if (!done.has(d)) pending.push(d);
  }
  return pending;
}

/**
 * Próximo día pendiente del atleta: el menor sin terminar de la semana de
 * programa. Con la semana completa vuelve al 1 (arranca el ciclo siguiente).
 */
export async function computeNextPendingDay(
  athleteId: string
): Promise<number> {
  const pending = await listPendingDays(athleteId);
  return pending[0] ?? 1;
}
