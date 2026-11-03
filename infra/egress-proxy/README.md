# Dependency-download egress allowlist

The Scan worker downloads a project's dependencies in a sandbox container with the network
on (install itself runs later with the network off). That container must reach the package
registries and nothing else: not the worker's network, not the database or object storage,
not cloud metadata, not the internet at large (ADR 0030, audit F-04).

## How it works

- `squid.conf` runs Squid as a forward proxy that accepts only HTTPS `CONNECT` to the hosts
  in `allowed-hosts.txt`, on port 443. Every other host, and plain HTTP, get `403`. Squid
  never intercepts TLS, so the tunnel is end to end and no registry token is visible to it.
- The fetch container is attached to an **internal** Docker network (no gateway), so its
  only way off that network is the proxy, which also sits on an outward network.
- The worker is pointed at this setup with:
  - `SANDBOX_FETCH_NETWORK=<the internal network name>`
  - `SANDBOX_FETCH_PROXY=http://<proxy host>:3128`

## Running it

With compose: `docker compose --profile egress up -d egress-proxy`. It joins the internal
`egress` network and an outward one. Point the Scan worker's `SANDBOX_FETCH_*` at it.

## Allowed hosts

`allowed-hosts.txt` lists the registries, one per line (a leading dot includes subdomains).
Keep it in step with the registries the probe planner downloads from; adding an ecosystem
means adding its registry here.

## Test

`packages/sandbox/src/egress.test.ts` starts this proxy on an internal network and checks,
with raw CONNECT probes, that an allowlisted registry is permitted, that other hosts, a
metadata IP, a look-alike host and a non-443 port are refused, and that a client on the
internal network has no other route out.
