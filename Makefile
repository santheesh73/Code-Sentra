# CodeSentra — one entry point for contributors and CI.
#
# `make` (the default `check` target) runs the fast gate that needs NO Docker daemon:
# install, lint, typecheck, build. The heavier gates (unit+integration tests, e2e, the
# container stack, image scans) need Docker/Testcontainers and keep their own CI jobs in
# .github/workflows/ci.yml; `make test`, `make coverage`, etc. run them locally when Docker
# is available, and `make ci` chains the whole local-runnable set.
#
# The `make` CI job runs `make` on every push to main and every PR, so the documented entry
# point can never rot (branch protection marks it required on main — a repository setting).

SHELL := bash
.DEFAULT_GOAL := check
.PHONY: check ci install lint typecheck build test coverage bench walkthrough openapi \
        e2e gate sandbox-image clean help

## check: the fast gate — no Docker needed (install, lint, typecheck, build)
check: install lint typecheck build

## ci: the full local-runnable gate (adds the Docker-backed unit+integration tests)
ci: check test

## install: install workspace dependencies from the frozen lockfile
install:
	pnpm install --frozen-lockfile

## lint: Biome lint + format check over the whole repo
lint:
	pnpm lint

## typecheck: tsc --noEmit across every package (turbo builds upstream deps first)
typecheck:
	pnpm typecheck

## build: build every package and app
build:
	pnpm build

## test: unit + integration tests (needs Docker: Testcontainers Postgres/MinIO, the sandbox image)
test:
	pnpm test

## coverage: per-package coverage with the committed thresholds
coverage:
	pnpm coverage

## bench: performance budgets for the CPU-bound hot paths
bench:
	pnpm bench

## walkthrough: run the README quickstart so it cannot rot
walkthrough:
	pnpm walkthrough

## openapi: regenerate the OpenAPI docs and fail if they drift
openapi:
	pnpm openapi && git diff --exit-code docs/openapi.json docs/api.md

## sandbox-image: build the untrusted-code sandbox image (needs Docker)
sandbox-image:
	docker build -t codesentra/sandbox:dev infra/sandbox

## e2e: the Phase 1–4 browser-driven end-to-end gate (needs Docker + Chromium)
e2e:
	pnpm e2e

## gate: the Phase 0 fixture gate
gate:
	pnpm gate:phase0

## clean: remove build outputs
clean:
	pnpm -r exec -- rm -rf dist out .next .turbo || true

## help: list the documented targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //'
