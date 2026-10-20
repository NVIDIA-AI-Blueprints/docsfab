# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

QUALITY_DIR := packages/quality
SKILLS_DIR := packages/skills
# Resolve the interpreter once and export it; helpers and tests run
# `${PYTHON:-python3}`. A version-manager shim such as pyenv's otherwise
# re-resolves the version with about a dozen process starts on every call.
ifeq ($(origin PYTHON),undefined)
PYTHON := $(or $(shell python3 -c 'import sys; print(sys.executable)' 2>/dev/null),python3)
endif
export PYTHON
FERN ?= fern
FERN_PORT ?= 3000

COMPARISON_MODEL_DIR := experiments/provider-comparisons
# Floor, not the exact count: a shrinking suite is the failure this catches.
# `override :=` not `?=` — CI variables reach the job environment, and plain
# `:=` still loses to `make -e` / a MAKEFLAGS variable, so an overridable floor
# is a gate anyone can silently switch off.
override COMPARISON_MODEL_MIN_CASES := 90
# Same reason: PYTHON is overridable for the other targets, but `PYTHON=true` would
# turn this assertion into a no-op, so the guard names its interpreter.
override COMPARISON_MODEL_PYTHON := python3

# Internal-only trees absent from the public export tree. A target that needs
# one refuses at its own recipe, naming the missing directories, except
# `scripts-test` reached only as a prerequisite of another goal such as `test`:
# it skips with a note and exits 0. `help` lists only the targets that can run.
HAVE_SCRIPTS := $(wildcard scripts)
HAVE_DEPLOY := $(wildcard deploy)
HAVE_EXPERIMENTS := $(wildcard experiments)
HAVE_BENCHMARKS := $(wildcard benchmarks)

empty :=
space := $(empty) $(empty)
# $(call absent_dirs,<dir> ...): the named directories this tree lacks.
absent_dirs = $(strip $(foreach dir,$(1),$(if $(wildcard $(dir)),,$(dir)/)))
# $(call absent_text,<dir> ...): "a/ is" or "a/ and b/ are" not present in this tree.
absent_text = $(subst $(space), and ,$(call absent_dirs,$(1))) \
	$(if $(word 2,$(call absent_dirs,$(1))),are,is) not present in this tree

.PHONY: help validate test smoke quality-validate quality-test quality-smoke \
	skills-test model-profile-validate demo-preview fern-check fern-dev \
	scripts-test orchestration-test comparison-model \
	benchmark-validate benchmark-plan benchmark-test \
	benchmark-expect-driver-test benchmark-dashboard \
	release-cut release-cut-apply release-cut-push

PUBLIC_TARGETS := help validate test smoke quality-validate quality-test \
	quality-smoke skills-test demo-preview fern-check fern-dev
INTERNAL_TARGETS :=
ifneq ($(and $(HAVE_SCRIPTS),$(HAVE_DEPLOY)),)
INTERNAL_TARGETS += scripts-test
endif
ifneq ($(HAVE_SCRIPTS),)
INTERNAL_TARGETS += orchestration-test model-profile-validate \
	release-cut release-cut-apply release-cut-push
endif
ifneq ($(and $(HAVE_SCRIPTS),$(HAVE_EXPERIMENTS)),)
INTERNAL_TARGETS += comparison-model
endif
ifneq ($(HAVE_BENCHMARKS),)
INTERNAL_TARGETS += benchmark-validate benchmark-plan benchmark-test \
	benchmark-expect-driver-test benchmark-dashboard
endif

help:
	@printf '%s\n' $(PUBLIC_TARGETS) $(INTERNAL_TARGETS) | sort

# `help` is the first target; bare `make` runs `validate`.
.DEFAULT_GOAL := validate

validate: quality-validate

test: quality-test skills-test scripts-test

ifneq ($(HAVE_SCRIPTS),)
include scripts/orchestration/tests.mk
include scripts/test/internal-tests.mk
endif

# Independent commands, run concurrently in one scripts/test/run-parallel.py
# pool with the orchestration tests. One command per line; longest first.
SCRIPTS_TESTS := \
	$(call orchestration_test_commands,scripts/orchestration/) \
	"node --test scripts/public-export/check-boundary.test.mjs" \
	"node --test scripts/public-export/codenames-apply.test.mjs" \
	"$(PYTHON) scripts/test/run-parallel.test.py" \
	"$(PYTHON) scripts/test/runtime-checkout-owner.test.py" \
	"node --test scripts/test/wsl2-ci-entry.test.mjs" \
	"node --test scripts/test/wsl2-ci-source.test.mjs" \
	"node --test scripts/test/wsl2-ci-ledger.test.mjs" \
	"node --test scripts/test/wsl2-ci-limits.test.mjs" \
	"node --test scripts/test/wsl2-ci-transport.test.mjs" \
	"node --test scripts/test/wsl2-ci-helpers.test.mjs" \
	"node --test scripts/test/wsl2-ci-installed-version.test.mjs" \
	"node --test scripts/test/wsl2-ci-admission.test.mjs" \
	"node --test scripts/test/wsl2-ci-stage.test.mjs" \
	"node --test scripts/test/wsl2-ci-interop-anchor.test.mjs" \
	"node --test scripts/test/wsl2-ci-short-native.test.mjs" \
	"node --test scripts/test/wsl2-ci-controller.test.mjs" \
	"node --test scripts/test/wsl2-ci-recovery.test.mjs" \
	"$(PYTHON) scripts/test/agent-hooks-refuse-raw-run-read.test.py" \
	$(INTERNAL_SCRIPTS_TESTS) \
	"node --test scripts/test/release-cut.test.mjs" \
	"$(PYTHON) scripts/test/quality-process-selection.test.py" \
	"$(PYTHON) scripts/test/docs-publication-gates.test.py" \
	"bash scripts/test/check-blueprint-governance.test.sh" \
	"bash scripts/test/render-blueprint-components.test.sh" \
	"bash scripts/test/render-benchmark-corpora.test.sh" \
	"bash scripts/test/agent-guidance-size.test.sh" \
	"bash scripts/test/check-workflow-model-tiers.test.sh" \
	"bash scripts/test/check-package-imports.test.sh" \
	"bash scripts/test/check-strip-types-loader.test.sh" \
	"bash scripts/test/testing-strategy-adr.test.sh" \
	"bash scripts/test/check-comparison-model-report.test.sh" \
	"bash scripts/test/export-tree-makefile.test.sh" \
	"python3 scripts/triage-secret-findings.py --check" \
	"$(PYTHON) scripts/test/triage-secret-findings.test.py" \
	"node packages/runtime/scripts/check-limits.mjs --check --committed-only --gate --scope deploy"

scripts-test:
	@if test -n "$(call absent_dirs,scripts deploy)"; then \
		if test -n "$(filter scripts-test,$(MAKECMDGOALS))"; then \
			printf '%s\n' "scripts-test: $(call absent_text,scripts deploy)." >&2; \
			exit 1; \
		fi; \
		printf '%s\n' "scripts-test: $(call absent_text,scripts deploy); skipped as a prerequisite of make $(MAKECMDGOALS)." >&2; \
		exit 0; \
	fi; \
	$(PYTHON) scripts/test/run-parallel.py $(SCRIPTS_TESTS)

orchestration-test:
	@test -n "$(HAVE_SCRIPTS)" || { printf '%s\n' "orchestration-test: scripts/ is not present in this tree." >&2; exit 1; }
	$(MAKE) -C scripts/orchestration test

model-profile-validate:
	@test -n "$(HAVE_SCRIPTS)" || { printf '%s\n' "model-profile-validate: scripts/ is not present in this tree." >&2; exit 1; }
	node scripts/check-por-d05-model-profile-lock.mjs
	node scripts/check-model-profile-candidates.mjs
	node --test scripts/test/check-model-profile-candidates.test.mjs

# Dependency-free provider-comparison state model and its attack suite.
# `node --test` exits 0 on a file that registers zero tests or skips them all,
# so the JUnit report is parsed and the case count asserted; otherwise a
# vacuous suite would pass this gate silently.
comparison-model:
	@test -z "$(call absent_dirs,experiments scripts)" || { printf '%s\n' "comparison-model: $(call absent_text,experiments scripts)." >&2; exit 1; }
	node --check $(COMPARISON_MODEL_DIR)/model.mjs
	node --check $(COMPARISON_MODEL_DIR)/model.test.mjs
	node --test \
		--test-reporter=spec --test-reporter-destination=stdout \
		--test-reporter=junit \
		--test-reporter-destination=$(COMPARISON_MODEL_DIR)/comparison-model-junit.xml \
		$(COMPARISON_MODEL_DIR)/model.test.mjs
	$(COMPARISON_MODEL_PYTHON) scripts/check-comparison-model-report.py \
		$(COMPARISON_MODEL_DIR)/comparison-model-junit.xml \
		--min-cases $(COMPARISON_MODEL_MIN_CASES)

# Offline maintained system benchmark checks. These commands never run a
# provider, and ordinary quality checks do not invoke them.
# Retained product suites load runtime mirrors; the extracted Bench paths load
# their committed local projection, checked against canonical fragments here.
benchmark-validate:
	@test -n "$(HAVE_BENCHMARKS)" || { printf '%s\n' "benchmark-validate: benchmarks/ is not present in this tree." >&2; exit 1; }
	node packages/runtime/scripts/ensure-derived.mjs --steps limits
	node benchmarks/limits/generate.mjs --check
	node benchmarks/runtime-contribution/run/cli.mjs validate
	node benchmarks/docsfab-bench.mjs validate
	node benchmarks/review-delivery/validate.mjs

benchmark-plan:
	@test -n "$(HAVE_BENCHMARKS)" || { printf '%s\n' "benchmark-plan: benchmarks/ is not present in this tree." >&2; exit 1; }
	node benchmarks/runtime-contribution/run/cli.mjs dry-run

# The adapters and reports it tests load the runtime's generated mirrors, so
# the shared generation step runs first.
benchmark-test:
	@test -n "$(HAVE_BENCHMARKS)" || { printf '%s\n' "benchmark-test: benchmarks/ is not present in this tree." >&2; exit 1; }
	node packages/runtime/scripts/ensure-derived.mjs
	node --import ./packages/runtime/node_modules/tsx/dist/esm/index.mjs --test benchmarks/runtime-contribution/adapters/*.test.mjs
	node --test benchmarks/model-support/*.test.mjs
	python3 benchmarks/model-support/report.test.py
	python3 benchmarks/model-support/vault-launch.test.py
	npm --prefix packages/runtime run test:changed -- --paths test/model-matrix-harness.test.ts,test/model-matrix-scheduler.test.ts
	node --test benchmarks/runtime-contribution/run/*.test.mjs
	node --test benchmarks/runtime-contribution/evaluate/format-comparison.test.mjs
	node benchmarks/limits/generate.mjs --check
	node --test benchmarks/limits/*.test.mjs
	node --test benchmarks/contracts/*.test.mjs benchmarks/score/*.test.mjs benchmarks/score/checks/*.test.mjs benchmarks/report/*.test.mjs benchmarks/prepare/*.test.mjs
	node --test benchmarks/portable/*.test.mjs
	node --test benchmarks/judge/*.test.mjs
	node --test benchmarks/stats/*.test.mjs
	node --test benchmarks/cli-diagnostics/*.test.mjs benchmarks/cli-diagnostics/executor/*.test.mjs
	# Offline: an argv-echoing stub docsfab, never a real provider (#1073/#1074).
	node --test benchmarks/local-workflows/setup.test.mjs benchmarks/local-workflows/run.test.mjs benchmarks/local-workflows/lib/*.test.mjs
	node --test benchmarks/dashboard/*.test.mjs
	node --test benchmarks/usage/reader.test.mjs
	node --test benchmarks/review-delivery/validate.test.mjs
	node --test benchmarks/usage/root-cli.test.mjs
	node --test benchmarks/corpus/mining/*.test.mjs benchmarks/corpus/mining/lib/*.test.mjs
	node --test benchmarks/migration/*.test.mjs
	node --test benchmarks/sandbox/*.test.mjs

# Collects benchmark results into one data file and renders a self-contained
# HTML page in the Git-ignored benchmarks/out/dashboard/. DASHBOARD_ARGS passes
# optional collector inputs, and PROGRESS_ARGS the progress page's (such as
# --nightly-dir <dir>); benchmarks/dashboard/README.md lists them.
benchmark-dashboard:
	@test -n "$(HAVE_BENCHMARKS)" || { printf '%s\n' "benchmark-dashboard: benchmarks/ is not present in this tree." >&2; exit 1; }
	node packages/runtime/scripts/ensure-derived.mjs --steps limits
	node benchmarks/dashboard/collect.mjs --out benchmarks/out/dashboard $(DASHBOARD_ARGS)
	node benchmarks/dashboard/render.mjs --data benchmarks/out/dashboard/dashboard-data.json --out benchmarks/out/dashboard/index.html
	node benchmarks/dashboard/progress-cli.mjs --data benchmarks/out/dashboard/dashboard-data.json --out benchmarks/out/dashboard/progress.html $(PROGRESS_ARGS)

# run.test.mjs reaches the expect live-agent driver only on Darwin; Linux uses
# script(1). This check drives lib/live-agent-driver.exp.txt through expect,
# through the same supervisor the runner uses (lib/pty-session.mjs), against
# the stub docsfab: review exercises the "You:" prompt, and restructure also
# the approval prompt. The driver has no timeout of its own. The check lowers
# localWorkflows.idleStallMs for its stub cases (the limit may only be
# lowered), so a prompt pattern that never matches ends within seconds as
# local-e2e-stuck-waiting-for-prompt, with the saved stream in the failure,
# instead of hanging the job. Offline; no provider.
benchmark-expect-driver-test:
	@test -n "$(HAVE_BENCHMARKS)" || { printf '%s\n' "benchmark-expect-driver-test: benchmarks/ is not present in this tree." >&2; exit 1; }
	@command -v expect >/dev/null 2>&1 || { printf '%s\n' "benchmark-expect-driver-test: expect is not on PATH. Install it (Debian: apt-get install expect) and rerun." >&2; exit 1; }
	node packages/runtime/scripts/ensure-derived.mjs --steps limits
	node --test benchmarks/local-workflows/lib/test-support/expect-driver.test.mjs

# Next DocsFab release cut for VERSION, for example 0.0.1.
# release-cut plans, release-cut-apply creates the annotated tag, and
# release-cut-push sends it to origin. A revision that already has a cut for
# that train does not get a second tag; release-cut-push still sends the
# existing tag. Complete post-tag artifact staging with scripts/release-evidence.py
# as documented in scripts/release-evidence/README.md. An evening schedule can run release-cut-push at 19:00
# America/New_York.
release-cut release-cut-apply release-cut-push:
	@test -n "$(HAVE_SCRIPTS)" || { printf '%s\n' "release-cut: scripts/ is not present in this tree." >&2; exit 1; }
	@test -n "$(VERSION)" || { printf '%s\n' "VERSION is required, for example VERSION=0.0.1"; exit 1; }
	git fetch origin main --tags
	node scripts/release-cut.mjs --version "$(VERSION)" --revision "$$(git rev-parse FETCH_HEAD)" \
		$(if $(filter release-cut-apply release-cut-push,$@),--apply,) \
		$(if $(filter release-cut-push,$@),--push,)

smoke: quality-smoke

quality-validate:
	$(MAKE) -C $(QUALITY_DIR) validate

quality-test:
	$(MAKE) -C $(QUALITY_DIR) test

quality-smoke:
	$(MAKE) -C $(QUALITY_DIR) smoke

skills-test:
	$(PYTHON) -m unittest discover -s $(SKILLS_DIR)/tests -v

demo-preview:
	$(MAKE) -C $(QUALITY_DIR) demo-preview

fern-check:
	$(FERN) check

fern-dev:
	$(FERN) docs dev --port $(FERN_PORT)
