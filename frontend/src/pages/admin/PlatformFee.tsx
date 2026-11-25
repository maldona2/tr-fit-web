// frontend/src/pages/admin/PlatformFee.tsx
import { useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { fmtARS, fmtShortDate } from '@/lib/format';
import { Sparkline } from '@/components/admin/Sparkline';
import {
  usePlatformFee,
  usePlatformFeeHistory,
  useUpdatePlatformFeeConfig,
  useApplyAdjustment,
  useFeeLog,
  useMarkPlatformFeePaid,
  useAthleteBillingBreakdown,
  type BillingPhase,
  type PlatformFeeConfig,
} from '@/hooks/usePlatformFee';
import {
  useCommunitySummary,
  type CommunitySummary,
} from '@/hooks/useCommunity';

export default function PlatformFee() {
  const { user } = useAuth();
  const isSuper = user?.role === 'superadmin';
  const { data, isLoading } = usePlatformFee();
  const { data: history } = usePlatformFeeHistory();
  const updateConfig = useUpdatePlatformFeeConfig();
  const applyAdjustment = useApplyAdjustment();
  const markPaid = useMarkPlatformFeePaid();
  const { data: feeLog } = useFeeLog();
  const { data: breakdown } = useAthleteBillingBreakdown();
  const { data: community } = useCommunitySummary();

  const [usdInput, setUsdInput] = useState('');

  if (isLoading || !data) {
    return <div className="p-6 text-sm text-muted-foreground">Cargando…</div>;
  }

  const { summary, config, payment } = data;
  const isTestflight = summary.phase === 'testflight';

  async function onApply() {
    const usd = Number(usdInput);
    if (!usd || usd <= 0) {
      toast.error('Ingresá un dólar válido');
      return;
    }
    const newBase = (config.base_fee_ars * usd) / config.reference_usd;
    const ok = window.confirm(
      `Nuevo fee base: ${fmtARS(Math.round(newBase))} (dólar ${usd}). ¿Aplicar?`
    );
    if (!ok) return;
    try {
      await applyAdjustment.mutateAsync(usd);
      setUsdInput('');
      toast.success('Ajuste aplicado');
    } catch {
      toast.error('No se pudo aplicar el ajuste');
    }
  }

  // Business rule:
  //   Pay invoice month M during M, by the 10th of M.
  //   total = base(M) + 4% of full real of M-1 (closed → nothing lost).
  //   Collections during M feed next invoice (due 10th of M+1).
  const invoiceMonthLabel = monthYearLabel(
    summary.invoice_period ?? summary.due_date
  );
  const realMonthLabel = monthYearLabel(
    summary.revenue_period ?? summary.due_date
  );
  const nextInvoiceMonthLabel = nextMonthLabel(summary.due_date);
  const totalArs = summary.total_ars ?? 0;
  const collectionPct = summary.collection_pct ?? 0;
  const currentRealArs = summary.current_real_ars ?? 0;
  const estimatedArs = summary.gross_estimated_ars ?? 0;
  const coveredArs = summary.covered_ars ?? currentRealArs;

  async function onMarkPaid() {
    const ok = window.confirm(
      `¿Confirmás el pago de ${fmtARS(totalArs)} (factura de ${invoiceMonthLabel})?`
    );
    if (!ok) return;
    try {
      await markPaid.mutateAsync();
      toast.success('Pago registrado');
    } catch {
      toast.error('No se pudo registrar el pago');
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-lg font-bold">Facturación TR-FIT</h1>
        <p className="text-sm text-muted-foreground">
          Se paga el mes en curso hasta el día 10. El{' '}
          {summary.revenue_share_pct}% usa la facturación real del mes anterior
          (cerrado), así no se pierde nada.
        </p>
      </div>

      {/* Invoice for current month, due by the 10th */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Factura de {invoiceMonthLabel}
          </div>
          {isTestflight && (
            <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-amber-600 dark:text-amber-400">
              TestFlight · 50%
            </span>
          )}
          <span
            className={
              'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] ' +
              (payment
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                : summary.overdue
                  ? 'bg-red-500/15 text-red-700 dark:text-red-400'
                  : 'bg-amber-400/15 text-amber-700 dark:text-amber-400')
            }
          >
            {payment
              ? 'Pagado'
              : summary.overdue
                ? 'Vencido'
                : `Vence el 10 de ${invoiceMonthLabel}`}
          </span>
        </div>
        <div className="mt-1 text-3xl font-extrabold tabular-nums">
          {fmtARS(totalArs)}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {payment
            ? `Ya pagado el ${fmtShortDate(payment.paid_at)}.`
            : summary.overdue
              ? `Debía pagarse hasta el 10 de ${invoiceMonthLabel}.`
              : `Pagá en ${invoiceMonthLabel}, hasta el día 10 inclusive.`}
        </p>
        <dl className="mt-4 grid gap-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">
              {isTestflight
                ? `Fee base (50% de ${fmtARS(config.base_fee_ars)})`
                : 'Fee base'}
            </dt>
            <dd className="tabular-nums">{fmtARS(summary.base_fee_ars)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">
              Facturación real de {realMonthLabel} (
              {summary.active_athletes ?? 0} atletas)
            </dt>
            <dd className="tabular-nums">
              {fmtARS(summary.gross_revenue_ars)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">
              {summary.revenue_share_pct}% sobre real de {realMonthLabel}
            </dt>
            <dd className="tabular-nums">
              {isTestflight
                ? '— no aplica en TestFlight'
                : fmtARS(summary.revenue_share_ars)}
            </dd>
          </div>
          {summary.community_fee_ars > 0 && (
            <>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Comunidad (fijo)</dt>
                <dd className="tabular-nums">
                  {fmtARS(summary.community_fee_ars)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">
                  Publicidad de {realMonthLabel}
                </dt>
                <dd className="tabular-nums">
                  {fmtARS(summary.ad_revenue_ars)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">
                  {summary.ad_share_pct}% sobre publicidad de {realMonthLabel}
                </dt>
                <dd className="tabular-nums">{fmtARS(summary.ad_share_ars)}</dd>
              </div>
            </>
          )}
        </dl>
      </div>

      {community?.enabled && (
        <CommunityRevisionCard summary={community} config={config} />
      )}

      <div
        className={
          'flex flex-col gap-3 rounded-lg border p-4 text-sm sm:flex-row sm:items-center sm:justify-between ' +
          (payment
            ? 'border-emerald-500/40 bg-emerald-500/10'
            : summary.overdue
              ? 'border-red-500/40 bg-red-50 dark:bg-red-950/30'
              : 'border-amber-400/50 bg-amber-50 dark:bg-amber-950/30')
        }
      >
        <div>
          <div className="font-semibold">
            {payment
              ? 'Factura pagada'
              : summary.overdue
                ? 'Pago vencido'
                : `Pago pendiente · hasta el 10 de ${invoiceMonthLabel}`}
          </div>
          <div className="text-muted-foreground">
            {payment
              ? `${fmtARS(payment.total_ars)} registrados el ${fmtShortDate(payment.paid_at)}`
              : summary.overdue
                ? `El total de ${fmtARS(totalArs)} debió pagarse el 10 de ${invoiceMonthLabel}.`
                : `Total: ${fmtARS(totalArs)}. Plazo: del 1 al 10 de ${invoiceMonthLabel}.`}
          </div>
        </div>
        {!payment && isSuper && (
          <button
            type="button"
            onClick={onMarkPaid}
            disabled={markPaid.isPending}
            className="h-9 shrink-0 rounded-md bg-primary px-3 font-semibold text-primary-foreground disabled:opacity-60"
          >
            {markPaid.isPending ? 'Registrando…' : 'Marcar como pagado'}
          </button>
        )}
      </div>

      {/* Current month athlete collections → next invoice's 4% */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Facturación real en curso · {invoiceMonthLabel}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Se acumula todo el mes (día 1 al último). El{' '}
          {summary.revenue_share_pct}% del real facturado entra en la factura de{' '}
          {nextInvoiceMonthLabel} (vence el 10). Un trimestre/semestre/año
          cuenta entero el mes del pago; los meses cubiertos no se vuelven a
          facturar.
        </p>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <div className="text-2xl font-extrabold tabular-nums">
            {collectionPct.toLocaleString('es-AR', {
              maximumFractionDigits: 1,
            })}
            %
          </div>
          <div className="text-sm text-muted-foreground">
            al día vs estimado
          </div>
        </div>
        <div
          className="mt-3 h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={Math.min(100, collectionPct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Porcentaje cobrado del mes en curso"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{
              width: `${Math.min(100, Math.max(0, collectionPct))}%`,
            }}
          />
        </div>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
          <div className="flex justify-between gap-2 sm:flex-col sm:justify-start">
            <dt className="text-muted-foreground">Estimado</dt>
            <dd className="font-semibold tabular-nums">
              {fmtARS(estimatedArs)}
              <span className="ml-1 font-normal text-muted-foreground">
                ({summary.estimated_athletes ?? 0})
              </span>
            </dd>
          </div>
          <div className="flex justify-between gap-2 sm:flex-col sm:justify-start">
            <dt className="text-muted-foreground">Facturado (4%)</dt>
            <dd className="font-semibold tabular-nums">
              {fmtARS(currentRealArs)}
              <span className="ml-1 font-normal text-muted-foreground">
                ({summary.current_real_athletes ?? 0})
              </span>
            </dd>
          </div>
          <div className="flex justify-between gap-2 sm:flex-col sm:justify-start">
            <dt className="text-muted-foreground">Pendiente</dt>
            <dd className="font-semibold tabular-nums">
              {fmtARS(Math.max(0, estimatedArs - coveredArs))}
            </dd>
          </div>
        </dl>
      </div>

      {/* Per-athlete breakdown: which pool (Estimado / Real) each athlete falls in and why */}
      <details className="rounded-lg border border-border bg-card p-5">
        <summary className="flex cursor-pointer items-center justify-between text-sm font-semibold">
          <span>Detalle por alumno ({breakdown?.length ?? 0})</span>
          {breakdown && breakdown.length > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                exportBreakdownCsv(breakdown);
              }}
              className="rounded-md border border-border px-2 py-1 text-xs font-semibold text-muted-foreground hover:bg-muted"
            >
              Descargar CSV
            </button>
          )}
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">
          <strong>Estimado</strong> = todos los alumnos con membresía activa
          (paguen o no este ciclo). <strong>Real</strong> = lo facturado este
          mes (un trimestre/semestre/año cuenta entero el mes del pago).{' '}
          <strong>Prepago</strong> = cubiertos por un pago anterior; no entran
          en el 4% de este mes.
        </p>
        {!breakdown || breakdown.length === 0 ? (
          <div className="mt-3 text-sm text-muted-foreground">Sin datos.</div>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-1">Alumno</th>
                  <th className="py-1 text-right">Cuota</th>
                  <th className="py-1 text-right">Facturado</th>
                  <th className="py-1">Estado</th>
                  <th className="py-1">Vence</th>
                  <th className="py-1 text-right">Pool</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((row) => (
                  <tr key={row.athlete_id} className="border-t border-border">
                    <td className="py-1.5">{row.name}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {fmtARS(row.fee_ars)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {fmtARS(row.billed_ars)}
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {row.membership_status}
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {row.paid_until === 'infinity'
                        ? 'Sin vencimiento'
                        : fmtShortDate(row.paid_until)}
                    </td>
                    <td className="py-1.5 text-right">
                      <span
                        className={
                          'inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ' +
                          (billingPool(row) === 'Real'
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                            : billingPool(row) === 'Prepago'
                              ? 'bg-sky-500/15 text-sky-700 dark:text-sky-400'
                              : 'bg-muted text-muted-foreground')
                        }
                      >
                        {billingPool(row)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>

      {/* Adjustment banner */}
      <div
        className={
          'rounded-lg border p-4 text-sm ' +
          (summary.adjustment_due
            ? 'border-amber-400/50 bg-amber-50 dark:bg-amber-950/30'
            : 'border-border bg-card')
        }
      >
        <div className="font-semibold">
          {summary.adjustment_due
            ? 'Ajuste trimestral disponible'
            : 'Próximo ajuste'}
        </div>
        <div className="text-muted-foreground">
          Fecha: {fmtShortDate(summary.next_adjustment_date)} · dólar de
          referencia actual: {config.reference_usd}
        </div>

        {isSuper && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-xs text-muted-foreground">
              Dólar BNA vendedor
              <input
                type="number"
                value={usdInput}
                onChange={(e) => setUsdInput(e.target.value)}
                placeholder={String(config.current_usd)}
                className="mt-1 h-9 w-32 rounded-md border border-border bg-background px-2 text-sm tabular-nums"
              />
            </label>
            <button
              type="button"
              onClick={onApply}
              disabled={applyAdjustment.isPending}
              className="h-9 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-60"
            >
              Aplicar ajuste
            </button>
          </div>
        )}
      </div>

      {/* Superadmin config editor */}
      {isSuper && (
        <ConfigEditor
          // Remount after any save/adjust so stale form state (e.g. the old
          // next_adjustment_date) is never re-sent on "Guardar".
          key={config.updated_at}
          config={config}
          onSave={async (patch) => {
            try {
              await updateConfig.mutateAsync(patch);
              toast.success('Configuración guardada');
            } catch {
              toast.error('No se pudo guardar');
            }
          }}
          saving={updateConfig.isPending}
        />
      )}

      {isSuper && feeLog && feeLog.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="mb-3 text-sm font-semibold">
            Cambios de cuota recientes
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-1">Alumno</th>
                  <th className="py-1 text-right">De</th>
                  <th className="py-1 text-right">A</th>
                  <th className="py-1 text-right">Cuándo</th>
                </tr>
              </thead>
              <tbody>
                {feeLog.map((f) => (
                  <tr key={f.id} className="border-t border-border">
                    <td className="py-1.5">
                      {f.athlete_name ?? f.athlete_id.slice(0, 8)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {fmtARS(f.from_ars)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {fmtARS(f.to_ars)}
                    </td>
                    <td className="py-1.5 text-right text-muted-foreground">
                      {fmtShortDate(f.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* History */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold">Historial mensual</div>
          {history && history.length >= 2 && (
            <Sparkline
              data={[...history].reverse().map((h) => h.total_ars)}
              className="text-brand"
            />
          )}
        </div>
        {!history || history.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            Todavía no hay meses cerrados.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-1">Mes</th>
                  <th className="py-1 text-right">Atletas</th>
                  <th className="py-1 text-right">Fee base</th>
                  <th className="py-1 text-right">4%</th>
                  <th className="py-1 text-right">Comunidad</th>
                  <th className="py-1 text-right">Total</th>
                  <th className="py-1 text-right">Estado</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.period} className="border-t border-border">
                    <td className="py-1.5">{monthYearLabel(h.period)}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {h.active_athletes}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {fmtARS(h.base_fee_ars)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {fmtARS(h.revenue_share_ars)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {fmtARS(
                        (h.community_fee_ars ?? 0) + (h.ad_share_ars ?? 0)
                      )}
                    </td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">
                      {fmtARS(h.total_ars)}
                    </td>
                    <td className="py-1.5 text-right">
                      {h.paid_at ? (
                        <span
                          title={`Registrado el ${fmtShortDate(h.paid_at)}`}
                          className="inline-flex rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400"
                        >
                          Pagado
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Pendiente
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** YYYY-MM-DD -> DD/MM/YYYY, matching the coach's own spreadsheet format. */
function ddmmyyyy(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function billingPool(row: {
  billed_ars: number;
  in_real: boolean;
}): 'Real' | 'Prepago' | 'Solo estimado' {
  if (row.billed_ars > 0) return 'Real';
  if (row.in_real) return 'Prepago';
  return 'Solo estimado';
}

function exportBreakdownCsv(
  rows: {
    name: string;
    fee_ars: number;
    billed_ars: number;
    membership_status: string;
    paid_until: string;
    in_real: boolean;
  }[]
) {
  const header = 'Nombre,Estado,Vencimiento,Precio,Facturado,Pool\n';
  const lines = rows
    .map((r) =>
      [
        csvEscape(r.name),
        r.membership_status,
        r.paid_until === 'infinity'
          ? 'Sin vencimiento'
          : ddmmyyyy(r.paid_until),
        r.fee_ars,
        r.billed_ars,
        billingPool(r),
      ].join(',')
    )
    .join('\n');
  const blob = new Blob([header + lines], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `alumnos-facturacion-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** "marzo 2026" from YYYY-MM-DD (day 15 avoids TZ off-by-one on period dates). */
function monthYearLabel(isoDate: string): string {
  const [y, m] = isoDate.slice(0, 10).split('-').map(Number);
  if (!y || !m) return isoDate;
  const d = new Date(y, m - 1, 15);
  return d.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
}

/** Next calendar month label after a due date in the current invoice month. */
function nextMonthLabel(dueDateISO: string): string {
  const [y, m] = dueDateISO.slice(0, 10).split('-').map(Number);
  if (!y || !m) return dueDateISO;
  const d = new Date(y, m, 15); // m is 1-based → Date month index m = next month
  return d.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
}

function ConfigEditor({
  config,
  onSave,
  saving,
}: {
  config: PlatformFeeConfig;
  onSave: (patch: Partial<PlatformFeeConfig>) => void;
  saving: boolean;
}) {
  const [price, setPrice] = useState(String(config.price_per_athlete_ars));
  const [pct, setPct] = useState(String(config.revenue_share_pct));
  const [base, setBase] = useState(String(config.base_fee_ars));
  const [interval, setInterval] = useState(
    String(config.adjustment_interval_months)
  );
  const [nextDate, setNextDate] = useState(config.next_adjustment_date);
  const [phase, setPhase] = useState<BillingPhase>(config.phase);
  const [communityFee, setCommunityFee] = useState(
    String(config.community_fee_ars)
  );
  const [fallbackFee, setFallbackFee] = useState(
    String(config.community_fallback_fee_ars)
  );
  const [threshold, setThreshold] = useState(
    String(config.community_revision_threshold_ars)
  );
  const [adPct, setAdPct] = useState(String(config.ad_share_pct));
  const [launched, setLaunched] = useState(config.community_launched_on ?? '');

  const field =
    'mt-1 h-9 rounded-md border border-border bg-background px-2 text-sm tabular-nums';

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="mb-3 text-sm font-semibold">
        Configuración (superadmin)
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col text-xs text-muted-foreground">
          Fee base (ARS)
          <input
            type="number"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            className={field}
          />
        </label>
        <label className="flex flex-col text-xs text-muted-foreground">
          Precio por atleta (ARS)
          <input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className={field}
          />
        </label>
        <label className="flex flex-col text-xs text-muted-foreground">
          % sobre facturación
          <input
            type="number"
            value={pct}
            onChange={(e) => setPct(e.target.value)}
            className={field}
          />
        </label>
        <label className="flex flex-col text-xs text-muted-foreground">
          Intervalo de ajuste (meses)
          <input
            type="number"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            className={field}
          />
        </label>
        <label className="flex flex-col text-xs text-muted-foreground">
          Próximo ajuste (YYYY-MM-DD)
          <input
            type="date"
            value={nextDate}
            onChange={(e) => setNextDate(e.target.value)}
            className={field}
          />
        </label>
        <label className="flex flex-col text-xs text-muted-foreground">
          Fase de cobro
          <select
            value={phase}
            onChange={(e) => setPhase(e.target.value as BillingPhase)}
            className={field}
          >
            <option value="testflight">TestFlight (50%, sin 4%)</option>
            <option value="production">Producción (100% + 4%)</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-muted-foreground">
          Comunidad: fee fijo (ARS)
          <input
            type="number"
            value={communityFee}
            onChange={(e) => setCommunityFee(e.target.value)}
            className={field}
          />
        </label>
        <label className="flex flex-col text-xs text-muted-foreground">
          Comunidad: fee si no llega al umbral (ARS)
          <input
            type="number"
            value={fallbackFee}
            onChange={(e) => setFallbackFee(e.target.value)}
            className={field}
          />
        </label>
        <label className="flex flex-col text-xs text-muted-foreground">
          Comunidad: umbral de publicidad (ARS)
          <input
            type="number"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            className={field}
          />
        </label>
        <label className="flex flex-col text-xs text-muted-foreground">
          % sobre publicidad
          <input
            type="number"
            value={adPct}
            onChange={(e) => setAdPct(e.target.value)}
            className={field}
          />
        </label>
        <div className="flex flex-col text-xs text-muted-foreground sm:col-span-2">
          <label className="flex flex-col">
            Lanzamiento de Comunidad
            <input
              type="date"
              value={launched}
              onChange={(e) => setLaunched(e.target.value)}
              className={field}
            />
          </label>
          <span className="mt-1">
            Vacío = apagado. Al cargar la fecha, los alumnos ven la Comunidad y
            empieza a cobrarse el fee. Los 6 meses de revisión cuentan desde
            acá.
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={() =>
          onSave({
            base_fee_ars: Number(base),
            price_per_athlete_ars: Number(price),
            revenue_share_pct: Number(pct),
            adjustment_interval_months: Number(interval),
            next_adjustment_date: nextDate,
            phase,
            community_fee_ars: Number(communityFee),
            community_fallback_fee_ars: Number(fallbackFee),
            community_revision_threshold_ars: Number(threshold),
            ad_share_pct: Number(adPct),
            community_launched_on: launched || null,
          })
        }
        disabled={saving}
        className="mt-4 h-9 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-60"
      >
        Guardar
      </button>
    </div>
  );
}

function CommunityRevisionCard({
  summary,
  config,
}: {
  summary: CommunitySummary;
  config: PlatformFeeConfig;
}) {
  const reaches = summary.avg_ad_revenue >= summary.threshold_ars;
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="mb-2 text-sm font-semibold">Revisión de Comunidad</div>
      {summary.revision_applied_at ? (
        <p className="text-sm">
          Revisión aplicada el {fmtShortDate(summary.revision_applied_at)}. Fee
          fijo de Comunidad: {fmtARS(summary.community_fee_ars)}.
        </p>
      ) : (
        <dl className="grid gap-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Fecha de revisión</dt>
            <dd className="tabular-nums">
              {summary.revision_date ? ddmmyyyy(summary.revision_date) : '—'} ·
              faltan {summary.days_to_revision} días
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">
              Promedio de publicidad hasta hoy
            </dt>
            <dd className="flex items-center gap-2 tabular-nums">
              <span
                aria-hidden
                className={
                  'size-2 rounded-full ' +
                  (reaches ? 'bg-emerald-500' : 'bg-amber-500')
                }
              />
              {fmtARS(summary.avg_ad_revenue)} (umbral{' '}
              {fmtARS(summary.threshold_ars)})
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Fee proyectado</dt>
            <dd className="font-semibold tabular-nums">
              {fmtARS(summary.projected_community_fee)}
            </dd>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Si el promedio mensual de publicidad de los primeros 6 meses es
            menor al umbral, el fee fijo pasa de{' '}
            {fmtARS(config.community_fee_ars)} a{' '}
            {fmtARS(config.community_fallback_fee_ars)}. El{' '}
            {config.ad_share_pct}% sobre publicidad se mantiene.
          </p>
        </dl>
      )}
    </div>
  );
}
