import ForgeResolver from '@forge/resolver';
import * as sprint from '../usecases/sprint.js';
import * as harness from './harness.js';
import { wrapWithHarness } from '../lib/harnessLogger.js';

const Resolver = ForgeResolver.default ?? ForgeResolver;
const resolver = new Resolver();

// Sprint readiness and signed start/complete (lib/sprintStart.js). The sprint
// and board come from the sprint action's context, never from the payload.
resolver.define('sprint:getReadiness', ({ payload, context }) => sprint.readiness({ payload, context }));
resolver.define('sprint:start', ({ payload, context }) => sprint.start({ payload, context }));
resolver.define('sprint:complete', ({ payload, context }) => sprint.complete({ payload, context }));
resolver.define('sprint:operation', ({ payload, context }) => sprint.operation({ payload, context }));

// Client telemetry only.
resolver.define('harness:logAction', ({ payload, context }) => harness.logAction({ payload, context }));

const definitions = resolver.getDefinitions();
export const handler = wrapWithHarness(definitions, { resolverName: 'sprint' });
