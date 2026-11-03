# Sandbox runtime (gVisor / Kata) for production

The Scan worker runs untrusted project code — installs, builds, tests — inside the sandbox
container (`infra/sandbox`). The default Docker runtime, **runc**, shares the host kernel, so a
kernel exploit from that code would reach the host. Production must use a runtime that gives
the sandbox its own kernel or VM (audit F-08, ADR 0032):
- **gVisor (`runsc`)** — recommended; a user-space kernel.
- **Kata Containers (`kata`)** — a lightweight VM per container.
- **Firecracker (`firecracker`)** — microVMs.

CodeSentra enforces this in two places:
1. **Config refuses runc in production.** With `NODE_ENV=production`, `SANDBOX_RUNTIME=runc`
   fails at startup; set it to `runsc`, `kata` or `firecracker`.
2. **The worker verifies the runtime by running a container.** On each scan it runs a
   throwaway container with the configured runtime and checks it started and isolates. If the
   runtime is missing or does not isolate, the probes become a coverage gap (Unverified), never
   a false pass — and the worker does not crash. The runtime that actually ran is recorded on
   the run.

## Installing gVisor (Debian/Ubuntu host)

Run on each host that runs the Scan worker's Docker:

```sh
# Install runsc (see https://gvisor.dev/docs/user_guide/install/ for the current, signed steps)
(
  set -e
  ARCH=$(uname -m)
  URL=https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}
  wget -q "${URL}/runsc" "${URL}/runsc.sha512" \
       "${URL}/containerd-shim-runsc-v1" "${URL}/containerd-shim-runsc-v1.sha512"
  sha512sum -c runsc.sha512 -c containerd-shim-runsc-v1.sha512
  chmod a+rx runsc containerd-shim-runsc-v1
  sudo mv runsc containerd-shim-runsc-v1 /usr/local/bin
)
# Register the runtime with Docker
sudo runsc install
sudo systemctl reload docker
# Confirm Docker offers it
docker info --format '{{json .Runtimes}}' | grep -o runsc
```

Then set `SANDBOX_RUNTIME=runsc` for the Scan worker.

## Verifying it works

```sh
SANDBOX_IMAGE=codesentra/sandbox:<tag> node -e "import('@codesentra/sandbox').then(async m => console.log(await m.verifyRuntime(process.env.SANDBOX_IMAGE)))"
# { ok: true, runtime: 'runsc', isolating: true }
```

> This development environment has no gVisor, so the positive `runsc` path is **UNVERIFIED
> here**: the command above is what confirms it on a gVisor-capable host. The negative paths
> (runc is refused in production; a missing runtime degrades to a gap) are covered by tests.
