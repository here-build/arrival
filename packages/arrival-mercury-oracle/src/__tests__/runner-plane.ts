/**
 * Test-only product plane. Production hosts pass their own `capabilities`.
 */
import { openOracleSession, type OracleSession } from "@inhuman.tools/arrival-mercury-oracle";
import { inhumanRunnerCapability } from "@inhuman.tools/runner-capability";

export const RUNNER_PLANE = [inhumanRunnerCapability] as const;

export function openRunnerOracleSession(): Promise<OracleSession> {
  return openOracleSession(RUNNER_PLANE);
}
