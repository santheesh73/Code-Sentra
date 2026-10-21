# 0004 — Local MinIO image comes from `pgsty/minio`

- **Status:** accepted (Phase 0)

## Context

The kickoff specifies MinIO for local object storage. Upstream MinIO no longer publishes
container images: `minio/minio` no longer exists on Docker Hub, and quay.io was not
reachable from the build environment.

## Decision

Use `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, a maintained build of MinIO from source
that bundles `mc`. The same image runs the server and the `minio-init` job, which creates
the bucket and sets it private. The tag is pinned.

## Consequences

The code depends only on the S3 API, so swapping to RustFS, SeaweedFS or Garage later
is a compose-file change. Production uses S3 or R2.
