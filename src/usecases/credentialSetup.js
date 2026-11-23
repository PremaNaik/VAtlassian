import { MAX_FAILED_ATTEMPTS } from '../lib/totp.js';
import { needsUserConsent } from '../lib/errors.js';
import { credentialsFor } from '../db/webauthnCredentialStore.js';
import { lockState } from '../db/webauthnLockStore.js';

/**
 * What the signed-in person has set up, for the signing screens' setup gate.
 * Read-only and about the caller only: identity comes from context.accountId,
 * never from the payload. The screen uses this to decide what to SHOW; the
 * server still refuses a signature from a missing, locked or wrong credential.
 */
export function createSetupUsecases(deps) {
  async function status({ context } = {}) {
    try {
      const accountId = context?.accountId;
      if (typeof accountId !== 'string' || !accountId) {
        return { success: false, error: 'Sign in to see your signing setup.' };
      }
      const [totpRow, devices, lock] = await Promise.all([
        deps.readTotp(accountId),
        deps.devices(accountId),
        deps.biometricLock(accountId)
      ]);

      const totpState = totpRow?.state ?? 'NONE';
      const failed = Number(totpRow?.failed_attempts);
      const totpAttempts = totpState === 'ACTIVE' && Number.isFinite(failed)
        ? Math.max(0, MAX_FAILED_ATTEMPTS - failed)
        : undefined;

      return {
        success: true,
        setup: {
          totp: {
            enrolled: totpState === 'ACTIVE',
            locked: totpState === 'LOCKED',
            ...(totpAttempts === undefined ? {} : { attemptsRemaining: totpAttempts })
          },
          biometric: {
            enrolled: Array.isArray(devices) && devices.length > 0,
            locked: lock.locked === true,
            attemptsRemaining: lock.attemptsRemaining
          }
        }
      };
    } catch (error) {
      if (needsUserConsent(error)) throw error;
      console.error('credential setup status failed', error?.message ?? error);
      return { success: false, error: 'Your signing setup could not be read. Refresh and try again.' };
    }
  }
  return { status };
}

async function api() {
  const { enrollmentRuntime } = await import('./totpEnrollmentRuntime.js');
  const totp = await enrollmentRuntime();
  return createSetupUsecases({
    readTotp: accountId => totp.read(accountId),
    devices: accountId => credentialsFor(accountId),
    biometricLock: accountId => lockState(accountId)
  });
}

export async function status(args) { return (await api()).status(args); }