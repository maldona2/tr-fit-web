import type { ActivityEvent, AuditType } from '@/types/api';

const LABELS: Record<AuditType, string> = {
  user_created: 'Usuario creado',
  user_approved: 'Usuario aprobado',
  user_rejected: 'Usuario rechazado',
  user_deleted: 'Usuario eliminado',
  role_changed: 'Rol cambiado',
  email_verified: 'Email verificado',
  email_unverified: 'Email desverificado',
  subscription_created: 'Suscripción creada',
  subscription_updated: 'Suscripción actualizada',
  subscription_cancelled: 'Suscripción cancelada',
  subscription_authorized: 'Suscripción activada',
  subscription_paused: 'Suscripción pausada',
  membership_paused: 'Membresía pausada',
  membership_resumed: 'Membresía reanudada',
  membership_vacation: 'Pago por vacaciones',
  athlete_rm_changed: 'RM actualizado',
  athlete_weight_changed: 'Peso de ejercicio actualizado',
  program_week_set: 'Semana del plan',
  force_logout: 'Logout forzado',
};

export function activityLabel(type: AuditType): string {
  return LABELS[type] ?? type;
}

export function activitySub(ev: ActivityEvent): string | null {
  const meta = ev.meta;
  if (!meta) return null;
  if (ev.type === 'role_changed' && meta.from && meta.to) {
    return `${String(meta.from)} → ${String(meta.to)}`;
  }
  if (
    ev.type === 'program_week_set' &&
    meta.from_week != null &&
    meta.to_week != null
  ) {
    return `Semana ${String(meta.from_week)} → ${String(meta.to_week)}`;
  }
  if (
    (ev.type === 'subscription_created' ||
      ev.type === 'subscription_updated' ||
      ev.type === 'subscription_authorized' ||
      ev.type === 'subscription_paused' ||
      ev.type === 'subscription_cancelled') &&
    meta.tier
  ) {
    return String(meta.tier);
  }
  return null;
}
