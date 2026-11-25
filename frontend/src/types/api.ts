export type Role = 'athlete' | 'admin' | 'superadmin';

export interface User {
  id: string;
  email: string;
  role: Role;
}

export interface AuthLoginResult {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export interface CoachAthlete {
  id: string;
  name: string;
  email: string;
  level: 'nunca' | 'bajo' | 'medio' | 'avanzado' | 'muy_avanzado';
  goal: 'hipertrofia' | 'fuerza' | 'recomp' | 'perdida_grasa';
  days_per_week: number;
  onboarded_at: string;
  current_week: number | null;
  skeleton_status:
    'pending_review' | 'approved' | 'rejected' | 'superseded' | null;
  last_session_at: string | null;
  unread_alerts_count: number;
}

export interface PendingRutina {
  id: string;
  athlete_id: string;
  athlete_name: string;
  created_at: string;
  generation_rationale: string | null;
}

export interface RutinaSlot {
  id: string;
  skeleton_id?: string;
  day_of_week: number;
  slot_index: number;
  exercise_id: number;
  role: 'calentamiento' | 'principal' | 'accesorio';
  notes?: string | null;
  // Per-slot set scheme (accessories). Null → falls back to periodization.
  // reps holds free-form schemes like "10x10x10" (superserie) or "10 - 8 - 6".
  series?: number | null;
  reps?: string | null;
  descanso?: string | null;
  exercise_name?: string;
  muscle_group?: string;
  equipment?: string;
  exercise_archived_at?: string | null;
}

export interface AthleteRutina {
  id: string;
  athlete_id: string;
  status: 'pending_review' | 'approved' | 'rejected' | 'superseded';
  generated_by: 'ai' | 'coach';
  generation_rationale: string | null;
  /** Generation metadata; `template` is the coach base routine used. */
  generation_prompt?: { template?: string } | null;
  rejection_feedback: string | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

export interface RoutineTemplateSummary {
  source: string;
  gender: 'male' | 'female';
  days: number;
  leg_days: number | null;
}

export interface RutinaPeriodization {
  week_number: number;
  block_label: string;
  principal_series: number;
  principal_reps: string;
  principal_descanso: string;
  accesorio_series: number;
  accesorio_reps: string;
  accesorio_descanso: string;
}

export interface RutinaDetail {
  skeleton: AthleteRutina;
  slots: RutinaSlot[];
  periodization: RutinaPeriodization | null;
  profile: {
    name: string;
    gender: 'male' | 'female' | 'other';
    age: number;
    height_cm: number;
    weight_kg: number;
    level: 'nunca' | 'bajo' | 'medio' | 'avanzado' | 'muy_avanzado';
    goal: 'hipertrofia' | 'fuerza' | 'recomp' | 'perdida_grasa';
    days_per_week: number;
    leg_days?: number | null;
    days_specific:
      ('lun' | 'mar' | 'mie' | 'jue' | 'vie' | 'sab' | 'dom')[] | null;
    equipment: 'gym_completo' | 'gym_basico' | 'casa_basica' | 'solo_bw';
    injuries: string[];
    exercise_minutes: number | null;
    sport_focus: string | null;
  };
}

export interface AthleteMeasurement {
  id: string;
  athlete_id: string;
  measured_at: string;
  chest_cm: string | null;
  waist_cm: string | null;
  hip_cm: string | null;
  thigh_cm: string | null;
  calf_cm: string | null;
  bicep_cm: string | null;
  source: 'onboarding' | 'manual' | 'coach';
  created_at: string;
}

export interface AthleteDetailResponse {
  profile: Record<string, unknown>;
  programState: unknown;
  activeSkeleton: { skeleton: unknown; slots: unknown[] } | null;
  recentSessions: unknown[];
  alertsCount: number;
  measurements: AthleteMeasurement[];
}

export type UserStatus = 'pending' | 'approved' | 'rejected';
export type SubscriptionTier = 'basico' | 'full' | 'premium';
export type SubscriptionStatus =
  'pending' | 'authorized' | 'paused' | 'cancelled';

export interface AdminUser {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  email_verified: boolean;
  email_verified_at: string | null;
  created_at: string;
  name: string | null;
  phone: string | null;
  subscription_tier: SubscriptionTier | null;
  subscription_status: SubscriptionStatus | null;
  current_period_end: string | null;
  monthly_fee_ars: number | null;
  membership_status: MembershipStatus | null;
  // 'infinity'::timestamptz serializes as null-ish JSON — treat as sin vencimiento.
  paid_until: string | null;
  last_session_at: string | null;
  days_per_week: number | null;
  days_specific:
    ('lun' | 'mar' | 'mie' | 'jue' | 'vie' | 'sab' | 'dom')[] | null;
  injuries: string[] | null;
  profile: RutinaDetail['profile'] | null;
}

export type MembershipStatus =
  'active' | 'expiring' | 'expired' | 'cancelled' | 'paused' | 'vacation';

export type AuditType =
  | 'user_created'
  | 'user_approved'
  | 'user_rejected'
  | 'user_deleted'
  | 'role_changed'
  | 'email_verified'
  | 'email_unverified'
  | 'subscription_created'
  | 'subscription_updated'
  | 'subscription_cancelled'
  | 'subscription_authorized'
  | 'subscription_paused'
  | 'membership_paused'
  | 'membership_resumed'
  | 'membership_vacation'
  | 'athlete_rm_changed'
  | 'athlete_weight_changed'
  | 'program_week_set'
  | 'force_logout';

export interface AthleteExerciseWeight {
  exercise_id: number;
  exercise_name: string;
  current_value: number | null;
  unit: string;
  scheme: 'normal' | 'dropset';
}

export interface AthleteRm {
  exercise_id: number;
  exercise_name: string;
  program_week: 10 | 20 | 30;
  value_kg: number;
  unit: string | null;
  coach_note: string | null;
  tested_at: string;
}

// Principal of the active routine with no rm_tests row for the week the
// current block reads. The coach can insert it; the list itself has no value.
export interface MissingAthleteRm {
  exercise_id: number;
  exercise_name: string;
  program_week: 10 | 20 | 30;
  unit: string | null;
}

export type ActivitySeverity = 'brand' | 'warning' | 'destructive' | null;

export interface ActivityEvent {
  id: string;
  type: AuditType;
  actor: string;
  target: string | null;
  target_id: string | null;
  meta: Record<string, unknown> | null;
  severity: ActivitySeverity;
  created_at: string;
}

export interface AdminStats {
  signups_30d: number;
  signups_delta_pct: number;
  signups_trend: number[];
  pending_count: number;
  active_subs: number;
  active_subs_delta: number;
  mrr_estimated: number;
  mrr_delta_pct: number;
  mrr_trend: number[];
  churn_pct: number;
  churn_delta_pp: number;
  verified_pct: number;
}

export type AlertResolutionAction =
  | 'swap_exercise'
  | 'skip_week'
  | 'regen_skeleton'
  | 'approve_switch'
  | 'revert_switch'
  | 'reduce_intensity'
  | 'reschedule_rm'
  | 'skip_rm_block'
  | 'acknowledge'
  | 'note_only';

export interface CoachAlert {
  id: string;
  type:
    | 'sos_pain'
    | 'sos_machine'
    | 'rpe_flag'
    | 'rm_skipped'
    | 'rm_week_starting'
    | 'membership_expiring'
    | 'membership_overdue'
    | 'sos_no_machine'
    | 'program_reset';
  severity: 'red' | 'yellow' | 'info';
  athlete_id: string;
  athlete_name: string;
  exercise_id: number | null;
  exercise_name: string | null;
  payload: Record<string, unknown>;
  read_at: string | null;
  resolved_at: string | null;
  created_at: string;
  resolution_action: AlertResolutionAction | null;
  resolution_note: string | null;
  resolved_by_email: string | null;
}

export interface AlertContext {
  alert: CoachAlert;
  suggestedAlternative: { id: number; name: string } | null;
  painHistory: { zone: string; intensity: number; created_at: string }[];
  activeSlot: {
    skeleton_slot_id: string;
    exercise_id: number;
    day_of_week: number;
  } | null;
}

export interface AlertsListResponse {
  items: CoachAlert[];
  total: number;
}

export interface AlertsListFilters {
  status?: 'open' | 'resolved' | 'all';
  type?: string;
  severity?: string;
  athleteId?: string;
}

export type Equipment =
  | 'barra'
  | 'mancuerna'
  | 'maquina'
  | 'polea'
  | 'smith'
  | 'bw'
  | 'pesa_rusa'
  | 'elastico'
  | 'disco';

export type MovementPattern =
  | 'squat'
  | 'hinge'
  | 'push_h'
  | 'push_v'
  | 'pull_h'
  | 'pull_v'
  | 'isolation'
  | 'core'
  | 'cardio';

export type ExerciseLevel = 'principiante' | 'intermedio' | 'avanzado';

export type ExerciseModality = 'reps' | 'tiempo' | 'distancia';

export interface Exercise {
  id: number;
  name: string;
  muscle_group: string;
  equipment: Equipment;
  movement_pattern: MovementPattern;
  is_principal: boolean;
  is_unilateral: boolean;
  level_min: ExerciseLevel;
  contraindicated_for: string[];
  default_increment_kg: number;
  alternatives_ids: number[];
  video_url: string | null;
  illustration_url: string | null;
  modality: ExerciseModality;
  default_target: string | null;
  rep_cycle_threshold: number;
  /** Copied into the slot when the coach adds this exercise to a routine. */
  default_series?: number | null;
  default_descanso?: string | null;
  default_notes?: string | null;
  archived_at: string | null;
}

export interface ActiveAthleteRow {
  athlete_id: string;
  name: string;
  skeleton_id: string;
  reviewed_at: string | null;
  days_per_week: number;
}

export interface RutinaDay {
  day_of_week: number;
  focus: string | null;
}

export interface ActiveRutinaDetail {
  skeleton: {
    id: string;
    athlete_id: string;
    status: string;
    created_at: string;
    reviewed_at: string | null;
  };
  slots: RutinaSlot[];
  days: RutinaDay[];
  profile: {
    user_id: string;
    name: string;
    days_per_week: number;
    days_specific: string[] | null;
  };
  has_active_session: boolean;
  current_week?: number;
  total_weeks?: number;
  /** Session ordinals already finished in the current program week. */
  trained_days_this_week?: number[];
}

export interface ActiveRutinaResponse {
  rutina: ActiveRutinaDetail | null;
  pending_skeleton_id: string | null;
}

export interface SlotCreateInput {
  day_of_week: number;
  slot_index: number;
  exercise_id: number;
  role: 'calentamiento' | 'principal' | 'accesorio';
  notes: string | null;
}

export interface SlotPatchInput {
  exercise_id?: number;
  notes?: string | null;
  slot_index?: number;
  day_of_week?: number;
  // Per-slot prescription (accessories). null clears back to periodization.
  series?: number | null;
  reps?: string | null;
  descanso?: string | null;
}

export interface ReorderInput {
  slots: { slot_id: string; day_of_week: number; slot_index: number }[];
}

export interface ApplyEditsInput {
  slot_overrides?: {
    slot_id: string;
    exercise_id: number;
    notes?: string | null;
    series?: number | null;
    reps?: string | null;
    descanso?: string | null;
  }[];
  slot_order?: {
    slot_id: string;
    day_of_week: number;
    slot_index: number;
  }[];
  deleted_slot_ids?: string[];
  added_slots?: {
    id: string;
    day_of_week: number;
    exercise_id: number;
    role: RutinaSlot['role'];
    notes?: string | null;
    series?: number | null;
    reps?: string | null;
    descanso?: string | null;
  }[];
  day_focus?: { day_of_week: number; focus: string }[];
}
