import bcrypt from 'bcrypt';
import crypto, { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import pool from '../db/connect.js';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';
import type { AuthLoginResult } from '../domain/types.js';
import {
  generateToken,
  hashToken,
  expiresIn,
  isExpired,
  VERIFY_TOKEN_TTL_MS,
  RESET_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
} from './verification.service.js';
import { sendVerifyEmail, sendPasswordResetEmail } from './email.service.js';
import { logAudit } from './admin.service.js';
import { getStorageBucket } from '../config/firebase.js';
import { deleteUserCommunityMedia } from './community-media.service.js';

const BCRYPT_COST = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function comparePassword(
  plain: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ─── Signup ──────────────────────────────────────────────────────
export interface SignupResult {
  userId: string;
  email: string;
  emailSendFailed: boolean;
}

export interface SignupContact {
  firstName?: string;
  lastName?: string;
  phone?: string;
}

export async function signup(
  email: string,
  password: string,
  contact: SignupContact = {}
): Promise<SignupResult> {
  const exists = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [
    email,
  ]);
  if (exists.rowCount && exists.rowCount > 0) {
    const err = new Error('email_already_registered');
    (err as Error & { code?: string }).code = 'EMAIL_TAKEN';
    throw err;
  }

  const passwordHash = await hashPassword(password);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // New signups start 'pending'; an admin enables the account once payment is
    // confirmed (subscriptions are handled outside the app). The login gate
    // returns 403 not_approved until then.
    const ins = await client.query<{ id: string }>(
      `INSERT INTO users
         (email, password_hash, role, email_verified, status,
          first_name, last_name, phone)
       VALUES ($1, $2, 'athlete', FALSE, 'pending', $3, $4, $5)
       RETURNING id`,
      [
        email,
        passwordHash,
        contact.firstName ?? null,
        contact.lastName ?? null,
        contact.phone ?? null,
      ]
    );
    const userId = ins.rows[0].id;

    const token = generateToken();
    const tokenHash = hashToken(token);
    await client.query(
      `INSERT INTO email_verifications (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresIn(VERIFY_TOKEN_TTL_MS)]
    );
    await client.query('COMMIT');

    let emailSendFailed = false;
    try {
      await sendVerifyEmail(email, token);
    } catch (e) {
      logger.error({ err: e, userId, email }, 'verify email send failed');
      emailSendFailed = true;
    }

    return { userId, email, emailSendFailed };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── Login ───────────────────────────────────────────────────────
export class LoginError extends Error {
  constructor(
    public reason:
      | 'invalid_credentials'
      | 'email_not_verified'
      | 'not_approved'
      | 'rejected'
      | 'payment_required'
      | 'membership_paused'
  ) {
    super(reason);
  }
}

export interface LoginContext {
  userAgent?: string | null;
  ipAddress?: string | null;
}

export async function login(
  email: string,
  password: string,
  ctx: LoginContext = {}
): Promise<AuthLoginResult> {
  const r = await pool.query<{
    id: string;
    password_hash: string;
    role: 'athlete' | 'admin' | 'superadmin';
    email: string;
    email_verified: boolean;
    status: 'pending' | 'approved' | 'rejected';
    membership_active: boolean;
    membership_status: string | null;
  }>(
    `SELECT u.id, u.password_hash, u.role, u.email, u.email_verified, u.status,
            COALESCE(m.paid_until + interval '48 hours' > now(), false) AS membership_active,
            m.status AS membership_status
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
      WHERE u.email = $1`,
    [email]
  );
  const user = r.rows[0];
  if (!user) {
    // Run a dummy compare so non-existent users take same time as wrong-password users
    // (timing-attack mitigation against email enumeration)
    await comparePassword(
      password,
      '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid'
    );
    throw new LoginError('invalid_credentials');
  }
  const ok = await comparePassword(password, user.password_hash);
  if (!ok) throw new LoginError('invalid_credentials');
  if (!user.email_verified) throw new LoginError('email_not_verified');
  // Account-status gate — single source of truth for access (admin enables after
  // manual payment). Checked after email verification so a brand-new signup is
  // told to verify first, then that it is awaiting approval.
  if (user.status === 'pending') throw new LoginError('not_approved');
  if (user.status === 'rejected') throw new LoginError('rejected');
  // Payment gate (athletes only — admins/superadmins need no membership). An
  // expired or missing membership (past the 48h grace window) throws
  // 'payment_required' so the mobile app shows the payment-details screen.
  // ('infinity' paid_until is > now() in Postgres, so backfilled athletes pass.)
  // Paused and vacation memberships deny access outright. Checked before the
  // payment gate: paid_until may still be in the future (vacation maintenance
  // or a frozen pause) and the athlete should see "paused", not "payment
  // required". Vacation reuses membership_paused so the shipped app copy
  // ("tu membresía está pausada") stays correct without a release.
  if (user.role === 'athlete' &&
      (user.membership_status === 'paused' || user.membership_status === 'vacation')) {
    throw new LoginError('membership_paused');
  }
  if (user.role === 'athlete' && !user.membership_active) {
    throw new LoginError('payment_required');
  }

  const familyId = randomUUID();
  const refresh = generateToken();
  const refreshHash = hashToken(refresh);
  await pool.query(
    `INSERT INTO refresh_tokens
       (user_id, family_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      user.id,
      familyId,
      refreshHash,
      expiresIn(REFRESH_TOKEN_TTL_MS),
      ctx.userAgent ?? null,
      ctx.ipAddress ?? null,
    ]
  );

  const accessToken = jwt.sign(
    { id: user.id, role: user.role },
    env.JWT_SECRET as jwt.Secret,
    { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions
  );

  return {
    accessToken,
    refreshToken: refresh,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

// ─── Refresh (rotation + family revoke on reuse) ─────────────────
export class RefreshError extends Error {
  constructor(public reason: 'invalid' | 'reuse_detected' | 'expired') {
    super(reason);
  }
}

export async function refresh(
  refreshToken: string,
  ctx: LoginContext = {}
): Promise<{ accessToken: string; refreshToken: string }> {
  const tokenHash = hashToken(refreshToken);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query<{
      id: string;
      user_id: string;
      family_id: string;
      expires_at: string;
      revoked_at: string | null;
    }>(
      `SELECT id, user_id, family_id, expires_at, revoked_at
         FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash]
    );
    const row = r.rows[0];
    if (!row) {
      await client.query('COMMIT');
      throw new RefreshError('invalid');
    }

    if (row.revoked_at) {
      // REUSE DETECTED — revoke entire family
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = NOW()
          WHERE family_id = $1 AND revoked_at IS NULL`,
        [row.family_id]
      );
      await client.query('COMMIT');
      logger.warn(
        { userId: row.user_id, familyId: row.family_id },
        'refresh token reuse detected'
      );
      throw new RefreshError('reuse_detected');
    }

    if (isExpired(row.expires_at)) {
      await client.query('COMMIT');
      throw new RefreshError('expired');
    }

    // Re-check access on refresh so a lapsed athlete can't keep minting tokens.
    const u = await client.query<{
      role: 'athlete' | 'admin' | 'superadmin';
      status: string;
      membership_active: boolean;
      membership_status: string | null;
    }>(
      `SELECT u.role, u.status, COALESCE(m.paid_until + interval '48 hours' > now(), false) AS membership_active,
              m.status AS membership_status
         FROM users u LEFT JOIN memberships m ON m.user_id = u.id
        WHERE u.id = $1`,
      [row.user_id]
    );
    const acct = u.rows[0];
    const athleteBlocked =
      acct.role === 'athlete' &&
      (acct.status !== 'approved' ||
        !acct.membership_active ||
        acct.membership_status === 'paused' ||
        acct.membership_status === 'vacation');
    if (acct.status === 'rejected' || athleteBlocked) {
      // Revoke the family and force re-login (which surfaces the gate message).
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $1 AND revoked_at IS NULL`,
        [row.family_id]
      );
      await client.query('COMMIT');
      throw new RefreshError('invalid');
    }

    // Rotate: revoke current, insert new in same family
    const newRefresh = generateToken();
    const newHash = hashToken(newRefresh);
    const newR = await client.query<{ id: string }>(
      `INSERT INTO refresh_tokens
         (user_id, family_id, token_hash, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        row.user_id,
        row.family_id,
        newHash,
        expiresIn(REFRESH_TOKEN_TTL_MS),
        ctx.userAgent ?? null,
        ctx.ipAddress ?? null,
      ]
    );
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = $1 WHERE id = $2`,
      [newR.rows[0].id, row.id]
    );

    await client.query('COMMIT');

    const accessToken = jwt.sign(
      { id: row.user_id, role: u.rows[0].role },
      env.JWT_SECRET as jwt.Secret,
      { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions
    );

    return { accessToken, refreshToken: newRefresh };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ─── Logout ──────────────────────────────────────────────────────
export async function logout(refreshToken: string): Promise<void> {
  const tokenHash = hashToken(refreshToken);
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
}

// Admin action: kill every active session of a user. Their access token keeps
// working until it expires (≤15m); the next refresh forces a re-login.
export async function forceLogout(userId: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

// ─── Email verification ─────────────────────────────────────────
export class VerifyError extends Error {
  constructor(public reason: 'invalid' | 'expired' | 'used') {
    super(reason);
  }
}

export async function verifyEmail(token: string): Promise<{ userId: string }> {
  const tokenHash = hashToken(token);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query<{
      id: string;
      user_id: string;
      expires_at: string;
      used_at: string | null;
    }>(
      `SELECT id, user_id, expires_at, used_at
         FROM email_verifications WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash]
    );
    const row = r.rows[0];
    if (!row) throw new VerifyError('invalid');
    if (row.used_at) throw new VerifyError('used');
    if (isExpired(row.expires_at)) throw new VerifyError('expired');

    await client.query(
      `UPDATE email_verifications SET used_at = NOW() WHERE id = $1`,
      [row.id]
    );
    await client.query(
      `UPDATE users
          SET email_verified = TRUE, email_verified_at = NOW()
        WHERE id = $1`,
      [row.user_id]
    );
    await client.query('COMMIT');
    return { userId: row.user_id };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function resendVerification(userId: string): Promise<{
  emailSendFailed: boolean;
  alreadyVerified?: boolean;
}> {
  const u = await pool.query<{ email: string; email_verified: boolean }>(
    `SELECT email, email_verified FROM users WHERE id = $1`,
    [userId]
  );
  const user = u.rows[0];
  if (!user) throw new VerifyError('invalid');
  if (user.email_verified)
    return { emailSendFailed: false, alreadyVerified: true };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Invalidate previous
    await client.query(
      `UPDATE email_verifications SET used_at = NOW()
        WHERE user_id = $1 AND used_at IS NULL`,
      [userId]
    );
    const token = generateToken();
    await client.query(
      `INSERT INTO email_verifications (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, hashToken(token), expiresIn(VERIFY_TOKEN_TTL_MS)]
    );
    await client.query('COMMIT');

    let emailSendFailed = false;
    try {
      await sendVerifyEmail(user.email, token);
    } catch (e) {
      logger.error({ err: e, userId }, 'resend verify email failed');
      emailSendFailed = true;
    }
    return { emailSendFailed };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ─── Forgot / Reset password (OTP) ──────────────────────────────
const MAX_ATTEMPTS = 5;

// Exported so tests can spy on it
export function generateSixDigitCode(): string {
  // crypto-strong 6-digit code (range 100000..999999)
  const buf = crypto.randomBytes(4);
  const n = buf.readUInt32BE(0) % 900_000;
  return String(100_000 + n);
}

export async function forgotPassword(
  email: string,
  requestedIp: string | null = null
): Promise<{ emailSendFailed: boolean }> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1`,
    [email]
  );
  const user = r.rows[0];
  if (!user) return { emailSendFailed: false }; // anti-enumeration

  const code = generateSixDigitCode();
  const codeHash = await bcrypt.hash(code, BCRYPT_COST);
  // Invalidate any prior unused row for this user
  await pool.query(
    `UPDATE password_resets SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL`,
    [user.id]
  );
  await pool.query(
    `INSERT INTO password_resets (user_id, code_hash, expires_at, requested_ip)
     VALUES ($1, $2, $3, $4)`,
    [user.id, codeHash, expiresIn(RESET_TOKEN_TTL_MS), requestedIp]
  );
  // Best-effort email (anti-enumeration: caller still gets 200)
  try {
    await sendPasswordResetEmail(email, code);
    return { emailSendFailed: false };
  } catch (e) {
    logger.error({ err: e, email }, 'failed to send reset code email');
    return { emailSendFailed: true };
  }
}

export class ResetError extends Error {
  public attemptsLeft?: number;
  constructor(
    public reason:
      | 'invalid_code'
      | 'code_expired'
      | 'weak_password'
      | 'not_athlete',
    attemptsLeft?: number
  ) {
    super(reason);
    this.attemptsLeft = attemptsLeft;
  }
}

async function findAndValidateCode(
  client: import('pg').PoolClient,
  email: string,
  code: string,
  consume: boolean
): Promise<{ rowId: string; userId: string }> {
  const userR = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1`,
    [email]
  );
  const user = userR.rows[0];
  // Anti-enumeration: if no user, throw code_expired (mimicking "row not found")
  if (!user) throw new ResetError('code_expired');

  const r = await client.query<{
    id: string;
    code_hash: string;
    expires_at: string;
    used_at: string | null;
    attempts: number;
  }>(
    `SELECT id, code_hash, expires_at, used_at, attempts
       FROM password_resets
       WHERE user_id = $1 AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1
       FOR UPDATE`,
    [user.id]
  );
  const row = r.rows[0];
  if (!row) throw new ResetError('code_expired');
  if (isExpired(row.expires_at)) {
    await client.query(
      `UPDATE password_resets SET used_at = NOW() WHERE id = $1`,
      [row.id]
    );
    throw new ResetError('code_expired');
  }

  const match = await bcrypt.compare(code, row.code_hash);
  if (!match) {
    const newAttempts = row.attempts + 1;
    if (newAttempts >= MAX_ATTEMPTS) {
      await client.query(
        `UPDATE password_resets SET attempts = $1, used_at = NOW() WHERE id = $2`,
        [newAttempts, row.id]
      );
      throw new ResetError('code_expired');
    }
    await client.query(
      `UPDATE password_resets SET attempts = $1 WHERE id = $2`,
      [newAttempts, row.id]
    );
    throw new ResetError('invalid_code', MAX_ATTEMPTS - newAttempts);
  }

  if (consume) {
    await client.query(
      `UPDATE password_resets SET used_at = NOW() WHERE id = $1`,
      [row.id]
    );
  }
  return { rowId: row.id, userId: user.id };
}

export async function verifyResetCode(
  email: string,
  code: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await findAndValidateCode(client, email, code, /* consume */ false);
    await client.query('COMMIT');
  } catch (e) {
    if (e instanceof ResetError) {
      // Commit so attempt increments and invalidations persist
      await client.query('COMMIT').catch(() => {});
    } else {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function resetPassword(
  email: string,
  code: string,
  newPassword: string
): Promise<AuthLoginResult> {
  if (newPassword.length < 8) throw new ResetError('weak_password');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { userId } = await findAndValidateCode(
      client,
      email,
      code,
      /* consume */ true
    );

    // Role gate — mobile is athletes-only
    const u = await client.query<{
      id: string;
      email: string;
      role: 'athlete' | 'admin' | 'superadmin';
      status: 'pending' | 'approved' | 'rejected';
    }>(`SELECT id, email, role, status FROM users WHERE id = $1`, [userId]);
    const user = u.rows[0];
    if (user.role !== 'athlete') throw new ResetError('not_athlete');

    const newHash = await hashPassword(newPassword);
    await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
      newHash,
      userId,
    ]);

    // Revoke all active refresh tokens (anti-takeover)
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );

    // Pending accounts may change their password, but must not receive a
    // session — that skipped the login approval gate (see login()).
    if (user.status === 'pending') {
      await client.query('COMMIT');
      throw new LoginError('not_approved');
    }

    // Issue new access + refresh tokens (same flow as login)
    const familyId = randomUUID();
    const refreshTokenRaw = generateToken();
    const refreshHash = hashToken(refreshTokenRaw);
    await client.query(
      `INSERT INTO refresh_tokens
         (user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, familyId, refreshHash, expiresIn(REFRESH_TOKEN_TTL_MS)]
    );

    const accessToken = jwt.sign(
      { id: user.id, role: user.role },
      env.JWT_SECRET as jwt.Secret,
      { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions
    );

    await client.query('COMMIT');

    return {
      accessToken,
      refreshToken: refreshTokenRaw,
      user: { id: user.id, email: user.email, role: user.role },
    };
  } catch (e) {
    if (e instanceof LoginError) {
      // Password change already committed; do not roll it back.
      throw e;
    }
    if (
      e instanceof ResetError &&
      (e.reason === 'invalid_code' ||
        e.reason === 'code_expired' ||
        e.reason === 'not_athlete')
    ) {
      // Commit so attempt increments, row invalidations, and code consumption persist
      await client.query('COMMIT').catch(() => {});
    } else {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw e;
  } finally {
    client.release();
  }
}

// ─── Self-service account deletion (App Store 5.1.1(v)) ─────────────
export class DeleteAccountError extends Error {
  constructor(
    public reason: 'invalid_credentials' | 'not_found' | 'not_athlete'
  ) {
    super(reason);
  }
}

export async function deleteAccount(
  userId: string,
  password: string
): Promise<void> {
  const r = await pool.query<{
    email: string;
    password_hash: string;
    role: string;
    avatar_url: string | null;
  }>(
    `SELECT u.email, u.password_hash, u.role, ap.avatar_url
       FROM users u
       LEFT JOIN athlete_profiles ap ON ap.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );
  const user = r.rows[0];
  if (!user) throw new DeleteAccountError('not_found');
  if (user.role !== 'athlete') throw new DeleteAccountError('not_athlete');

  const ok = await comparePassword(password, user.password_hash);
  if (!ok) throw new DeleteAccountError('invalid_credentials');

  // Avatar objects live outside Postgres, so the FK cascade can't clean them up.
  await deleteAvatarObject(user.avatar_url);
  await deleteUserCommunityMedia(userId);

  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);

  await logAudit({
    type: 'user_deleted',
    actor: user.email,
    target: user.email,
    target_id: userId,
    severity: 'destructive',
    meta: { self_service: true },
  });
}

async function deleteAvatarObject(avatarUrl: string | null): Promise<void> {
  if (!avatarUrl) return;
  if (env.EXTERNAL_EFFECTS_ENABLED === 'false') {
    logger.info('avatar delete blocked in rehearsal');
    return;
  }
  try {
    const encoded = new URL(avatarUrl).pathname.split('/o/')[1] ?? '';
    const objectPath = decodeURIComponent(encoded);
    if (!objectPath) return;
    await getStorageBucket().file(objectPath).delete();
  } catch (e) {
    logger.warn({ err: e, avatarUrl }, 'account-delete: avatar cleanup failed');
  }
}
