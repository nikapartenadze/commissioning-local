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

### Gap 2 — System-under-test image is built by hand — ✅ CLOSED (`build-tool-image` enabled 2026-06-28)
CI only *pulls* `tool:latest`; someone must run `battle/ci/build_and_push.sh`
from a dev box, or **the nightly soaks a stale binary.** The pipelines 622/624
"disk full" failures had a concrete root cause, confirmed 2026-06-27 by SSH to
the runner: the shared **ci-runner (VM 103, `.13`, 60 GB)** had **no docker GC** —
3 projects' images + buildkit cache piled up until `/` hit **99–100%**, an outage
for *all* CI on it (cloud + tracker deploys too), not just battle. **Fixed:** a
tiered, guarded GC systemd timer (`/usr/local/bin/ci-runner-gc.sh` +
`ci-runner-gc.timer`, hourly) — gentle prune ≥80%, removes unused images >24h when
≥95%; age filters never touch an in-flight build. First run took `/` from
**99% → 65%** (~20 GB freed). The runner now self-heals, so the heavy `tool`
build fits in the existing 60 GB **without** a risky disk grow.
**DONE 2026-06-28:** the `build-tool-image` job (§4) now rebuilds+pushes `tool:latest`
+ `plc-sim:latest` on every merge→main, with an `after_script` cleanup + the GC timer
keeping the runner lean. The disk constraint is also gone — the ci-runner FS was grown
to **117 GB (76 GB free)** and the thin pool recovered to **84.6%**. No more hand-pushing.

### Gap 3 — Installer/EXE smoke test — ⚪ OUT OF SCOPE (decided 2026-06-28)
Battle tests the *Docker image*, not the Windows NSIS installer / portable ZIP.
**This is intentional, not a gap.** The thing we validate in CI is *functionality*
— push / pull / sync, multi-MCM, data-safety — and that runs fully in Docker
containers, which is the chosen strategy. Packaging concerns (fresh-install boot,
upgrade-over-existing, `vcruntime140.dll`/`plctag.dll` "os error 126") are handled
out-of-band per release, not gated by CI. No Windows runner is being added.

## 4. Infrastructure: do we need a VM? Is GitLab enough?

- **GitLab is enough** — it already hosts all three repos and runs real CI/CD for
  two. Do not switch platforms.
- **You do NOT need a new VM right now — and you can't safely make one.** The
  Proxmox thin pool `local-lvm` is at **94.4% used** (3.34 TB, ~191 GB free) as of
  2026-06-27 — a 🔴 estate-wide risk (a thin pool hitting 100% can freeze/corrupt
  *every* VM on it). Until it's reclaimed, **do not grow any VM disk or create a
  large new VM.** The `docker-for-stream` cleanup candidate (150 GB) is already gone.
- **The runner disk problem is fixed without more disk** — see Gap 2. The
  ci-runner (`.13`) was hitting 100% purely from un-collected docker garbage; the
  new hourly guarded GC timer keeps it healthy (now 65%/20 GB free), which is
  enough to build the heavy `tool` image **provided the build job cleans up after
  itself** (build → push → `rmi`/`buildx prune`).
- **Order of operations:** (1) **reclaim the thin pool** — the owner's call on what
  to delete (old PBS backup chains, stale VM disks/snapshots, unused volumes); this
  is hard-to-reverse, so it is NOT automated here. (2) *Then*, if the 19-MCM
  `central-cdw5` soak needs more CPU/RAM headroom for fidelity (the I1 perf
  "failures" were partly one host running 19 sims + cloud + tool + bots), grow the
  ci-runner (`qm resize 103 scsi0 +Ng` on pve → `growpart`/`pvresize`/`lvextend`/
  `resize2fs` in the VM) or stand up a dedicated `build-heavy` runner. Both are
  safe only *after* the pool is back under ~80%.

### Auto-build job (Gap 2) — ready to enable

With the GC timer in place, this can run on the **existing** `tracker-ci-dind`
runner (no new VM, no `build-heavy` tag needed) as long as it cleans up. Add to
`.gitlab-ci.yml` (left out until you've watched it run green once so a heavy build
doesn't collide with a cloud/tracker deploy on the shared runner):
```yaml
build-tool-image:
  stage: prebuild
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
  after_script:                  # keep the shared runner lean (Gap 2 root cause)
    - docker rmi "$CI_REGISTRY_IMAGE/tool:latest" "$CI_REGISTRY_IMAGE/plc-sim:latest" || true
    - docker buildx prune -f --filter until=24h || true
  timeout: 60m
```
This replaces the manual `battle/ci/build_and_push.sh` step; the nightly then
always pulls a fresh image. The `after_script` cleanup + the GC timer keep the
60 GB runner from re-accumulating. (Building `central`/`cloud-dev` images can stay
on the branch/dev-box flow or get their own jobs later.)

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
2. ✅ **ci-runner disk-full root cause fixed** — guarded GC timer installed (Gap 2 unblocked).
3. 🔴 **Reclaim the Proxmox thin pool** (94% → <80%) — estate-wide risk; owner-driven
   (decide what's safe to delete). Prerequisite for ANY disk growth.
4. ✅ **`build-tool-image` enabled** (§4) on the existing runner (2026-06-28) → nightly
   soaks the real latest binary, no more hand-pushing. Watch the first merge→main run go green.
5. ⚪ **Gap 3 — installer/EXE smoke** — OUT OF SCOPE by decision (2026-06-28). CI
   validates functionality in Docker (push/pull/sync); Windows packaging is handled
   per-release out-of-band, not in CI. No Windows runner.
6. Per-feature: run `/coverage-keeper`; keep `battle/TEST-COVERAGE.md` honest.
