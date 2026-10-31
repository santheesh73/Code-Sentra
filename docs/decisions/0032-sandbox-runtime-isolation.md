# 0032 — Sandbox runtime isolation in production

- **Status:** accepted (remediation WS-3)

## Context

The audit (F-08) found the sandbox running under **runc**, Docker's default runtime, which
shares the host kernel. Every other isolation control held (unprivileged user, dropped
capabilities, no-new-privileges, read-only root, no network for the probes, memory/pid/time
limits), but runc leaves a kernel exploit from untrusted project code as the remaining escape
path. The runtime was selected by `docker info` text and used whatever was present; a
production deployment could silently run untrusted code under runc. The audit also noted the
Docker daemon dying repeatedly, which must never surface as a product failure or a false result.

## Decision

- **Production requires an isolating runtime.** `SANDBOX_RUNTIME` accepts `runsc` (gVisor),
  `kata`, `firecracker` or `runc`; with `NODE_ENV=production`, config refuses `runc` at
  startup. runc stays available for development and tests.
- **The runtime is confirmed by running a container, not by parsing `docker info`.**
  `verifyRuntime(image)` runs a throwaway container with the detected runtime and reports the
  runtime that ran and whether it isolates the guest from the host kernel. The Scan worker
  calls it and, in production, refuses to build a sandbox under a non-isolating runtime, or
  when the configured isolating runtime is not the one Docker actually used.
- **Docker or runtime unavailability is a coverage gap, never a failure.** When the daemon is
  down or the probe container cannot start, the worker records the probes as a gap (Unverified)
  with the reason, and does not crash; the queue's existing retry/backoff re-runs the job, and a
  transient daemon restart is then picked up. A gap is honest Unverified, not a false pass and
  not a product error against the user's code.
- **The runtime that ran is recorded** on the run (the probe run already carries it), so a scan
  made under runc in development is distinguishable from one made under gVisor.
- **Install and verification are documented** in `infra/sandbox/RUNTIME.md` (gVisor/Kata setup,
  the one-line `verifyRuntime` check).

## Consequences

- **A production Scan worker will not run untrusted code under a shared kernel.** It refuses to
  start with runc, and refuses to run probes if the isolating runtime is not actually in force.
- **The positive gVisor path is verified on a gVisor-capable host, not in this dev
  environment**, which has no runsc. The command to confirm it is in the docs; the negative
  paths (runc refused in production, missing runtime → gap) are unit/integration tested.
- **Each scan runs one extra throwaway container** for the runtime check. It runs `true` with
  no network and is sub-second; the cost buys proof the isolation is real for that scan, which
  matters because the daemon can change under the worker.
- Kata and Firecracker are accepted as isolating but are not exercised here; only gVisor is
  documented for setup.
