import { execSync } from 'child_process';
import pool from '../../../src/db/connect.js';

export async function resetDatabase(): Promise<void> {
  // Routes fire notifyUser without awaiting it. Truncating while one of those
  // is still in flight lets its late writes (e.g. deleting an invalid push
  // token) hit the *next* test's rows. Drain them first. Optional-called
  // because suites that mock notification.service supply only notifyUser.
  const notifications =
    await import('../../../src/services/notification.service.js');
  await notifications.pendingNotifications?.();

  await pool.query(`
    TRUNCATE TABLE
      payments,
      memberships,
      subscriptions,
      skeleton_regen_jobs,
      skeleton_regen_log,
      notification_log,
      push_tokens,
      progression_runs,
      rm_tests,
      athlete_exercise_weights,
      athlete_measurements,
      athlete_program_state,
      skeleton_slots,
      athlete_skeletons,
      coach_profiles,
      athlete_profiles,
      users,
      community_ads
    RESTART IDENTITY CASCADE;
  `);
  // Platform fee tables: clear history and restore the seeded single-row config
  // so each test starts from the migration defaults (config is never truncated
  // away — getConfig() requires the id=1 row to exist).
  await pool.query(
    `TRUNCATE TABLE platform_fee_payments, platform_fee_history RESTART IDENTITY`
  );
  await pool.query(`
    INSERT INTO platform_fee_config
      (id, base_fee_ars, reference_usd, current_usd, price_per_athlete_ars,
       revenue_share_pct, adjustment_interval_months, next_adjustment_date, phase,
       community_fee_ars, community_fallback_fee_ars, community_revision_threshold_ars,
       ad_share_pct, community_launched_on, community_revision_applied_at)
    VALUES (1, 105000, 1420, 1500, 25000, 4, 3, '2026-10-01', 'production',
            30000, 40000, 50000, 15, NULL, NULL)
    ON CONFLICT (id) DO UPDATE SET
      base_fee_ars = EXCLUDED.base_fee_ars,
      reference_usd = EXCLUDED.reference_usd,
      current_usd = EXCLUDED.current_usd,
      price_per_athlete_ars = EXCLUDED.price_per_athlete_ars,
      revenue_share_pct = EXCLUDED.revenue_share_pct,
      adjustment_interval_months = EXCLUDED.adjustment_interval_months,
      next_adjustment_date = EXCLUDED.next_adjustment_date,
      phase = EXCLUDED.phase,
      community_fee_ars = EXCLUDED.community_fee_ars,
      community_fallback_fee_ars = EXCLUDED.community_fallback_fee_ars,
      community_revision_threshold_ars = EXCLUDED.community_revision_threshold_ars,
      ad_share_pct = EXCLUDED.ad_share_pct,
      community_launched_on = NULL,
      community_revision_applied_at = NULL,
      updated_at = now();
  `);
  // The exercises catalog is seeded, not truncated, so a suite that hand-picks
  // alternatives_ids (admin CRUD, alternatives tests) leaks them into every
  // later suite — and curated ids now decide the whole alternatives list.
  // Restore the seeded default.
  await pool.query(
    `UPDATE exercises SET alternatives_ids = '{}' WHERE alternatives_ids <> '{}'`
  );
}

export async function ensureMigrated(): Promise<void> {
  // Always pass the live DATABASE_URL to children so they target the test DB
  // (jest.setup.ts maps TEST_DATABASE_URL -> DATABASE_URL in-process; without
  // an explicit env, children may otherwise resolve a .env-provided URL).
  const childEnv = { ...process.env, DATABASE_URL: process.env.DATABASE_URL };

  // Idempotent: if migrations table not present or rows missing, run them.
  const r = await pool.query(
    `SELECT to_regclass('public.exercises') AS e,
            to_regclass('public.periodization_config') AS p,
            to_regclass('public.platform_fee_config') AS f,
            to_regclass('public.platform_fee_payments') AS fp,
            to_regclass('public.community_ads') AS ca,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'users'
                 AND column_name = 'monthly_fee_ars'
            ) AS uf,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'athlete_exercise_weights'
                 AND column_name = 'scheme'
            ) AS aew_scheme,
            EXISTS (
              SELECT 1 FROM pg_constraint
               WHERE conname = 'notification_log_type_check'
                 AND pg_get_constraintdef(oid) LIKE '%community_revision%'
            ) AS m065,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'payments'
                 AND column_name = 'kind'
            ) AS pay_kind,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'users'
                 AND column_name = 'community_shadow'
            ) AS community_shadow,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'exercises'
                 AND column_name = 'default_series'
            ) AS exercise_default_series,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'payments'
                 AND column_name = 'period_months'
            ) AS pay_period_months`
  );
  if (
    !r.rows[0].e ||
    !r.rows[0].p ||
    !r.rows[0].f ||
    !r.rows[0].fp ||
    !r.rows[0].ca ||
    !r.rows[0].uf ||
    !r.rows[0].aew_scheme ||
    !r.rows[0].m065 ||
    !r.rows[0].pay_kind ||
    !r.rows[0].community_shadow ||
    !r.rows[0].exercise_default_series ||
    !r.rows[0].pay_period_months
  ) {
    execSync('npm run db:migrate', { stdio: 'inherit', env: childEnv });
  }
  // Ensure seed data
  const ec = await pool.query(`SELECT count(*)::int AS n FROM exercises`);
  if (ec.rows[0].n === 0) {
    execSync(
      `npx tsx src/seeds/enrich-exercises.ts && psql $DATABASE_URL -f src/seeds/exercises.sql`,
      { stdio: 'inherit', env: childEnv }
    );
  }
  const pc = await pool.query(
    `SELECT count(*)::int AS n FROM periodization_config`
  );
  if (pc.rows[0].n === 0) {
    execSync(
      `npx tsx src/seeds/port-periodization.ts && psql $DATABASE_URL -f src/seeds/periodization_config.sql`,
      { stdio: 'inherit', env: childEnv }
    );
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
