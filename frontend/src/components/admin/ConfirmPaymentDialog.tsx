import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Segmented } from '@/components/admin/Segmented';
import { fmtARS, fmtShortDate } from '@/lib/format';
import type { AdminUser } from '@/types/api';

export const MEMBERSHIP_LABELS: Record<string, string> = {
  active: 'Activa',
  expiring: 'Por vencer',
  expired: 'Vencida',
  cancelled: 'Cancelada',
  paused: 'Pausada',
  vacation: 'Vacaciones',
};

export const PERIOD_OPTIONS = [
  { key: '1', label: 'Mensual' },
  { key: '3', label: 'Trimestral' },
  { key: '6', label: 'Semestral' },
  { key: '12', label: 'Anual' },
] as const;

export type PeriodMonths = 1 | 3 | 6 | 12;

/**
 * Advance `base` by `months` calendar months, clamping to the target month's
 * last day. Mirrors membership.service.addCalendarMonth so the dialog previews
 * the same date the backend will actually write.
 */
export function addCalendarMonth(base: Date, months = 1): Date {
  const y = base.getFullYear();
  const m = base.getMonth();
  const d = base.getDate();
  const lastDayOfTarget = new Date(y, m + months + 1, 0).getDate();
  const result = new Date(base);
  result.setFullYear(y, m + months, Math.min(d, lastDayOfTarget));
  return result;
}

/** Backend extends from the later of the current expiry or now. */
export function nextExpiry(paidUntil: string | null, months = 1): Date {
  const now = new Date();
  if (!paidUntil) return addCalendarMonth(now, months);
  const cur = new Date(paidUntil);
  return addCalendarMonth(cur.getTime() > now.getTime() ? cur : now, months);
}

export interface ConfirmPaymentPayload {
  amount: number;
  period_months: PeriodMonths;
}

/**
 * Confirmation step before registering a payment — the one action that books
 * revenue and grants access, so it should never fire on a single stray click.
 * Period (mensual / trimestral / semestral / anual) is a single invoice: the
 * lump sum enters this month's 4% and leftover months are not billed again.
 */
export function ConfirmPaymentDialog({
  open,
  user,
  amount,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  user: AdminUser;
  /** Monthly cuota. The dialog multiplies by the chosen period. */
  amount: number;
  pending: boolean;
  onClose: () => void;
  // eslint-disable-next-line no-unused-vars -- param name is the callback contract
  onConfirm: (payload: ConfirmPaymentPayload) => void;
}) {
  const status = user.membership_status;
  const [period, setPeriod] = useState<PeriodMonths>(1);
  const [amountInput, setAmountInput] = useState(String(amount));

  useEffect(() => {
    if (!open) return;
    setPeriod(1);
    setAmountInput(String(amount));
  }, [open, amount]);

  function selectPeriod(next: PeriodMonths) {
    setPeriod(next);
    setAmountInput(String(amount * next));
  }

  const parsedAmount = Number(amountInput);
  const amountValid =
    amountInput.trim() !== '' &&
    Number.isFinite(parsedAmount) &&
    parsedAmount >= 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            ¿Registrar pago de {user.name ?? user.email.split('@')[0]}?
          </DialogTitle>
          <DialogDescription>
            Queda asentado como cobrado y le habilita el acceso. Un trimestre,
            semestre o año se factura una sola vez (4% este mes, los cubiertos
            no se vuelven a facturar).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">Período</div>
            <Segmented
              size="sm"
              className="flex-wrap"
              options={[...PERIOD_OPTIONS]}
              value={String(period) as '1' | '3' | '6' | '12'}
              onChange={(key) => selectPeriod(Number(key) as PeriodMonths)}
            />
          </div>
          <dl className="grid gap-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Alumno</dt>
              <dd className="text-right font-mono text-xs">{user.email}</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">Monto a registrar</dt>
              <dd>
                <input
                  type="number"
                  min={0}
                  step={1000}
                  aria-label="Monto a registrar"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  className="h-8 w-32 rounded-md border border-border bg-background px-2 text-right text-sm font-semibold tabular-nums"
                />
              </dd>
            </div>
            {amountValid && parsedAmount === 0 && (
              <p className="text-xs text-muted-foreground">
                Cortesía (sin cargo).
              </p>
            )}
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Estado actual</dt>
              <dd>
                {status
                  ? (MEMBERSHIP_LABELS[status] ?? status)
                  : 'Sin membresía'}
              </dd>
            </div>
            <div className="flex justify-between gap-4 border-t border-border pt-2">
              <dt className="text-muted-foreground">Vence</dt>
              <dd className="tabular-nums">
                <span className="text-muted-foreground">
                  {user.paid_until ? fmtShortDate(user.paid_until) : '—'}
                </span>
                <span className="mx-1.5 text-muted-foreground">→</span>
                <span className="font-semibold">
                  {fmtShortDate(nextExpiry(user.paid_until, period))}
                </span>
              </dd>
            </div>
            {amountValid && parsedAmount > 0 && (
              <p className="text-xs text-muted-foreground">
                Entra en la factura de este mes: 4% de {fmtARS(parsedAmount)} ={' '}
                {fmtARS(Math.round(parsedAmount * 0.04 * 100) / 100)}.
              </p>
            )}
          </dl>
        </div>
        {user.status === 'rejected' && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
            Esta cuenta está dada de baja. Registrar el pago la reactiva: vuelve
            a tener acceso y el monto cuenta como cobrado del mes.
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button
            onClick={() =>
              amountValid &&
              onConfirm({ amount: parsedAmount, period_months: period })
            }
            disabled={pending || !amountValid}
          >
            {pending ? 'Registrando…' : 'Confirmar pago'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
