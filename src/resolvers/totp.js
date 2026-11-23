import ForgeResolver from '@forge/resolver';
import * as totp from '../usecases/totp.js';
import * as harness from './harness.js';
import { defineWebAuthnResolvers } from '../usecases/webauthn.js';
import { wrapWithHarness } from '../lib/harnessLogger.js';

const Resolver = ForgeResolver.default ?? ForgeResolver;
const resolver = new Resolver();

// TOTP
resolver.define('totp:checkStatus', ({ payload, context }) =>
  totp.checkStatus({ payload, context })
);

resolver.define('totp:deviceStatus', ({ payload, context }) =>
  totp.deviceStatus({ payload, context })
);

resolver.define('totp:enrol', ({ payload, context }) =>
  totp.enrol({ payload, context })
);

resolver.define('totp:confirm', ({ payload, context }) =>
  totp.confirm({ payload, context })
);

resolver.define('totp:attest', ({ payload, context }) =>
  totp.attest({ payload, context })
);

// WebAuthn biometric registration and status.
// defineWebAuthnResolvers registers:
// webauthn:status
// webauthn:enrolStart
// webauthn:enrolFinish
// webauthn:assertStart
defineWebAuthnResolvers(resolver);

// Client telemetry only. Do not expose issue inspection from this page.
resolver.define('harness:logAction', ({ payload, context }) =>
  harness.logAction({ payload, context })
);

const definitions = resolver.getDefinitions();

export const handler = wrapWithHarness(definitions, {
  resolverName: 'totp'
});