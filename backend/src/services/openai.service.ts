// AI ADJUSTER for template-first routine generation.
//
// The routine is NOT composed by the model anymore: the coach's Excel
// template (template.service) is the literal base. This service receives the
// template plus the reasons it can't be used verbatim (unavailable exercises,
// shorter session, different day count, coach feedback) and asks the model to
// return the COMPLETE routine with the minimum necessary modifications.
// Server-side validators guard the result; on violation we retry with the
// error appended (MAX_ATTEMPTS total).

import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { env } from '../config/env.js';
import { aiSkeletonOutput, type AiSkeletonOutput } from '../domain/schemas.js';
import type { AthleteProfile, Exercise } from '../domain/types.js';
import type { RoutineTemplate } from './template.service.js';
import { seriesRangeFor } from './series-budget.js';
import { enforceFirstWarmup, normalizeWarmupRoles } from './warmup-rule.js';
import logger from '../utils/logger.js';
import { sendOpenAiAccountAlert } from './email.service.js';

// Explicit timeout: the default (10 min per attempt) let a single onboarding
// request hang across deploys. 120s bounds each attempt; the regen worker
// retries the whole job with backoff anyway.
const client = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: 120_000,
  maxRetries: 1,
});

// ponytail: in-memory throttle, resets on deploy (one extra mail per deploy
// at worst). Move to a DB row if the API ever runs more than one instance.
export const ACCOUNT_ALERT_EVERY_MS = 6 * 60 * 60 * 1000;
let lastAccountAlertAt = 0;

// 401 = key revoked/wrong; 429 insufficient_quota = out of credits. Both need
// a human, so mail ops (throttled) instead of only logging.
function alertIfAccountProblem(e: unknown): void {
  const { status, code } = (e ?? {}) as { status?: number; code?: string };
  const reason =
    status === 401
      ? 'La API key de OpenAI fue rechazada (401). Puede estar revocada o mal cargada.'
      : status === 429 && code === 'insufficient_quota'
        ? 'La cuenta de OpenAI se quedó sin crédito (insufficient_quota).'
        : null;
  if (!reason || Date.now() - lastAccountAlertAt < ACCOUNT_ALERT_EVERY_MS) return;
  lastAccountAlertAt = Date.now();
  sendOpenAiAccountAlert(reason).catch((err) =>
    logger.error({ err }, 'openai: account alert mail failed'),
  );
}

const MAX_ATTEMPTS = 5;
const PRINCIPAL_MAX = 3;
const PRINCIPAL_SERIES = 3;
const ACCESSORY_SERIES_DEFAULT = 2;

export interface AdjustSkeletonInput {
  template: RoutineTemplate;
  profile: AthleteProfile;
  /** Athlete-filtered catalog: the only exercises the output may use. */
  exercises: Exercise[];
  /** Human-readable adjustment reasons built by routine-generation.service. */
  reasons: string[];
}

function broadMuscleGroup(mg: string): string {
  return mg.split('-')[0].trim().toLowerCase();
}

const SYSTEM_PROMPT = `Sos el asistente de un entrenador de fuerza real. Recibís la RUTINA BASE literal del entrenador (probada con sus alumnos) y una lista de MOTIVOS DE AJUSTE para un atleta puntual.

Tu único trabajo: devolver la rutina COMPLETA en JSON aplicando SOLO los ajustes que piden los motivos. Todo lo que no esté afectado por un motivo se copia EXACTAMENTE igual: mismo orden de días y ejercicios, mismos roles, mismas series/reps/descansos, mismas notas.

Reglas duras:
- El array "days" debe tener EXACTAMENTE la cantidad de días que pide el atleta (days_per_week del mensaje).
- Sólo podés usar exercise_id del catálogo provisto (es el catálogo YA filtrado para este atleta: lesiones, equipamiento, nivel y exclusiones).
- Al reemplazar un ejercicio: elegí el equivalente más cercano (mismo grupo muscular, mismo tipo de estímulo: pesado/aislado/descarga). Una descarga (10x10x10) sólo va en máquina, polea o Smith donde se descarga peso rápido — nunca en prensa ni con peso libre; si no hay equivalente apto, convertí ese slot en un accesorio efectivo (2x"6 a 8").
- Si hay que bajar volumen por tiempo: quitá accesorios enteros (empezando por descargas y finishers) o bajá series; nunca toques los ejercicios principales que abren cada bloque salvo que no entren.
- role en español: "calentamiento", "principal" o "accesorio". Sólo ejercicios con is_principal=true pueden llevar role "principal".
- En slots role "accesorio" completá series/reps/descanso; en "principal" y "calentamiento" dejalos en null.
- slot_index arranca en 1 y es consecutivo por día.
- Devolvé TODOS los campos del schema, con "rationale" explicando en 1-2 frases qué ajustaste y por qué.`;

export async function adjustSkeleton(
  input: AdjustSkeletonInput,
): Promise<AiSkeletonOutput> {
  if (env.EXTERNAL_EFFECTS_ENABLED === 'false') {
    throw new Error('external_effects_disabled');
  }
  const { template, profile, exercises, reasons } = input;
  const N = profile.days_per_week;
  const minutes = profile.exercise_minutes ?? 60;
  const validIds = exercises.map((e) => e.id);
  const exerciseById = new Map(exercises.map((e) => [e.id, e]));
  const timeAdjusted = minutes < 60;
  const expectedSeries = timeAdjusted ? seriesRangeFor(minutes) : null;

  const userMessage = JSON.stringify({
    REQUIRED_DAYS_COUNT: N,
    motivos_de_ajuste: reasons,
    rutina_base: {
      source: template.source,
      days: template.days_detail.map((d, i) => ({
        day_index: i + 1,
        focus: d.focus,
        slots: d.slots.map((s, si) => ({
          slot_index: si + 1,
          exercise_id: s.exercise_id,
          exercise_name: s.exercise_name,
          muscle_group: s.muscle_group,
          role: s.role,
          series: s.series,
          reps: s.reps,
          descanso: s.descanso,
          notes: s.notes,
        })),
      })),
    },
    athlete: {
      gender: profile.gender, age: profile.age, level: profile.level,
      goal: profile.goal, days_per_week: N,
      leg_days: profile.leg_days, equipment: profile.equipment,
      injuries: profile.injuries, training_mode: profile.training_mode,
      exercise_minutes: minutes, days_specific: profile.days_specific,
    },
    ...(expectedSeries
      ? {
          series_budget_per_day: {
            ...expectedSeries,
            note: 'series TOTALES por día tras el ajuste (calentamientos cuentan 1, principales 3)',
          },
        }
      : {}),
    valid_exercise_ids: validIds,
    exercise_catalog: exercises.map((e) => ({
      id: e.id, name: e.name, muscle_group: e.muscle_group,
      equipment: e.equipment, movement_pattern: e.movement_pattern,
      is_principal: e.is_principal, level_min: e.level_min,
    })),
  });

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ];
    if (lastError) {
      messages.push({
        role: 'user',
        content: `ATENCIÓN: tu output anterior violó la restricción: "${lastError}". Corregilo manteniendo la rutina base intacta en todo lo demás.`,
      });
    }

    const isGpt5 = env.OPENAI_MODEL.startsWith('gpt-5');
    let completion;
    try {
      completion = await client.chat.completions.parse({
        model: env.OPENAI_MODEL,
        messages,
        ...(isGpt5 ? {} : { temperature: 0.2 }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response_format: zodResponseFormat(aiSkeletonOutput as any, 'skeleton'),
      });
    } catch (e) {
      alertIfAccountProblem(e);
      throw e;
    }

    const choice = completion.choices[0];
    if (choice?.message?.refusal) {
      lastError = `model refusal: ${choice.message.refusal}`;
      logger.warn({ attempt, refusal: choice.message.refusal }, 'openai: refusal');
      continue;
    }
    const result = aiSkeletonOutput.safeParse(choice?.message?.parsed);
    if (!result.success) {
      lastError = 'invalid skeleton output';
      logger.warn({ attempt }, 'openai: invalid skeleton output');
      continue;
    }

    // Deterministic backstop (was dropped in the template-first rewrite and
    // let mistagged warm-ups through): re-tag warm-ups the model mislabeled
    // BEFORE validating (so the series budget counts them as 1), then force
    // the mandatory joint-mobility warm-up into slot 1 of every day.
    const normalized = normalizeWarmupRoles(result.data, exercises);

    lastError = validateAdjusted(normalized, {
      N, minutes, exerciseById, expectedSeries,
    });
    if (lastError) {
      logger.warn({ attempt, error: lastError }, 'openai: adjust constraint');
      continue;
    }
    return enforceFirstWarmup(normalized, exercises);
  }

  throw new Error(
    `skeleton adjustment invalid after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  );
}

// Minimal safety net. The template itself is authoritative (the coach's own
// Excels break some of his stated heuristics), so we only validate what the
// ADJUSTMENT must guarantee: right day count, only athlete-allowed exercises,
// sane principals, weekly coverage, and the series budget when the session
// was shortened.
function validateAdjusted(
  out: AiSkeletonOutput,
  ctx: {
    N: number;
    minutes: number;
    exerciseById: Map<number, Exercise>;
    expectedSeries: { min: number; max: number } | null;
  },
): string | null {
  const { N, minutes, exerciseById, expectedSeries } = ctx;

  if (out.days.length !== N) {
    return `days.length=${out.days.length} debe ser ${N}`;
  }

  const weeklyGroups = new Set<string>();
  for (const day of out.days) {
    const principals = day.slots.filter((s) => s.role === 'principal');
    if (principals.length > PRINCIPAL_MAX) {
      return `day ${day.day_index} tiene ${principals.length} principales; máximo ${PRINCIPAL_MAX}`;
    }
    const principalBases: string[] = [];
    let daySeries = 0;

    for (const s of day.slots) {
      const ex = exerciseById.get(s.exercise_id);
      if (!ex) {
        return `exercise_id ${s.exercise_id} no está en el catálogo permitido de este atleta`;
      }
      if (s.role === 'principal') {
        if (!ex.is_principal) {
          return `day ${day.day_index}: "${ex.name}" no puede ser principal (is_principal=false)`;
        }
        principalBases.push(broadMuscleGroup(ex.muscle_group));
      }
      if (s.role === 'calentamiento') {
        daySeries += 1;
        continue;
      }
      weeklyGroups.add(broadMuscleGroup(ex.muscle_group));
      daySeries +=
        s.role === 'principal'
          ? PRINCIPAL_SERIES
          : s.series ?? ACCESSORY_SERIES_DEFAULT;
    }

    if (new Set(principalBases).size !== principalBases.length) {
      return `day ${day.day_index} tiene dos principales del mismo grupo base`;
    }
    if (
      expectedSeries &&
      (daySeries < expectedSeries.min || daySeries > expectedSeries.max)
    ) {
      return `day ${day.day_index} tiene ${daySeries} series totales; para ${minutes} min deben ser ${expectedSeries.min}-${expectedSeries.max}`;
    }
  }

  if (minutes >= 60) {
    const missing = [
      'piernas', 'pecho', 'espalda', 'hombros', 'biceps', 'triceps', 'abdomen',
    ].filter((g) => !weeklyGroups.has(g));
    if (missing.length > 0) {
      return `la semana no programa: ${missing.join(', ')} (los 7 grupos son obligatorios)`;
    }
  }
  return null;
}
