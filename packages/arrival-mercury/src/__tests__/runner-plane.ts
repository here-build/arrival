/**
 * Test-only product plane. Production hosts pass their own `capabilities`.
 */
import { inhumanRunnerCapability } from "@inhuman.tools/runner-capability";

import { openProbeSession, type ProbeSession } from "../probe/session.js";
import { openOracleSession, type OracleSession } from "../registry/greenfield-session.js";

export const RUNNER_PLANE = [inhumanRunnerCapability] as const;

export function openRunnerOracleSession(): Promise<OracleSession> {
  return openOracleSession(RUNNER_PLANE);
}

export function openRunnerProbeSession(): Promise<ProbeSession> {
  return openProbeSession(RUNNER_PLANE);
}
