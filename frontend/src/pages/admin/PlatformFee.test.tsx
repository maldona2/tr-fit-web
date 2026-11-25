import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlatformFee from './PlatformFee';

const mocks = vi.hoisted(() => ({
  role: 'superadmin' as 'admin' | 'superadmin',
  payment: null as null | {
    period: string;
    total_ars: number;
    paid_at: string;
    recorded_by: string | null;
  },
  history: [] as Array<Record<string, string | number | null>>,
  breakdown: [] as Array<Record<string, string | number | boolean>>,
  markPaid: vi.fn(),
  communityFee: 30000,
  communityEnabled: true,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'su-1', role: mocks.role } }),
}));

vi.mock('@/hooks/usePlatformFee', () => ({
  usePlatformFee: () => ({
    isLoading: false,
    data: {
      summary: {
        base_fee_ars: 52500,
        active_athletes: 10,
        gross_revenue_ars: 250000,
        gross_estimated_ars: 329000,
        estimated_athletes: 13,
        current_real_ars: 250000,
        current_real_athletes: 10,
        covered_ars: 250000,
        covered_athletes: 10,
        collection_pct: 76,
        revenue_share_pct: 0,
        revenue_share_ars: 0,
        total_ars: 52500,
        invoice_period: '2026-07-01',
        revenue_period: '2026-06-01',
        due_date: '2026-07-10',
        overdue: false,
        next_adjustment_date: '2026-10-01',
        adjustment_due: false,
        phase: 'testflight',
        community_fee_ars: mocks.communityFee,
        ad_revenue_ars: 100000,
        ad_share_pct: 15,
        ad_share_ars: 15000,
      },
      config: {
        base_fee_ars: 105000,
        reference_usd: 1420,
        current_usd: 1500,
        price_per_athlete_ars: 25000,
        revenue_share_pct: 0,
        adjustment_interval_months: 3,
        next_adjustment_date: '2026-10-01',
        phase: 'testflight',
        updated_at: '2026-07-01T00:00:00.000Z',
        community_fee_ars: 30000,
        community_fallback_fee_ars: 40000,
        community_revision_threshold_ars: 50000,
        ad_share_pct: 15,
        community_launched_on: '2026-10-01',
        community_revision_applied_at: null,
      },
      payment: mocks.payment,
    },
  }),
  usePlatformFeeHistory: () => ({ data: mocks.history }),
  useUpdatePlatformFeeConfig: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useApplyAdjustment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useFeeLog: () => ({ data: [] }),
  useAthleteBillingBreakdown: () => ({ data: mocks.breakdown }),
  useMarkPlatformFeePaid: () => ({
    mutateAsync: mocks.markPaid,
    isPending: false,
  }),
}));

vi.mock('@/hooks/useCommunity', () => ({
  useCommunitySummary: () => ({
    data: {
      enabled: mocks.communityEnabled,
      launched_on: '2026-10-01',
      revision_date: '2027-04-01',
      days_to_revision: 120,
      ad_revenue_this_month: 100000,
      ad_share_this_month: 15000,
      avg_ad_revenue: 42000,
      projected_community_fee: 40000,
      revision_applied_at: null,
      community_fee_ars: 30000,
      threshold_ars: 50000,
    },
  }),
}));

describe('platform fee community', () => {
  beforeEach(() => {
    mocks.role = 'superadmin';
    mocks.payment = null;
    mocks.history = [];
    mocks.breakdown = [];
    mocks.communityFee = 30000;
    mocks.communityEnabled = true;
  });

  it('shows the community breakdown rows', () => {
    render(<PlatformFee />);
    expect(screen.getByText('Comunidad (fijo)')).toBeInTheDocument();
    expect(screen.getByText(/15% sobre publicidad de/)).toBeInTheDocument();
  });

  it('hides community rows when the module is off', () => {
    mocks.communityFee = 0;
    mocks.communityEnabled = false;
    render(<PlatformFee />);
    expect(screen.queryByText('Comunidad (fijo)')).not.toBeInTheDocument();
    expect(screen.queryByText('Revisión de Comunidad')).not.toBeInTheDocument();
  });

  it('shows the revision card with the projection', () => {
    render(<PlatformFee />);
    expect(screen.getByText('Revisión de Comunidad')).toBeInTheDocument();
    expect(screen.getByText(/faltan 120 días/)).toBeInTheDocument();
    expect(screen.getByText('Fee proyectado')).toBeInTheDocument();
  });
});

describe('platform fee payment status', () => {
  beforeEach(() => {
    mocks.role = 'superadmin';
    mocks.payment = null;
    mocks.history = [];
    mocks.breakdown = [];
    mocks.markPaid.mockReset();
  });

  it('shows invoice for current month due on the 10th', () => {
    render(<PlatformFee />);

    // invoice_period July, due 10 July; 4% from June real
    expect(screen.getByText(/Vence el 10 de/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Pagá en .+ hasta el día 10 inclusive/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/Facturación real en curso/i)).toBeInTheDocument();
    expect(screen.getAllByText(/No se pierde nada/i).length).toBeGreaterThan(0);
    expect(screen.getByText('cobrado vs estimado')).toBeInTheDocument();
  });

  it('shows the recorded payment for the invoice', () => {
    mocks.payment = {
      period: '2026-06-01',
      total_ars: 52500,
      paid_at: '2026-07-08T15:30:00.000Z',
      recorded_by: 'su-1',
    };

    render(<PlatformFee />);

    expect(screen.getByText('Factura pagada')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Marcar como pagado' })
    ).not.toBeInTheDocument();
  });

  it('lets a superadmin mark the invoice as paid', () => {
    render(<PlatformFee />);

    expect(
      screen.getByText(/Pago pendiente · hasta el 10/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Marcar como pagado' })
    ).toBeInTheDocument();
  });

  it('records the payment after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.markPaid.mockResolvedValue({});
    render(<PlatformFee />);

    fireEvent.click(screen.getByRole('button', { name: 'Marcar como pagado' }));

    await waitFor(() => expect(mocks.markPaid).toHaveBeenCalledOnce());
    confirm.mockRestore();
  });

  it('shows an admin the pending status without the payment action', () => {
    mocks.role = 'admin';

    render(<PlatformFee />);

    expect(
      screen.getByText(/Pago pendiente · hasta el 10/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Marcar como pagado' })
    ).not.toBeInTheDocument();
  });

  it('shows the payment status in monthly history', () => {
    mocks.history = [
      {
        period: '2026-06-01',
        base_fee_ars: 52500,
        active_athletes: 12,
        price_per_athlete_ars: 25000,
        gross_revenue_ars: 300000,
        revenue_share_pct: 0,
        revenue_share_ars: 0,
        total_ars: 52500,
        usd_at_snapshot: 1420,
        created_at: '2026-07-01T00:00:00.000Z',
        paid_total_ars: 52500,
        paid_at: '2026-06-14T15:30:00.000Z',
      },
    ];

    render(<PlatformFee />);

    expect(screen.getAllByText('Pagado').length).toBeGreaterThanOrEqual(1);
  });
});
