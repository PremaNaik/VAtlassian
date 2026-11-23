import { totpRuntime } from '../lib/approval/totpRuntime.js';
import {
  affectedRows,
  toBinaryParam
} from '../lib/db.js';
import {
  revokeActiveCredentials
} from '../db/webauthnCredentialStore.js';
import { lookupUsers } from '../lib/directory.js';

function requireQuerySuccess(result, operation) {
  if (!result?.result) {
    console.error(`Authenticator database operation failed: ${operation}`);
    throw new Error(`Database operation failed: ${operation}`);
  }

  return result;
}

export async function enrollmentRuntime() {
  const deps = await totpRuntime();

  return {
    ...deps,

    administrators: async () => {
      const result = requireQuerySuccess(
        await deps.query(`
          SELECT account_id
          FROM va_admin
          WHERE state = 'ACTIVE'
          ORDER BY created_at
        `),
        'load administrators'
      );

      const ids = (result.data ?? []).map(row => row.account_id);
      if (ids.length === 0) return [];

      const users = await lookupUsers(ids);

      return ids.map(accountId => ({
        accountId,
        displayName: users.get(accountId)?.displayName ?? null
      }));
    },

    grant: async accountId => {
      const result = requireQuerySuccess(
        await deps.query(
          `SELECT
             TO_BASE64(grant_id) AS grant_id,
             expires_at,
             redeemed_at
           FROM va_credential_reset_grant
           WHERE account_id = ?
             AND redeemed_at IS NULL
             AND expires_at > ?
           ORDER BY issued_at DESC
           LIMIT 1`,
          [accountId, deps.now()]
        ),
        'load reset grant'
      );

      return result.data?.[0] ?? null;
    },

    redeem: async (grant, now) => {
      if (!grant?.grant_id) return false;

      const result = requireQuerySuccess(
        await deps.query(
          `UPDATE va_credential_reset_grant
           SET redeemed_at = ?
           WHERE grant_id = FROM_BASE64(?)
             AND redeemed_at IS NULL
             AND expires_at > ?`,
          [now, grant.grant_id, now]
        ),
        'redeem reset grant'
      );

      return affectedRows(result) === 1;
    },

    // Called by the reset usecase after validating the administrator grant.
    // Revoked credentials are excluded by the WebAuthn credential read methods.
    revokeBiometricCredentials: async accountId => {
      return revokeActiveCredentials({
        accountId,
        now: deps.now()
      });
    },

    write: async (accountId, previous, stored, now) => {
      const params = [
        toBinaryParam(stored.ciphertext),
        toBinaryParam(stored.iv),
        toBinaryParam(stored.tag),
        stored.keyVersion,
        stored.algo,
        stored.digits,
        stored.period_seconds,
        now
      ];

      if (!previous) {
        const result = requireQuerySuccess(
          await deps.query(
            `INSERT INTO va_credential
              (
                secret_ciphertext,
                secret_iv,
                secret_tag,
                key_version,
                algo,
                digits,
                period_seconds,
                enrolled_at,
                account_id,
                state
              )
             VALUES (
                FROM_BASE64(?),
                FROM_BASE64(?),
                FROM_BASE64(?),
                ?, ?, ?, ?, ?, ?,
                'PENDING_CONFIRM'
              )`,
            [...params, accountId]
          ),
          'insert TOTP credential'
        );

        return affectedRows(result) === 1;
      }

      // Compare-and-swap: do not DELETE+INSERT. This prevents a concurrent
      // confirmation or credential update from being silently overwritten.
      const result = requireQuerySuccess(
        await deps.query(
          `UPDATE va_credential
           SET
             secret_ciphertext = FROM_BASE64(?),
             secret_iv = FROM_BASE64(?),
             secret_tag = FROM_BASE64(?),
             key_version = ?,
             algo = ?,
             digits = ?,
             period_seconds = ?,
             enrolled_at = ?,
             state = 'PENDING_CONFIRM',
             confirmed_at = NULL,
             last_used_step = NULL,
             failed_attempts = 0,
             locked_at = NULL,
             last_verified_at = NULL,
             verification_count = 0,
             version = version + 1
           WHERE account_id = ?
             AND version = ?
             AND state = ?`,
          [
            ...params,
            accountId,
            previous.version,
            previous.state
          ]
        ),
        'replace TOTP credential'
      );

      return affectedRows(result) === 1;
    }
  };
}