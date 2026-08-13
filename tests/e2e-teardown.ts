// Kills the anvil started by e2e-setup.ts (pid handed over via process.env).
export default function globalTeardown() {
  const pid = Number(process.env.PACT_E2E_ANVIL_PID);
  if (pid) process.kill(pid);
}
