import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type BillingPhase = 'testflight' | 'production';

export interface PlatformFeeSummary {
  base_fee_ars: number;
  /** Athletes in previous-month real pool (drives the 4%). */
  active_athletes: number;
  /** Previous-month real gross (4% applied on this). */
  gross_revenue_ars: number;
  /** Current-month estimated gross (next invoice's 4% preview). */
  gross_estimated_ars: number;
  estimated_athletes: number;
  /** Current-month real gross (next invoice's 4% preview). */
  current_real_ars: number;
  current_real_athletes: number;
  /** Coverage this month (includes prepaid leftover). */
  covered_ars: number;
  covered_athletes: number;
  /** covered / estimated × 100. */
  collection_pct: number;
  revenue_share_pct: number;
  revenue_share_ars: number;
  total_ars: number;
  /** YYYY-MM-01 — invoice month (paid this month by the 10th). */
  invoice_period: string;
  /** YYYY-MM-01 — closed month whose real drives the 4%. */
  revenue_period: string;
  /** YYYY-MM-10 payment deadline within the invoice month. */
  due_date: string;
  overdue: boolean;
  next_adjustment_date: string;
  adjustment_due: boolean;
  phase: BillingPhase;
  community_fee_ars: number;
  /** Ad revenue of the closed month (revenue_period) the ad share applies on. */
  ad_revenue_ars: number;
  ad_share_pct: number;
  ad_share_ars: number;
}

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

export interface PlatformFeeHistoryRow {
  period: string;
  base_fee_ars: number;
  active_athletes: number;
  price_per_athlete_ars: number;
  gross_revenue_ars: number;
  revenue_share_pct: number;
  revenue_share_ars: number;
  total_ars: number;
  usd_at_snapshot: number;
  created_at: string;
  paid_total_ars: number | null;
  paid_at: string | null;
  community_fee_ars: number;
  ad_revenue_ars: number;
  ad_share_ars: number;
}

export interface PlatformFeePayment {
  period: string;
  total_ars: number;
  paid_at: string;
  recorded_by: string | null;
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

export interface AthleteBillingRow {
  athlete_id: string;
  name: string;
  fee_ars: number;
  billed_ars: number;
  membership_status: string;
  paid_until: string;
  in_real: boolean;
}

export function useAthleteBillingBreakdown() {
  return useQuery({
    queryKey: ['platform-fee', 'breakdown'],
    queryFn: async () => {
      const r = await api.get<AthleteBillingRow[]>('/platform-fee/breakdown');
      return r.data;
    },
  });
}

export function useFeeLog() {
  return useQuery({
    queryKey: ['platform-fee', 'fee-log'],
    queryFn: async () => {
      const r = await api.get<FeeLogRow[]>('/platform-fee/fee-log');
      return r.data;
    },
  });
}

export function usePlatformFee() {
  return useQuery({
    queryKey: ['platform-fee'],
    queryFn: async () => {
      const r = await api.get<{
        summary: PlatformFeeSummary;
        config: PlatformFeeConfig;
        payment: PlatformFeePayment | null;
      }>('/platform-fee');
      return r.data;
    },
    refetchInterval: 60_000,
  });
}

export function useMarkPlatformFeePaid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const r = await api.post<PlatformFeePayment>('/platform-fee/payments');
      return r.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-fee'] }),
  });
}

export function usePlatformFeeHistory() {
  return useQuery({
    queryKey: ['platform-fee', 'history'],
    queryFn: async () => {
      const r = await api.get<PlatformFeeHistoryRow[]>('/platform-fee/history');
      return r.data;
    },
  });
}

export function useUpdatePlatformFeeConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<PlatformFeeConfig>) => {
      const r = await api.put<PlatformFeeConfig>('/platform-fee/config', patch);
      return r.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-fee'] }),
  });
}

export function useApplyAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (current_usd: number) => {
      const r = await api.post<{
        config: PlatformFeeConfig;
        applied: { new_base_fee_ars: number };
      }>('/platform-fee/adjust', { current_usd });
      return r.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-fee'] }),
  });
}
