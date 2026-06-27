# CI/CD & Test Strategy — workspace-wide

Status of automated testing, simulation, and CI/CD across the three apps, the
real gaps, and the plan to close them. Written 2026-06-26 from a cross-repo
audit. Companion to `battle/TEST-COVERAGE.md` (the field-tool coverage matrix)
and `docs/BATTLE-TEST-PLAN.md` (the chaos-rig design).

> **TL;DR.** Two of three apps already have textbook CI/CD with blocking tests
> and auto-deploy. The field tool has the *most* sophisticated test infra of all
> — the `battle/` chaos rig already simulates a central server + all 19 MCMs +
> the cloud + terrible-internet chaos, syncing both ways, nightly. The gaps are
> **wiring and coverage**, not capability.

---

## 1. Scorecard

| | commissioning-cloud | installation-tracker | **commissioning-local (field tool)** |
|---|---|---|---|
| CI platform | GitLab CI | GitLab CI | GitLab CI (GitHub = releases) |
| Unit tests | 24 files / ~249 | 9 files / ~60 | **56 files / 503** |
| Tests run in CI? | ✅ blocking | ✅ blocking | ✅ **as of this change** (was ❌) |
| Lint / typecheck gate | ✅ advisory | ✅ | ✅ advisory (this change) |
| Build on commit | ✅ SHA-tagged | ✅ SHA-tagged | ⚠️ **hand-pushed** (see Gap 2) |
| Auto-deploy + rollback | ✅ health-gated | ✅ health-gated | N/A (ships as Windows EXE) |
| Schema-guard | ✅ | ✅ | N/A |
| Chaos / soak testing | ❌ | ❌ | ✅ **battle rig (I1–I13)** |

Cloud & tracker: `verify (lint/typecheck advisory, test BLOCKING, schema-guard)
→ build (Docker, SHA-tag) → deploy (SSH, pre-deploy pg_dump, /api/health gate,
auto-rollback)`. Shared Postgres ⇒ `schema-guard` blocks deploy when
`prisma/schema.prisma` drifts from a blessed sha256 (manual `prisma db push`,
no migration files).

## 2. What the battle rig already covers (field tool)

Real shipped tool image + real field data (MCM02: 1,184 IOs / 72 VFDs; full
19-MCM CDW5 dump: 25,418 IOs) → simulated technician bots → injected chaos →
external observer → PASS/FAIL `verdict.json` that **gates the nightly**.

- **Central server / all MCMs:** `central`, `central-cdw5`, `central-cdw5-split`
  run 4 → 19 MCMs, each with its own PLC sim, plus the cloud app + throwaway
  Postgres, syncing both directions.
- **Terrible internet, every flavor:** cloud flap (`cloudcut`), PLC power loss,
  program-download storms, CIP saturation, tool crash/restart — often all at once.
- **Gated invariants (I1–I13):** responsiveness, no-leak, no-data-loss,
  flag/polarity restore, propagation, SSE-auth, bounded backups.
- Already caught real shipping-blockers: the v2.40.1 freeze, the B1 HTTP-429
  silent drop, the parked-row pull deadlock, the delta-sync cold-start gap.

See `battle/TEST-COVERAGE.md` for the situation→covered matrix and `battle/FINDINGS.md`
for the incident→coverage matrix and run log.

## 3. The three real gaps

### Gap 1 — Field tool had no fast CI gate — ✅ CLOSED (this change)
Its 503 vitest tests, lint, and typecheck ran only on a dev laptop. Now wired as
the `frontend-verify` job (`.gitlab-ci.yml`, `verify` stage): `npm test` is the
hard gate; lint + typecheck advisory. Plain Node job (no DinD) so it doesn't hit
the runner disk limit. Runs on every push / MR.

### Gap 2 — System-under-test image is built by hand — ⛔ OPEN (needs §4)
CI only *pulls* `tool:latest`; the shared `tracker-ci-dind` runner's DinD disk is
too small to build it (pipelines 622/624 died on `/var/cache/apt`). So someone
must run `battle/ci/build_and_push.sh` from a dev box, or **the nightly soaks a
stale binary.** Fixed by adding a disk-rich runner (§4) + an auto-build job.

### Gap 3 — Nothing tests the shipped installer/EXE — ⛔ OPEN (BLOCKER)
Battle tests the *Docker image*, never the Windows NSIS installer / portable ZIP.
Fresh-install boot, upgrade-over-existing with schema migration, and the
`vcruntime140.dll`/`plctag.dll` "os error 126" class are all untested on the
artifact that actually lands on tablets. This is the standing biggest gap in
`battle/TEST-COVERAGE.md` §F. Needs a Windows runner + a smoke checklist
(install → boot → connect a PLC sim → upgrade-over-existing → data preserved).

## 4. Infrastructure: do we need a VM? Is GitLab enough?

- **GitLab is enough** — it already hosts all three repos and runs real CI/CD for
  two. Do not switch platforms.
- **The single shared `tracker-ci-dind` runner (runner 10) is NOT enough** — it's
  disk-constrained (can't build heavy images) and shared with two apps' deploys,
  so long soaks must run off-hours to avoid colliding with work-hours builds.
- **Add ONE disk + CPU-rich GitLab runner VM** for two jobs: (a) auto-build the
  heavy `tool`/`plc-sim` images on merge → main (kills Gap 2), and (b) run the
  19-MCM `central-cdw5` soaks with headroom — the I1 perf "failures" were partly
  one laptop running 19 sims + cloud + tool + bots, so a beefier host also
  *improves fidelity*.

### Runner VM runbook

**Sizing:** ~8 vCPU / 16 GB RAM / **200 GB disk** (heavy multi-stage Docker
builds + a 19-MCM soak that spins up 19 sims + cloud + tool concurrently).
Could also register on the existing disk-rich `dockerhost`/`dh1`, but isolate it
(separate runner, concurrency caps) so CI builds never contend with prod.

**Register** (docker executor, privileged for DinD), tagged so only heavy jobs
target it:
```sh
gitlab-runner register \
  --url https://gitlab.lci.ge --registration-token <project-or-group-token> \
  --executor docker --docker-image docker:27 --docker-privileged \
  --tag-list build-heavy --description "build-soak-vm" --locked=false
```

**Then add the auto-build job** to `.gitlab-ci.yml` (kept out for now — it would
hang with no runner to pick up the `build-heavy` tag). Copy-paste once the VM is
registered:
```yaml
build-tool-image:
  stage: prebuild
  tags: [build-heavy]            # only the disk-rich VM
  image: docker:27
  services: [docker:27-dind]
  variables: { DOCKER_TLS_CERTDIR: "/certs" }
  rules:
    - if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main"'
  before_script:
    - docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"
  script:
    - docker build -t "$CI_REGISTRY_IMAGE/tool:latest" -f frontend/Dockerfile frontend
    - docker push "$CI_REGISTRY_IMAGE/tool:latest"
    - docker build -t "$CI_REGISTRY_IMAGE/plc-sim:latest" battle/plc-sim
    - docker push "$CI_REGISTRY_IMAGE/plc-sim:latest"
  timeout: 60m
```
This replaces the manual `battle/ci/build_and_push.sh` step; the nightly then
always pulls a fresh image. (Building `central`/`cloud-dev` images can stay on
the branch/dev-box flow or get their own tagged jobs later.)

## 5. Keeping coverage in step — the `coverage-keeper` skill

`.claude/skills/coverage-keeper/SKILL.md` — run after any feature on the field
tool, cloud, or tracker, before merging. It diffs the branch, classifies the
change by contract (sync / data-safety / PLC / multi-MCM / L2-FV / estop / auth /
schema), routes each to the right surface (unit test / battle scenario+invariant /
schema-guard re-bless / honest manual-only note), runs the suites, and reports
three buckets: now-covered / pending / not-covered-by-CI. Invoke with
`/coverage-keeper`.

## 6. Rollout order

1. ✅ **Gap 1 — `frontend-verify` CI gate** (done; watch the first GitLab run go green).
2. **Runner VM** (§4) → add `build-tool-image` → nightly soaks the real latest binary.
3. **Gap 3 — installer/EXE smoke** (Windows runner + checklist) — the BLOCKER before
   any site deploy; see `battle/TEST-COVERAGE.md` §F and Part 3.
4. Per-feature: run `/coverage-keeper`; keep `battle/TEST-COVERAGE.md` honest.
