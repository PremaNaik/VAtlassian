import { affectedRows, executeQuery } from '../lib/db.js';
import { throwing } from './store.js';
import { revokeActiveCredentials } from './webauthnCredentialStore.js';

/**
 * Failed biometric (device check) attempts, per person. Three failures lock the
 * person's biometric signing until an administrator resets it; the person
 * cannot unlock themselves. This is the biometric twin of the TOTP lock held in
 * va_credential (lib/totp.js MAX_FAILED_ATTEMPTS).
 *
 * Migration v144_webauthn_lock creates va_webauthn_lock. Migrations run from the
 * five-minute trigger, not at deploy, so new code runs briefly against the old
 * schema: every READ here tolerates a missing table and reports "not locked",
 * and the write paths are called inside try/catch by their callers. A person is
 * never refused because this table is not there yet, and nothing is ever
 * allowed because of it: a signature still needs a valid device check.
 */

export const MAX_BIOMETRIC_ATTEMPTS = 3;

export const WEBAUTHN_LOCK_STATE = Object.freeze({
  OPEN: 'OPEN',
  LOCKED: 'LOCKED'
});

function shape(row) {
  const failedAttempts = Number(row?.failed_attempts ?? 0);
  const locked = row?.state === WEBAUTHN_LOCK_STATE.LOCKED;
  return {
    locked,
    failedAttempts,
    attemptsRemaining: locked ? 0 : Math.max(0, MAX_BIOMETRIC_ATTEMPTS - failedAttempts),
    lockedAt: row?.locked_at == null ? null : Number(row.locked_at)
  };
}

async function readRow(accountId) {
  const rows = await throwing(
    `SELECT account_id, failed_attempts, state, locked_at
     FROM va_webauthn_lock
     WHERE account_id = ?
     LIMIT 1`,
    [accountId]
  );
  return rows[0] ?? null;
}

/** Current lock state. A missing table or a read failure reads as not locked. */
export async function lockState(accountId) {
  try {
    return shape(await readRow(accountId));
  } catch (error) {
    console.error('webauthn lock: state unreadable, treated as not locked', error?.message ?? error);
    return shape(null);
  }
}

/**
 * Count one failed device check. Atomic: concurrent failures cannot skip the
 * lock. Once locked the count stops growing. Throws on a storage failure; the
 * caller decides what to do (approval.js logs and carries on refusing).
 */
export async function recordFailure({ accountId, now = Date.now() }) {
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw new TypeError('A valid accountId is required to record a failed attempt.');
  }
  const firstLocks = MAX_BIOMETRIC_ATTEMPTS <= 1;
  await throwing(
    `INSERT INTO va_webauthn_lock (account_id, failed_attempts, state, locked_at, updated_at)
     VALUES (?, 1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       failed_attempts = IF(state = 'LOCKED', failed_attempts, failed_attempts + 1),
       locked_at = IF(state = 'OPEN' AND failed_attempts >= ?, ?, locked_at),
       state = IF(state = 'OPEN' AND failed_attempts >= ?, 'LOCKED', state),
       updated_at = ?`,
    [
      accountId,
      firstLocks ? WEBAUTHN_LOCK_STATE.LOCKED : WEBAUTHN_LOCK_STATE.OPEN,
      firstLocks ? now : null,
      now,
      MAX_BIOMETRIC_ATTEMPTS,
      now,
      MAX_BIOMETRIC_ATTEMPTS,
      now
    ]
  );
  return shape(await readRow(accountId));
}

/** A good device check clears earlier failures. A locked person is never cleared this way. */
export async function clearFailures({ accountId, now = Date.now() }) {
  await executeQuery(
    `UPDATE va_webauthn_lock
     SET failed_attempts = 0, updated_at = ?
     WHERE account_id = ? AND state = ? AND failed_attempts > 0`,
    [now, accountId, WEBAUTHN_LOCK_STATE.OPEN]
  );
}

/** Open the lock and zero the count. Administrator-only: callers must have checked that. */
export async function unlock({ accountId, now = Date.now() }) {
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw new TypeError('A valid accountId is required to unlock biometric signing.');
  }
  const result = await executeQuery(
    `UPDATE va_webauthn_lock
     SET state = ?, failed_attempts = 0, locked_at = NULL, updated_at = ?
     WHERE account_id = ?`,
    [WEBAUTHN_LOCK_STATE.OPEN, now, accountId]
  );
  return { unlocked: affectedRows(result) ?? 0, accountId };
}

/**
 * What an administrator's "reset" does to biometric signing: open the lock AND
 * revoke the person's registered devices, so they must register again before
 * they can sign. The caller (the admin usecase) is responsible for checking
 * that the caller is an administrator and is not resetting themselves.
 */
export async function resetBiometric({ accountId, now = Date.now() }) {
  const { unlocked } = await unlock({ accountId, now });
  const { revoked } = await revokeActiveCredentials({ accountId });
  return { accountId, unlocked, revoked };
}