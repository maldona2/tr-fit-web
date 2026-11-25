// backend/src/services/platform-fee.service.ts
import pool from '../db/connect.js';
import {
  computeFee,
  computeAdjustedBase,
  addMonthsISO,
  isAdjustmentDue,
  previousMonthPeriod,
  currentMonthPeriod,
  paymentDueDate,
  isPaymentOverdue,
  communityRevisionDate,
  evaluateCommunityRevision,
} from './platform-fee.math.js';
import { adRevenueForMonth } from './community-ads.service.js';
import { notifyUser } from './notification.service.js';
import { sendCommunityRevisionEmail } from './email.service.js';
import logger from '../utils/logger.js';

export type BillingPhase = 'testflight' | 'production';

export interface PlatformFeeConfig {
  base_fee_ars: number;
  reference_usd: number;
  current_usd: number;
  price_per_athlete_ars: number;
  revenue_share_pct: number;
  adjustment_interval_months: number;
  next_adjustment_date: string;
  phase: BillingPhase;
  updated_at: string;
  community_fee_ars: number;
  community_fallback_fee_ars: number;
  community_revision_threshold_ars: number;
  ad_share_pct: number;
  community_launched_on: string | null;
  community_revision_applied_at: string | null;
}

/**
 * Invoice for calendar month M (paid during M, due on the 10th of M):
 *   total = current base fee + 4% of previous month (M-1) full real.
 * M-1 is closed so no athlete collections are lost. Current-month (M)
 * collections build the 4% for next month's invoice (due on the 10th of M+1).
 */
export interface PlatformFeeSummary {
  base_fee_ars: number;
  /** Athletes in the previous month's real pool (drives the 4%). */
  active_athletes: number;
  /** Previous month real gross (4% is applied on this). */
  gross_revenue_ars: number;
  /** Current month expected gross (next invoice's 4% preview). */
  gross_estimated_ars: number;
  estimated_athletes: number;
  /** Current month real gross (next invoice's 4% preview). */
  current_real_ars: number;
  current_real_athletes: number;
  /** Coverage this month (paid_until), including prepaid leftover. */
  covered_ars: number;
  covered_athletes: number;
  /** covered / estimated × 100 (al día, not the 4% base). */
  collection_pct: number;
  revenue_share_pct: number;
  revenue_share_ars: number;
  community_fee_ars: number;
  ad_revenue_ars: number;
  ad_share_pct: number;
  ad_share_ars: number;
  total_ars: number;
  /** YYYY-MM-01 — invoice / payment month (e.g. August paid in August). */
  invoice_period: string;
  /** YYYY-MM-01 — closed month whose real drives the 4%. */
  revenue_period: string;
  /** YYYY-MM-10 — coach must pay by this date (within invoice month). */
  due_date: string;
  overdue: boolean;
  next_adjustment_date: string;
  adjustment_due: boolean;
  phase: BillingPhase;
}

export interface PlatformFeeHistoryRow {
  period: string;
  base_fee_ars: number;
  active_athletes: number;
  price_per_athlete_ars: number;
  gross_revenue_ars: number;
  revenue_share_pct: number;
  revenue_share_ars: number;
  community_fee_ars: number;
  ad_revenue_ars: number;
  ad_share_ars: number;
  total_ars: number;
  usd_at_snapshot: number;
  created_at: string;
  paid_total_ars: number | null;
  paid_at: string | null;
}

export interface PlatformFeePayment {
  period: string;
  total_ars: number;
  paid_at: string;
  recorded_by: string | null;
}

export interface UpdateConfigInput {
  base_fee_ars?: number;
  reference_usd?: number;
  current_usd?: number;
  price_per_athlete_ars?: number;
  revenue_share_pct?: number;
  adjustment_interval_months?: number;
  next_adjustment_date?: string;
  phase?: BillingPhase;
  community_fee_ars?: number;
  community_fallback_fee_ars?: number;
  community_revision_threshold_ars?: number;
  ad_share_pct?: number;
  community_launched_on?: string | null;
}

interface ConfigRow {
  base_fee_ars: string;
  reference_usd: string;
  current_usd: string;
  price_per_athlete_ars: string;
  revenue_share_pct: string;
  adjustment_interval_months: number;
  next_adjustment_date: Date | string;
  phase: BillingPhase;
  updated_at: Date | string;
  community_fee_ars: string;
  community_fallback_fee_ars: string;
  community_revision_threshold_ars: string;
  ad_share_pct: string;
  community_launched_on: Date | string | null;
  community_revision_applied_at: Date | string | null;
}

const toISODate = (d: Date | string): string =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

/** Period key for the invoice being paid (current calendar month). */
function invoicePeriodFor(todayISO?: string): string {
  return currentMonthPeriod(billingTodayISO(todayISO));
}

function mapConfig(r: ConfigRow): PlatformFeeConfig {
  return {
    base_fee_ars: Number(r.base_fee_ars),
    reference_usd: Number(r.reference_usd),
    current_usd: Number(r.current_usd),
    price_per_athlete_ars: Number(r.price_per_athlete_ars),
    revenue_share_pct: Number(r.revenue_share_pct),
    adjustment_interval_months: Number(r.adjustment_interval_months),
    next_adjustment_date: toISODate(r.next_adjustment_date),
    phase: r.phase,
    updated_at: new Date(r.updated_at).toISOString(),
    community_fee_ars: Number(r.community_fee_ars),
    community_fallback_fee_ars: Number(r.community_fallback_fee_ars),
    community_revision_threshold_ars: Number(
      r.community_revision_threshold_ars
    ),
    ad_share_pct: Number(r.ad_share_pct),
    community_launched_on: r.community_launched_on
      ? toISODate(r.community_launched_on)
      : null,
    community_revision_applied_at: r.community_revision_applied_at
      ? new Date(r.community_revision_applied_at).toISOString()
      : null,
  };
}

const CONFIG_COLS = `base_fee_ars, reference_usd, current_usd, price_per_athlete_ars,
  revenue_share_pct, adjustment_interval_months, next_adjustment_date, phase, updated_at,
  community_fee_ars, community_fallback_fee_ars, community_revision_threshold_ars,
  ad_share_pct, community_launched_on::text AS community_launched_on, community_revision_applied_at`;

export async function getConfig(): Promise<PlatformFeeConfig> {
  const r = await pool.query<ConfigRow>(
    `SELECT ${CONFIG_COLS} FROM platform_fee_config WHERE id = 1`
  );
  if (!r.rows[0]) throw new Error('platform_fee_config row missing');
  return mapConfig(r.rows[0]);
}

/**
 * Calendar day used for "paid this month" (matches frontend isPaidThisMonth):
 * paid when paid_until is infinity or reaches the first instant of next month.
 * When todayISO is omitted, use America/Argentina/Buenos_Aires current date.
 */
function billingTodayISO(todayISO?: string): string {
  if (todayISO) return todayISO.slice(0, 10);
  // en-CA yields YYYY-MM-DD in the given IANA zone.
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  });
}

/** Per-athlete monthly fee. Assumes `u` = users, `ap` = athlete_profiles.
 * Shared with admin.service's dashboard KPIs so both price an athlete the same. */
export const FEE_EXPR = `COALESCE(u.monthly_fee_ars, ap.monthly_fee_ars, 25000)`;

/** Coverage for this calendar month (paid_until reaches next month, or infinity). */
const IN_REAL = `(m.paid_until = 'infinity'
            OR m.paid_until >= (date_trunc('month', $1::date) + interval '1 month'))`;

/**
 * 4% books the money actually invoiced this calendar month:
 *   - membership payments with paid_at in this month → SUM(amount)
 *     (a quarterly 75k counts as 75k once, not 25k × 3)
 *   - leftover prepaid (period_months > 1 from an earlier month that still
 *     covers this month) → 0
 *   - otherwise, if still covered (monthly / infinity / tests) → monthly fee
 *
 * Joins `ptm` (payments this month) and `pl` (prepaid leftover).
 */
const BILLED_EXPR = `CASE
         WHEN ptm.amount IS NOT NULL THEN ptm.amount
         WHEN pl.leftover THEN 0
         WHEN ${IN_REAL} THEN ${FEE_EXPR}
         ELSE 0
       END`;

const IN_BILLED_POOL = `(ptm.amount IS NOT NULL OR ((${IN_REAL}) AND pl.leftover IS NULL))`;

/** FROM/JOIN for estimated athletes + this-month payments + leftover prepaid. */
const BILLING_FROM = `
       FROM users u
       LEFT JOIN athlete_profiles ap ON ap.user_id = u.id
       JOIN memberships m ON m.user_id = u.id
       LEFT JOIN LATERAL (
         SELECT SUM(p.amount) AS amount
           FROM payments p
          WHERE p.user_id = u.id
            AND p.kind = 'membership'
            AND p.paid_at >= date_trunc('month', $1::date)::date
            AND p.paid_at < (date_trunc('month', $1::date) + interval '1 month')::date
       ) ptm ON true
       LEFT JOIN LATERAL (
         SELECT true AS leftover
           FROM payments p
          WHERE p.user_id = u.id
            AND p.kind = 'membership'
            AND p.period_months > 1
            AND p.paid_at < date_trunc('month', $1::date)::date
            AND p.covers_until >= (date_trunc('month', $1::date) + interval '1 month')
          LIMIT 1
       ) pl ON true
      WHERE u.role = 'athlete'
        AND u.status = 'approved'
        AND m.status NOT IN ('cancelled', 'paused', 'vacation')`;

/**
 * Estimated pool: approved athletes with a membership that is still on the
 * books (not cancelled/paused/vacation) — includes expired and mid-month actives who
 * have not renewed yet.
 *
 * Real / 4% pool: money invoiced this calendar month (see BILLED_EXPR). Prepaid
 * leftover months stay covered for access (in_real) but do not enter the 4%.
 */
export async function getAthleteBillingRevenue(todayISO?: string): Promise<{
  realCount: number;
  realArs: number;
  estimatedCount: number;
  estimatedArs: number;
  coveredCount: number;
  coveredArs: number;
}> {
  const today = billingTodayISO(todayISO);
  const r = await pool.query<{
    estimated_n: number;
    estimated_gross: string;
    real_n: number;
    real_gross: string;
    covered_n: number;
    covered_gross: string;
  }>(
    `SELECT
       COUNT(*)::int AS estimated_n,
       COALESCE(SUM(${FEE_EXPR}), 0) AS estimated_gross,
       COUNT(*) FILTER (WHERE ${IN_BILLED_POOL})::int AS real_n,
       COALESCE(SUM(${BILLED_EXPR}), 0) AS real_gross,
       COUNT(*) FILTER (WHERE ${IN_REAL})::int AS covered_n,
       COALESCE(SUM(${FEE_EXPR}) FILTER (WHERE ${IN_REAL}), 0) AS covered_gross
       ${BILLING_FROM}`,
    [today]
  );
  const row = r.rows[0];
  return {
    estimatedCount: Number(row?.estimated_n ?? 0),
    estimatedArs: Number(row?.estimated_gross ?? 0),
    realCount: Number(row?.real_n ?? 0),
    realArs: Number(row?.real_gross ?? 0),
    coveredCount: Number(row?.covered_n ?? 0),
    coveredArs: Number(row?.covered_gross ?? 0),
  };
}

/** @deprecated Prefer getAthleteBillingRevenue; returns real (paid this month) only. */
export async function getActiveAthleteRevenue(
  todayISO?: string
): Promise<{ count: number; grossArs: number }> {
  const rev = await getAthleteBillingRevenue(todayISO);
  return { count: rev.realCount, grossArs: rev.realArs };
}

export interface AthleteBillingRow {
  athlete_id: string;
  name: string;
  fee_ars: number;
  /** Amount that enters this month's 4% (lump sum or monthly fee; 0 if prepaid leftover). */
  billed_ars: number;
  membership_status: string;
  paid_until: string;
  in_real: boolean;
}

/** Per-athlete detail behind getAthleteBillingRevenue's Estimado/Real totals — for the coach-facing breakdown. */
export async function getAthleteBillingBreakdown(
  todayISO?: string
): Promise<AthleteBillingRow[]> {
  const today = billingTodayISO(todayISO);
  const r = await pool.query<{
    id: string;
    name: string | null;
    fee: string;
    billed: string;
    status: string;
    paid_until: Date | string;
    in_real: boolean;
  }>(
    `SELECT u.id,
            COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), ap.name) AS name,
            ${FEE_EXPR} AS fee,
            ${BILLED_EXPR} AS billed,
            m.status,
            m.paid_until,
            ${IN_REAL} AS in_real
       ${BILLING_FROM}
      ORDER BY fee DESC, name`,
    [today]
  );
  return r.rows.map((row) => ({
    athlete_id: row.id,
    name: row.name ?? '(sin nombre)',
    fee_ars: Number(row.fee),
    billed_ars: Number(row.billed),
    membership_status: row.status,
    paid_until: toISODate(row.paid_until),
    in_real: row.in_real,
  }));
}

const UPDATABLE = [
  'base_fee_ars',
  'reference_usd',
  'current_usd',
  'price_per_athlete_ars',
  'revenue_share_pct',
  'adjustment_interval_months',
  'next_adjustment_date',
  'phase',
  'community_fee_ars',
  'community_fallback_fee_ars',
  'community_revision_threshold_ars',
  'ad_share_pct',
  'community_launched_on',
] as const;

export async function updateConfig(
  input: UpdateConfigInput
): Promise<PlatformFeeConfig> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const f of UPDATABLE) {
    const v = (input as Record<string, unknown>)[f];
    if (f in input && v !== undefined) {
      vals.push(v);
      sets.push(`${f} = $${vals.length}`);
    }
  }
  if (sets.length === 0) return getConfig();
  await pool.query(
    `UPDATE platform_fee_config SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`,
    vals
  );
  return getConfig();
}

/** Community is billed for a month when it was launched on or before that month's last day. */
export function communityActiveForPeriod(
  launchedOn: string | null,
  periodISO: string
): boolean {
  if (!launchedOn) return false;
  return launchedOn.slice(0, 7) <= periodISO.slice(0, 7);
}

export interface CommunityRevisionOutcome {
  applied: boolean;
  average?: number;
  newFee?: number;
  downgraded?: boolean;
}

export async function applyCommunityRevisionIfDue(
  todayISO: string
): Promise<CommunityRevisionOutcome> {
  const cfg = await getConfig();
  if (!cfg.community_launched_on || cfg.community_revision_applied_at)
    return { applied: false };
  if (todayISO.slice(0, 10) < communityRevisionDate(cfg.community_launched_on))
    return { applied: false };

  const h = await pool.query<{ ad_revenue_ars: string }>(
    `SELECT ad_revenue_ars FROM platform_fee_history
      WHERE period >= date_trunc('month', $1::date)::date
      ORDER BY period LIMIT 6`,
    [cfg.community_launched_on]
  );
  const result = evaluateCommunityRevision({
    monthlyAdRevenues: h.rows.map((r) => Number(r.ad_revenue_ars)),
    threshold: cfg.community_revision_threshold_ars,
    fee: cfg.community_fee_ars,
    fallbackFee: cfg.community_fallback_fee_ars,
  });

  // Guarded by applied_at IS NULL so a concurrent/duplicate run can't apply twice.
  const upd = await pool.query(
    `UPDATE platform_fee_config
        SET community_fee_ars = $1, community_revision_applied_at = now(), updated_at = now()
      WHERE id = 1 AND community_revision_applied_at IS NULL`,
    [result.newFee]
  );
  if (!upd.rowCount) return { applied: false };

  const admins = await pool.query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE role IN ('admin', 'superadmin')`
  );
  for (const a of admins.rows) {
    void notifyUser(a.id, 'community_revision', {
      average: String(result.average),
      newFee: String(result.newFee),
      downgraded: String(result.downgraded),
    }).catch((e) => logger.error({ err: e }, 'community revision push failed'));
    try {
      await sendCommunityRevisionEmail({
        email: a.email,
        average: result.average,
        threshold: cfg.community_revision_threshold_ars,
        newFee: result.newFee,
        downgraded: result.downgraded,
      });
    } catch (e) {
      logger.error(
        { err: e, email: a.email },
        'community revision email failed'
      );
    }
  }
  return { applied: true, ...result };
}

/**
 * Previous month's real gross for the 4%. Prefer frozen snapshot gross so the
 * closed month never changes after the 1st; fall back to live recompute.
 * Base fee always comes from current config (invoice month's base).
 */
async function previousMonthReal(revenuePeriod: string): Promise<{
  realCount: number;
  realArs: number;
}> {
  const hist = await pool.query<{
    active_athletes: number;
    gross_revenue_ars: string;
  }>(
    `SELECT active_athletes, gross_revenue_ars
       FROM platform_fee_history
      WHERE period = $1`,
    [revenuePeriod]
  );
  if (hist.rows[0]) {
    return {
      realCount: Number(hist.rows[0].active_athletes),
      realArs: Number(hist.rows[0].gross_revenue_ars),
    };
  }
  const live = await getAthleteBillingRevenue(revenuePeriod);
  return { realCount: live.realCount, realArs: live.realArs };
}

/** Frozen ad revenue for a closed month when snapshotted, else live. */
async function previousMonthAdRevenue(periodISO: string): Promise<number> {
  const h = await pool.query<{ ad_revenue_ars: string }>(
    `SELECT ad_revenue_ars FROM platform_fee_history WHERE period = $1`,
    [periodISO]
  );
  return h.rows[0]
    ? Number(h.rows[0].ad_revenue_ars)
    : adRevenueForMonth(periodISO);
}

export async function computeCurrent(
  todayISO?: string
): Promise<PlatformFeeSummary> {
  const cfg = await getConfig();
  const today = billingTodayISO(todayISO);
  const invoicePeriod = currentMonthPeriod(today);
  const revenuePeriod = previousMonthPeriod(today);
  const due = paymentDueDate(today);

  // Invoice month M: current base + 4% of full closed month M-1 real.
  const prev = await previousMonthReal(revenuePeriod);
  const communityNow = communityActiveForPeriod(
    cfg.community_launched_on,
    invoicePeriod
  );
  const communityPrev = communityActiveForPeriod(
    cfg.community_launched_on,
    revenuePeriod
  );
  const prevAds = communityPrev
    ? await previousMonthAdRevenue(revenuePeriod)
    : 0;
  const fee = computeFee({
    baseFeeArs: cfg.base_fee_ars,
    activeAthletes: prev.realCount,
    grossRevenueArs: prev.realArs,
    revenueSharePct: cfg.revenue_share_pct,
    testflight: cfg.phase === 'testflight',
    communityFeeArs: communityNow ? cfg.community_fee_ars : 0,
    adRevenueArs: prevAds,
    adSharePct: cfg.ad_share_pct,
  });

  // Current month collections → 4% of next month's invoice (nothing lost).
  const cur = await getAthleteBillingRevenue(today);
  const collectionPct =
    cur.estimatedArs > 0
      ? Math.round((cur.coveredArs / cur.estimatedArs) * 1000) / 10
      : 0;

  const payment = await getPaymentForPeriod(invoicePeriod);

  return {
    base_fee_ars: fee.baseFeeArs,
    active_athletes: fee.activeAthletes,
    gross_revenue_ars: fee.grossRevenueArs,
    revenue_share_pct: fee.revenueSharePct,
    revenue_share_ars: fee.revenueShareArs,
    community_fee_ars: fee.communityFeeArs,
    ad_revenue_ars: fee.adRevenueArs,
    ad_share_pct: cfg.ad_share_pct,
    ad_share_ars: fee.adShareArs,
    total_ars: fee.totalArs,
    gross_estimated_ars: cur.estimatedArs,
    estimated_athletes: cur.estimatedCount,
    current_real_ars: cur.realArs,
    current_real_athletes: cur.realCount,
    covered_ars: cur.coveredArs,
    covered_athletes: cur.coveredCount,
    collection_pct: collectionPct,
    invoice_period: invoicePeriod,
    revenue_period: revenuePeriod,
    due_date: due,
    overdue: isPaymentOverdue(today, payment !== null),
    next_adjustment_date: cfg.next_adjustment_date,
    adjustment_due: isAdjustmentDue(cfg.next_adjustment_date, today),
    phase: cfg.phase,
  };
}

interface PaymentRow {
  period: Date | string;
  total_ars: string;
  paid_at: Date | string;
  recorded_by: string | null;
}

function mapPayment(row: PaymentRow): PlatformFeePayment {
  return {
    period: toISODate(row.period),
    total_ars: Number(row.total_ars),
    paid_at: new Date(row.paid_at).toISOString(),
    recorded_by: row.recorded_by,
  };
}

async function getPaymentForPeriod(
  periodISO: string
): Promise<PlatformFeePayment | null> {
  const result = await pool.query<PaymentRow>(
    `SELECT period, total_ars, paid_at, recorded_by
       FROM platform_fee_payments
      WHERE period = $1`,
    [periodISO]
  );
  return result.rows[0] ? mapPayment(result.rows[0]) : null;
}

/** Payment for the invoice of the current calendar month (due by the 10th). */
export async function getCurrentPayment(
  todayISO?: string
): Promise<PlatformFeePayment | null> {
  return getPaymentForPeriod(invoicePeriodFor(todayISO));
}

export async function recordCurrentPayment(
  recordedBy: string,
  todayISO?: string
): Promise<PlatformFeePayment | null> {
  const summary = await computeCurrent(todayISO);
  const result = await pool.query<PaymentRow>(
    `INSERT INTO platform_fee_payments (period, total_ars, recorded_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (period) DO NOTHING
     RETURNING period, total_ars, paid_at, recorded_by`,
    [summary.invoice_period, summary.total_ars, recordedBy]
  );
  return result.rows[0] ? mapPayment(result.rows[0]) : null;
}

export async function previewAdjustment(
  currentUsd: number
): Promise<{ new_base_fee_ars: number }> {
  const cfg = await getConfig();
  return {
    new_base_fee_ars: computeAdjustedBase(
      cfg.base_fee_ars,
      currentUsd,
      cfg.reference_usd
    ),
  };
}

export async function applyAdjustment(
  currentUsd: number
): Promise<PlatformFeeConfig> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query<ConfigRow>(
      `SELECT ${CONFIG_COLS} FROM platform_fee_config WHERE id = 1 FOR UPDATE`
    );
    if (!r.rows[0]) throw new Error('platform_fee_config row missing');
    const cfg = mapConfig(r.rows[0]);
    const newBase = computeAdjustedBase(
      cfg.base_fee_ars,
      currentUsd,
      cfg.reference_usd
    );
    const newCommunityFee = computeAdjustedBase(
      cfg.community_fee_ars,
      currentUsd,
      cfg.reference_usd
    );
    const newFallback = computeAdjustedBase(
      cfg.community_fallback_fee_ars,
      currentUsd,
      cfg.reference_usd
    );
    const newThreshold = computeAdjustedBase(
      cfg.community_revision_threshold_ars,
      currentUsd,
      cfg.reference_usd
    );
    const nextDate = addMonthsISO(
      cfg.next_adjustment_date,
      cfg.adjustment_interval_months
    );
    await client.query(
      `UPDATE platform_fee_config
          SET base_fee_ars = $1, reference_usd = $2, current_usd = $2,
              next_adjustment_date = $3,
              community_fee_ars = $4,
              community_fallback_fee_ars = $5,
              community_revision_threshold_ars = $6,
              updated_at = now()
        WHERE id = 1`,
      [
        newBase,
        currentUsd,
        nextDate,
        newCommunityFee,
        newFallback,
        newThreshold,
      ]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return getConfig();
}

export async function snapshotMonth(periodISO: string): Promise<void> {
  const cfg = await getConfig();
  // Snapshot the closed month using real (paid-this-month) gross, same as live fee.
  const rev = await getAthleteBillingRevenue(periodISO);
  const community = communityActiveForPeriod(
    cfg.community_launched_on,
    periodISO
  );
  const adRevenue = community ? await adRevenueForMonth(periodISO) : 0;
  const fee = computeFee({
    baseFeeArs: cfg.base_fee_ars,
    activeAthletes: rev.realCount,
    grossRevenueArs: rev.realArs,
    revenueSharePct: cfg.revenue_share_pct,
    testflight: cfg.phase === 'testflight',
    communityFeeArs: community ? cfg.community_fee_ars : 0,
    adRevenueArs: adRevenue,
    adSharePct: cfg.ad_share_pct,
  });
  await pool.query(
    `INSERT INTO platform_fee_history
       (period, base_fee_ars, active_athletes, price_per_athlete_ars,
        gross_revenue_ars, revenue_share_pct, revenue_share_ars, total_ars,
        usd_at_snapshot, community_fee_ars, ad_revenue_ars, ad_share_ars)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (period) DO NOTHING`,
    [
      periodISO,
      fee.baseFeeArs,
      fee.activeAthletes,
      cfg.price_per_athlete_ars,
      fee.grossRevenueArs,
      fee.revenueSharePct,
      fee.revenueShareArs,
      fee.totalArs,
      cfg.reference_usd,
      fee.communityFeeArs,
      fee.adRevenueArs,
      fee.adShareArs,
    ]
  );
}

interface HistoryRow {
  period: Date | string;
  base_fee_ars: string;
  active_athletes: number;
  price_per_athlete_ars: string;
  gross_revenue_ars: string;
  revenue_share_pct: string;
  revenue_share_ars: string;
  community_fee_ars: string;
  ad_revenue_ars: string;
  ad_share_ars: string;
  total_ars: string;
  usd_at_snapshot: string;
  created_at: Date | string;
  paid_total_ars: string | null;
  paid_at: Date | string | null;
}

export async function getHistory(limit = 24): Promise<PlatformFeeHistoryRow[]> {
  // Payment for invoice month M settles the 4% of history month M-1
  // (and legacy rows may still store payment on the same period).
  const r = await pool.query<HistoryRow>(
    `SELECT h.period, h.base_fee_ars, h.active_athletes,
            h.price_per_athlete_ars, h.gross_revenue_ars,
            h.revenue_share_pct, h.revenue_share_ars, h.total_ars,
            h.community_fee_ars, h.ad_revenue_ars, h.ad_share_ars,
            h.usd_at_snapshot, h.created_at,
            p.total_ars AS paid_total_ars, p.paid_at
       FROM platform_fee_history h
       LEFT JOIN LATERAL (
         SELECT total_ars, paid_at
           FROM platform_fee_payments
          WHERE period = h.period
             OR period = (h.period + interval '1 month')
          ORDER BY CASE
                     WHEN period = (h.period + interval '1 month') THEN 0
                     ELSE 1
                   END,
                   paid_at DESC
          LIMIT 1
       ) p ON true
      ORDER BY h.period DESC
      LIMIT $1`,
    [limit]
  );
  return r.rows.map((row) => ({
    period: toISODate(row.period),
    base_fee_ars: Number(row.base_fee_ars),
    active_athletes: Number(row.active_athletes),
    price_per_athlete_ars: Number(row.price_per_athlete_ars),
    gross_revenue_ars: Number(row.gross_revenue_ars),
    revenue_share_pct: Number(row.revenue_share_pct),
    revenue_share_ars: Number(row.revenue_share_ars),
    community_fee_ars: Number(row.community_fee_ars),
    ad_revenue_ars: Number(row.ad_revenue_ars),
    ad_share_ars: Number(row.ad_share_ars),
    total_ars: Number(row.total_ars),
    usd_at_snapshot: Number(row.usd_at_snapshot),
    created_at: new Date(row.created_at).toISOString(),
    paid_total_ars:
      row.paid_total_ars === null ? null : Number(row.paid_total_ars),
    paid_at: row.paid_at === null ? null : new Date(row.paid_at).toISOString(),
  }));
}

export interface FeeLogRow {
  id: string;
  athlete_id: string;
  athlete_name: string | null;
  from_ars: number;
  to_ars: number;
  actor: string;
  created_at: string;
}

export async function getFeeLog(limit = 50): Promise<FeeLogRow[]> {
  const r = await pool.query<{
    id: string;
    target_id: string;
    name: string | null;
    meta: { from?: number | string; to?: number | string } | null;
    actor: string;
    created_at: Date | string;
  }>(
    `SELECT l.id, l.target_id, l.actor, l.meta, l.created_at,
            ap.name
       FROM admin_audit_log l
       LEFT JOIN athlete_profiles ap ON ap.user_id = l.target_id
      WHERE l.type = 'athlete_fee_changed'
      ORDER BY l.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return r.rows.map((row) => ({
    id: row.id,
    athlete_id: row.target_id,
    athlete_name: row.name,
    from_ars: Number(row.meta?.from ?? 0),
    to_ars: Number(row.meta?.to ?? 0),
    actor: row.actor,
    created_at: new Date(row.created_at).toISOString(),
  }));
}
