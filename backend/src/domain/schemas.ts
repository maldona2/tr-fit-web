import { z } from 'zod';
import { ALERT_RESOLUTION_ACTIONS } from './alert-actions.js';

export const measurementPayload = z.object({
  chest_cm: z.number().min(30).max(200).optional(),
  waist_cm: z.number().min(30).max(200).optional(),
  hip_cm: z.number().min(30).max(200).optional(),
  thigh_cm: z.number().min(20).max(120).optional(),
  calf_cm: z.number().min(15).max(80).optional(),
  bicep_cm: z.number().min(15).max(80).optional(),
  body_weight_kg: z.number().min(30).max(300).optional(),
});

const BIRTH_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// days_specific[i] is the weekday of session i+1, so it has to be stored in
// weekday order. The app submits it in tap order (lun, mar, vie, jue), which
// surfaced as "Día 3 · Viernes / Día 4 · Jueves" in the admin: normalize here
// so every write path lands sorted.
const WEEKDAYS = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'] as const;
type WeekdayKey = (typeof WEEKDAYS)[number];
const weekdayEnum = z.enum(WEEKDAYS);

export function sortWeekdays(days: WeekdayKey[]): WeekdayKey[] {
  return [...days].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
}

/**
 * Derives the current age from an ISO YYYY-MM-DD birth date. Returns null for
 * malformed strings or impossible calendar dates (e.g. 2000-02-31). "today" is
 * injectable for tests; comparison uses server-local date parts.
 */
export function ageFromBirthDate(
  iso: string,
  today = new Date()
): number | null {
  if (!BIRTH_DATE_RE.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== m - 1 ||
    check.getUTCDate() !== d
  ) {
    return null;
  }
  let age = today.getFullYear() - y;
  const beforeBirthdayThisYear =
    today.getMonth() + 1 < m ||
    (today.getMonth() + 1 === m && today.getDate() < d);
  if (beforeBirthdayThisYear) age -= 1;
  return age;
}

export const onboardingPayload = z
  .object({
    // Legacy clients still send these fields. New clients capture them during
    // signup and the onboarding route reads them from users.
    name: z.string().min(1).max(100).optional(),
    gender: z.enum(['male', 'female', 'other']),
    age: z.number().int().min(12).max(100),
    // New apps send the birth date and derive `age` from it (age alone goes
    // stale). Optional for backward compatibility with older app builds.
    birth_date: z.string().regex(BIRTH_DATE_RE).optional(),
    height_cm: z.number().int().min(100).max(250),
    weight_kg: z.number().min(30).max(250),
    level: z.enum(['nunca', 'bajo', 'medio', 'avanzado', 'muy_avanzado']),
    goal: z.enum(['hipertrofia', 'fuerza', 'recomp', 'perdida_grasa']),
    days_per_week: z.number().int().min(2).max(6),
    // Men choose 1 or 2 leg days; this drives the split shape. Women omit it
    // (their split is lower-biased by default). Optional + nullable for legacy.
    leg_days: z.union([z.literal(1), z.literal(2)]).nullish(),
    equipment: z.enum(['gym_completo', 'gym_basico', 'casa_basica', 'solo_bw']),
    injuries: z.array(z.string()).default([]),
    phone: z
      .string()
      .regex(/^\+\d{10,15}$/)
      .optional(),
    // Legacy field — subscriptions are now handled outside the app and the backend
    // no longer gates on tier. The app always sends 'full'; accept it for backward
    // compatibility but tolerate omission (defaults to 'full') so a future app
    // build can drop it without a backend change. Column stays nullable in the DB.
    plan_interest: z
      .enum(['basico', 'full', 'premium'])
      .optional()
      .default('full'),
    training_mode: z.enum(['gym', 'casa', 'mixto']),
    commitment: z.enum(['suave', 'normal', 'exigente']),
    // Session-time options shown in onboarding: 1 h, 1 h 15, 1 h 45, 2 h.
    // (Legacy 30/45/90 remain valid in the DB CHECK for existing profiles.)
    exercise_minutes: z.union([
      z.literal(60),
      z.literal(75),
      z.literal(105),
      z.literal(120),
    ]),
    days_specific: z.array(weekdayEnum).transform(sortWeekdays),
    referral_source: z.enum([
      'instagram',
      'facebook',
      'google',
      'amigo',
      'otro',
    ]),
    sport_focus: z.string().max(200).optional(),
    measurements: measurementPayload.optional(),
  })
  .refine((d) => d.days_specific.length === d.days_per_week, {
    error: 'days_specific length must equal days_per_week',
    path: ['days_specific'],
  })
  .refine((d) => new Set(d.days_specific).size === d.days_specific.length, {
    error: 'days_specific must not contain duplicates',
    path: ['days_specific'],
  })
  .refine((d) => d.leg_days == null || d.leg_days <= d.days_per_week, {
    error: 'leg_days must not exceed days_per_week',
    path: ['leg_days'],
  })
  .refine(
    (d) => {
      if (d.birth_date == null) return true;
      const derived = ageFromBirthDate(d.birth_date);
      return derived != null && derived >= 12 && derived <= 100;
    },
    {
      error:
        'birth_date must be a valid date with derived age between 12 and 100',
      path: ['birth_date'],
    }
  )
  .refine(
    (d) => {
      if (d.birth_date == null) return true;
      const derived = ageFromBirthDate(d.birth_date);
      // Invalid dates already fail the previous refine; only check consistency.
      // ±1 year tolerance: the app derives age when the draft is filled, so a
      // birthday (or a timezone edge) between draft and submit must not reject.
      return derived == null || Math.abs(derived - d.age) <= 1;
    },
    {
      error: 'age is inconsistent with birth_date',
      path: ['age'],
    }
  );

export type MeasurementPayload = z.infer<typeof measurementPayload>;

// Post-onboarding profile edit (PATCH /athlete/me). All fields optional — the
// mobile app sends a diff of only the changed fields. Ranges mirror
// onboardingPayload so an edited value is never less valid than the original.
export const profileUpdatePayload = z
  .object({
    name: z.string().min(1).max(100),
    gender: z.enum(['male', 'female', 'other']),
    age: z.number().int().min(12).max(100),
    height_cm: z.number().int().min(100).max(250),
    weight_kg: z.number().min(30).max(250),
    goal: z.enum(['hipertrofia', 'fuerza', 'recomp', 'perdida_grasa']),
    days_per_week: z.number().int().min(2).max(6),
    days_specific: z.array(weekdayEnum).min(2).max(6).transform(sortWeekdays),
    leg_days: z.union([z.literal(1), z.literal(2)]).nullable(),
    // Editable post-onboarding so athletes who signed up before the field
    // existed can set it (enables the birthday celebration in the app). The
    // route derives and writes `age` from it — birth_date is the source of truth.
    birth_date: z.string().regex(BIRTH_DATE_RE),
  })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    error: 'at least one field required',
  })
  .refine(
    (d) =>
      d.leg_days == null ||
      d.days_per_week == null ||
      d.leg_days <= d.days_per_week,
    { error: 'leg_days must not exceed days_per_week', path: ['leg_days'] }
  )
  .refine((d) => d.days_specific == null || d.days_per_week != null, {
    error: 'days_per_week is required with days_specific',
    path: ['days_per_week'],
  })
  .refine(
    (d) =>
      d.days_specific == null ||
      new Set(d.days_specific).size === d.days_specific.length,
    {
      error: 'days_specific must not contain duplicates',
      path: ['days_specific'],
    }
  )
  .refine(
    (d) =>
      d.days_specific == null || d.days_specific.length === d.days_per_week,
    {
      error: 'days_specific length must equal days_per_week',
      path: ['days_specific'],
    }
  )
  .refine(
    (d) => {
      if (d.birth_date == null) return true;
      const derived = ageFromBirthDate(d.birth_date);
      return derived != null && derived >= 12 && derived <= 100;
    },
    {
      error:
        'birth_date must be a valid date with derived age between 12 and 100',
      path: ['birth_date'],
    }
  );

export type ProfileUpdatePayload = z.infer<typeof profileUpdatePayload>;

export const rmPayload = z.object({
  exercise_id: z.number().int().positive(),
  value_kg: z.number().min(1).max(500),
  // Opcional: la app no conoce la semana de programa de forma confiable, y
  // rm_tests está keyeada por program_week. Cuando falta, la ruta la deriva
  // de athlete_program_state. Clientes viejos la siguen mandando explícita.
  week: z.union([z.literal(10), z.literal(20), z.literal(30)]).optional(),
});

export const amrapPayload = z.object({
  exercise_id: z.number().int().positive(),
  weight_used: z.number().min(1).max(500),
  reps: z.number().int().min(1).max(100),
});

export type AmrapPayload = z.infer<typeof amrapPayload>;

export const skeletonRejectPayload = z.object({
  feedback: z.string().min(5).max(2000),
});

export const skeletonApprovePayload = z.object({
  slot_overrides: z
    .array(
      z.object({
        slot_id: z.string().uuid(),
        exercise_id: z.number().int().positive(),
        notes: z.string().max(2000).nullable().optional(),
        // Per-slot set scheme (accessories only at runtime). Sent when the
        // coach edits series/reps/descanso in the approval dashboard.
        series: z.number().int().min(1).max(6).nullable().optional(),
        reps: z.string().min(1).max(40).nullable().optional(),
        descanso: z.string().min(1).max(40).nullable().optional(),
      })
    )
    .max(200)
    .optional(),
  slot_order: z
    .array(
      z.object({
        slot_id: z.string().uuid(),
        day_of_week: z.number().int().min(1).max(7),
        slot_index: z.number().int().min(1).max(12),
      })
    )
    .max(200)
    .optional(),
  // Slots the coach removed from the routine before approving.
  deleted_slot_ids: z.array(z.string().uuid()).max(200).optional(),
  // Brand-new slots the coach added in the approval dashboard. The client
  // generates the uuid so the slot can be edited/reordered locally before
  // approving; the server inserts it with that id ahead of reorder & seeding.
  added_slots: z
    .array(
      z.object({
        id: z.string().uuid(),
        day_of_week: z.number().int().min(1).max(7),
        exercise_id: z.number().int().positive(),
        role: z.enum(['calentamiento', 'principal', 'accesorio']),
        notes: z.string().max(2000).nullable().optional(),
        series: z.number().int().min(1).max(6).nullable().optional(),
        reps: z.string().min(1).max(40).nullable().optional(),
        descanso: z.string().min(1).max(40).nullable().optional(),
      })
    )
    .max(200)
    .optional(),
  // Muscle-group label shown as the day's subtitle. The coach can rename it
  // when they move a day's work around by hand.
  // An empty focus clears the day's label (the row is deleted). Reordering
  // days has to be able to move a blank label onto a day that had one.
  day_focus: z
    .array(
      z.object({
        day_of_week: z.number().int().min(1).max(7),
        focus: z.string().trim().max(120),
      })
    )
    .max(7)
    .optional(),
});

export type SkeletonApprovePayload = z.infer<typeof skeletonApprovePayload>;

// The activas editor's batched draft save reuses the exact approval shape.
export const adminApplyEditsPayload = skeletonApprovePayload;
export type AdminApplyEditsInput = z.infer<typeof adminApplyEditsPayload>;

// IA structured output schema (also used for runtime validation)
export const aiSkeletonOutput = z.object({
  rationale: z.string(),
  days: z
    .array(
      z.object({
        day_index: z.number().int().min(1).max(7),
        focus: z.string(),
        slots: z
          .array(
            z.object({
              slot_index: z.number().int().min(1).max(12),
              exercise_id: z.number().int().positive(),
              role: z.enum(['calentamiento', 'principal', 'accesorio']),
              notes: z.string().nullable(),
              // Per-slot prescription. Filled for role="accesorio" (the set-scheme:
              // series, reps string like "8" / "10x10x10", and descanso). Left null
              // for principals/warmups — they keep the 30-week periodization /
              // warmup defaults. The engine only consumes these for accessories.
              series: z.number().int().min(1).max(6).nullable(),
              reps: z.string().min(1).max(40).nullable(),
              descanso: z.string().min(1).max(40).nullable(),
            })
          )
          .min(1)
          .max(12),
      })
    )
    .min(1)
    .max(7),
});

export type AiSkeletonOutput = z.infer<typeof aiSkeletonOutput>;
export type OnboardingPayload = z.infer<typeof onboardingPayload>;
export type RmPayload = z.infer<typeof rmPayload>;

export const signupPayload = z
  .object({
    email: z.email().toLowerCase(),
    password: z.string().min(8).max(200),
    // Optional as a group so already-released app builds can keep signing up.
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    phone: z
      .string()
      .regex(/^\+\d{10,15}$/)
      .optional(),
  })
  .refine(
    (data) => {
      const contact = [data.firstName, data.lastName, data.phone];
      return (
        contact.every((value) => value == null) ||
        contact.every((value) => value != null)
      );
    },
    { error: 'signup contact fields must be provided together' }
  );

export const loginPayload = z.object({
  email: z.email().toLowerCase(),
  password: z.string().min(1),
});

export const refreshPayload = z.object({
  refreshToken: z.string().min(32),
});

export const logoutPayload = z.object({
  refreshToken: z.string().min(32),
});

export const deleteAccountPayload = z.object({
  password: z.string().min(1),
});

export const forgotPasswordPayload = z.object({
  email: z.email().toLowerCase(),
});

export const verifyResetCodePayload = z.object({
  email: z.email().toLowerCase(),
  code: z.string().regex(/^\d{6}$/),
});

export const resetPasswordPayload = z.object({
  email: z.email().toLowerCase(),
  code: z.string().regex(/^\d{6}$/),
  newPassword: z.string().max(200),
});

export type SignupPayload = z.infer<typeof signupPayload>;
export type LoginPayload = z.infer<typeof loginPayload>;
export type RefreshPayload = z.infer<typeof refreshPayload>;
export type ForgotPasswordPayload = z.infer<typeof forgotPasswordPayload>;
export type VerifyResetCodePayload = z.infer<typeof verifyResetCodePayload>;
export type ResetPasswordPayload = z.infer<typeof resetPasswordPayload>;

export const startSessionPayload = z.object({
  // Ignorado por el servidor (el día se computa server-side); se sigue
  // aceptando para que builds viejas de la app no rompan.
  day_of_week: z.number().int().min(1).max(7).optional(),
  // Día ELEGIDO por el atleta ("Entrenar este"). Campo nuevo y separado de
  // `day_of_week` justamente porque aquel viaja con basura en builds viejas.
  pick_day_of_week: z.number().int().min(1).max(7).optional(),
  client_id: z.string().uuid(),
  // Override del guard "ya entrenaste hoy" ("Entrenar de todas formas").
  force: z.boolean().optional(),
});

export const setLogPayload = z.object({
  exercise_id: z.number().int().positive(),
  set_index: z.number().int().min(1).max(20),
  value: z.number().min(0).max(500).nullable(),
  unit: z.enum(['kg', 'ladrillos']),
  reps: z.number().int().min(0).max(100).nullable(),
  completed: z.boolean(),
  rpe: z.number().min(1).max(10).nullable().optional(),
  // Dropset support: 1 = first/heaviest drop, 2, 3 … NULL = normal single set.
  drop_index: z.number().int().min(1).max(10).nullable().optional(),
  client_id: z.string().uuid(),
  client_ts: z.string().datetime(),
});

export const syncPayload = z.object({
  sets: z.array(setLogPayload).min(1).max(200),
});

export const finishSessionPayload = z.object({
  fatigue_rating: z.enum(['suave', 'normal', 'exigente']),
  // Optional free-text note for the coach. Trimmed and capped so a runaway
  // paste can't bloat the row.
  note: z.string().trim().max(1000).optional(),
});

export const alertPayload = z.object({
  type: z.enum(['sos_pain', 'sos_machine']),
  exercise_id: z.number().int().positive().optional(),
  session_log_id: z.string().uuid().optional(),
  payload: z.union([
    z.object({
      zone: z.enum([
        'lumbar',
        'rodilla',
        'hombro',
        'cervical',
        'cadera',
        'otro',
      ]),
      intensity: z.number().int().min(1).max(10),
    }),
    z.object({
      switched_to_exercise_id: z.number().int().positive(),
    }),
  ]),
});

export type StartSessionPayload = z.infer<typeof startSessionPayload>;
export type SetLogPayload = z.infer<typeof setLogPayload>;
export type SyncPayload = z.infer<typeof syncPayload>;
export type FinishSessionPayload = z.infer<typeof finishSessionPayload>;
export type AlertPayload = z.infer<typeof alertPayload>;

export const pushRegisterPayload = z.object({
  token: z.string().min(20).max(500),
  platform: z.enum(['ios', 'android', 'web']),
});

export const liveActivityRegisterPayload = z.object({
  apnsToken: z.string().min(1),
  activityName: z.string().min(1),
  endMs: z.number().int().positive(),
  props: z.record(z.string(), z.unknown()),
});

export const notificationPrefsPayload = z
  .object({
    session_reminder: z.boolean().optional(),
    session_missed: z.boolean().optional(),
    week_start: z.boolean().optional(),
    skeleton_approved: z.boolean().optional(),
    sos_resolved: z.boolean().optional(),
    rm_test_week: z.boolean().optional(),
    community_announcement: z.boolean().optional(),
    community_event: z.boolean().optional(),
    community_comment: z.boolean().optional(),
  })
  .strict();

export type PushRegisterPayload = z.infer<typeof pushRegisterPayload>;
export type NotificationPrefsPayload = z.infer<typeof notificationPrefsPayload>;

export const slotRoleEnum = z.enum(['calentamiento', 'principal', 'accesorio']);

export const adminSlotCreatePayload = z.object({
  day_of_week: z.number().int().min(1).max(7),
  slot_index: z.number().int().min(1).max(12),
  exercise_id: z.number().int().positive(),
  role: slotRoleEnum,
  notes: z.string().max(2000).nullable().optional(),
});

export const adminSlotPatchPayload = z
  .object({
    exercise_id: z.number().int().positive().optional(),
    notes: z.string().max(2000).nullable().optional(),
    slot_index: z.number().int().min(1).max(12).optional(),
    day_of_week: z.number().int().min(1).max(7).optional(),
    // Per-slot prescription (accessories). null clears back to periodization.
    series: z.number().int().min(1).max(6).nullable().optional(),
    reps: z.string().min(1).max(40).nullable().optional(),
    descanso: z.string().min(1).max(40).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    error: 'empty_patch',
  });

export const adminReorderPayload = z.object({
  slots: z
    .array(
      z.object({
        slot_id: z.string().uuid(),
        day_of_week: z.number().int().min(1).max(7),
        slot_index: z.number().int().min(1).max(12),
      })
    )
    .min(1)
    .max(200),
});

export const adminListAthletesQuery = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const adminTrainingDaysPayload = z
  .object({
    days_specific: z.array(weekdayEnum).min(2).max(6).transform(sortWeekdays),
  })
  .refine(
    (value) => new Set(value.days_specific).size === value.days_specific.length,
    {
      error: 'days_specific must not contain duplicates',
      path: ['days_specific'],
    }
  );

export type AdminSlotCreate = z.infer<typeof adminSlotCreatePayload>;
export type AdminSlotPatch = z.infer<typeof adminSlotPatchPayload>;
export type AdminReorderInput = z.infer<typeof adminReorderPayload>;
export type AdminTrainingDaysInput = z.infer<typeof adminTrainingDaysPayload>;

export const adminProgramWeekPayload = z.object({
  week: z.number().int().min(1).max(30),
});
export type AdminProgramWeekInput = z.infer<typeof adminProgramWeekPayload>;

export const alertResolvePayload = z.object({
  action: z.enum(ALERT_RESOLUTION_ACTIONS),
  payload: z.record(z.string(), z.unknown()).default({}),
  note: z.string().max(2000).optional(),
});
export type AlertResolvePayload = z.infer<typeof alertResolvePayload>;
