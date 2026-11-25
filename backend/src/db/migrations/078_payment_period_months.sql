-- Prepaid membership periods (quarterly / semiannual / annual). A single
-- payment row covers N calendar months; the 4% platform fee books the lump
-- sum in the payment month and skips leftover prepaid months.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS period_months INTEGER NOT NULL DEFAULT 1;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_period_months_check;
ALTER TABLE payments ADD CONSTRAINT payments_period_months_check
  CHECK (period_months IN (1, 3, 6, 12));
