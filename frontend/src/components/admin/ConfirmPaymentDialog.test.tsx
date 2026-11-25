import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AdminUser } from '@/types/api';
import { ConfirmPaymentDialog, nextExpiry } from './ConfirmPaymentDialog';

const athlete: AdminUser = {
  id: 'a1',
  email: 'alumno@test.local',
  role: 'athlete',
  status: 'approved',
  email_verified: true,
  email_verified_at: '2026-01-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
  name: 'Alumno Test',
  phone: null,
  subscription_tier: null,
  subscription_status: null,
  current_period_end: null,
  monthly_fee_ars: 25000,
  membership_status: 'expired',
  paid_until: '2026-11-01T15:00:00.000Z',
  last_session_at: null,
  days_per_week: null,
  days_specific: null,
  injuries: null,
  profile: null,
};

describe('nextExpiry', () => {
  it('advances three calendar months for a quarterly period', () => {
    const next = nextExpiry('2027-01-06T15:00:00.000Z', 3);
    expect(next.getUTCFullYear()).toBe(2027);
    expect(next.getUTCMonth()).toBe(3);
    expect(next.getUTCDate()).toBe(6);
  });
});

describe('ConfirmPaymentDialog', () => {
  it('defaults to monthly and confirms the monthly amount', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmPaymentDialog
        open
        user={athlete}
        amount={25000}
        pending={false}
        onClose={() => {}}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByRole('tab', { name: 'Mensual' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByLabelText('Monto a registrar')).toHaveValue(25000);

    await user.click(screen.getByRole('button', { name: 'Confirmar pago' }));
    expect(onConfirm).toHaveBeenCalledWith({
      amount: 25000,
      period_months: 1,
    });
  });

  it('trimestral prefills 3× cuota and confirms the lump sum', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmPaymentDialog
        open
        user={athlete}
        amount={25000}
        pending={false}
        onClose={() => {}}
        onConfirm={onConfirm}
      />
    );

    await user.click(screen.getByRole('tab', { name: 'Trimestral' }));
    expect(screen.getByLabelText('Monto a registrar')).toHaveValue(75000);

    await user.click(screen.getByRole('button', { name: 'Confirmar pago' }));
    expect(onConfirm).toHaveBeenCalledWith({
      amount: 75000,
      period_months: 3,
    });
  });
});
