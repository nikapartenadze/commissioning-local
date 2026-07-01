# Morning Report — overnight CI at a glance

`battle/ci/morning_report.py` aggregates **every overnight automated run** into a
single Markdown + HTML report, so each morning you see what was tested and the
results in one place — instead of opening N per-pipeline GitLab artifact bundles.

## What it aggregates

For GitLab project **24** (`commissioning/commissioning-local`), it walks every
pipeline updated in a lookback window and, for each relevant job, scores it from
the one artifact (or status) that matters:

| Job(s) | How it's scored | Key metrics surfaced |
|---|---|---|
| `nightly-battle`, `central-battle`, `battle-delta`, `battle-smoke` | `battle-artifacts/ci-<scenario>-<pipelineid>/verdict.json` → `pass` + invariants | I1 p95 latency · I4 soak_writes / true_wipes / suspect_silent_drops |
| `battle-e2e` | `battle-artifacts/e2e/results.json` (Playwright JSON reporter) | pass/total, flaky, failing spec titles |
| `frontend-verify`, `build-tool-image`, `refresh-cloud-image` | GitLab job status | pass/fail |

The output:

- a **top banner** — `ALL GREEN` or `N FAILURE(S)`,
- a **per-run table** — suite, verdict, duration, and the key metrics above,
- a **Failures** section — each failing run with its reason (the failed,
  non-report-only invariants and their numbers; or the failing E2E spec titles),
- a **Notes** section — jobs that finished but never wrote a verdict (failed
  early), so a missing artifact never crashes the report,
- links back to the source pipelines/jobs.

It is **stdlib-only** (`urllib`, `json`, `zipfile`, …) so it runs in a bare
`python:3.12-slim` CI image with no `pip install`.

Robustness notes:
- The battle run-dir token (`ci-<scenario>-<pipelineid>`) isn't on the job
  object, so the script probes the known per-job scenarios first, then falls
  back to scanning the job's artifact zip for any `*/verdict.json` — so even
  API-triggered runs with a custom `SCENARIO` resolve.
- Jobs that are still `running` / never started (`manual`/`created`/`skipped`)
  are shown-or-hidden but never counted as failures.

## Run it locally

`gitlab.lci.ge` resolves only on the internal network, so route the call through
the CI runner (or any internal host). The script reads `GL_API` + `GL_TOKEN`
(personal/project token → `PRIVATE-TOKEN` header) for local use, and
`CI_API_V4_URL` + `CI_JOB_TOKEN` (→ `JOB-TOKEN` header) in CI.

```bash
# from a box on the internal network (or on the runner itself):
GL_API=https://gitlab.lci.ge/api/v4 \
GL_TOKEN=<api-scoped-token> \
GL_PROJECT_ID=24 \
LOOKBACK_HOURS=24 \
OUT_DIR=./out \
python3 battle/ci/morning_report.py
# writes ./out/morning-report.md and ./out/morning-report.html,
# echoes the markdown to stdout, exits non-zero if any run failed.
```

To run it from your workstation **through the runner** (the script ships itself
over ssh and executes where gitlab.lci.ge resolves):

```bash
B64=$(base64 -w0 battle/ci/morning_report.py)
ssh -F /path/to/.ssh/config adminuser@192.168.5.13 \
  "echo '$B64' | base64 -d > /tmp/mr.py && \
   GL_API=https://gitlab.lci.ge/api/v4 GL_TOKEN=<tok> GL_PROJECT_ID=24 \
   LOOKBACK_HOURS=24 OUT_DIR=/tmp/mr python3 /tmp/mr.py"
```

CLI overrides: `--hours N`, `--project ID`, `--api URL`, `--out DIR`, and
`--dry-run` (prints the pipelines + artifact paths it WOULD fetch, fetches/writes
nothing).

## Wire the schedule

1. Add the job from `battle/ci/morning-report-ci-snippet.yml` to `.gitlab-ci.yml`
   (a light `python:3.12-slim` job in the `verify` stage; no docker-in-docker).
   Its rule fires on `MORNING_REPORT == "1"` (the schedule) or a manual web run.

2. Create a **separate pipeline schedule** at ~07:00 Asia/Tbilisi carrying the
   `MORNING_REPORT=1` var — after the 02:00 soak and the early delta/e2e/verify
   runs, so the window catches them all:

   ```bash
   # create the schedule
   curl --request POST --header "PRIVATE-TOKEN: <tok>" \
     "https://gitlab.lci.ge/api/v4/projects/24/pipeline_schedules" \
     --form description="Morning CI report (07:00 Tbilisi)" \
     --form ref="main" --form cron="0 7 * * *" \
     --form cron_timezone="Asia/Tbilisi" --form active="true"
   # → note the returned "id"

   # attach the var that selects the morning-report job
   curl --request POST --header "PRIVATE-TOKEN: <tok>" \
     "https://gitlab.lci.ge/api/v4/projects/24/pipeline_schedules/<id>/variables" \
     --form "key=MORNING_REPORT" --form "value=1"
   ```

   (Run these through the runner too if gitlab.lci.ge isn't resolvable locally.)

   `LOOKBACK_HOURS` defaults to 16 in the snippet (07:00 − 16h ≈ 15:00 prior
   day). Bump it if the soak/schedule times move.

## Delivery options

Pick how you want the report to reach you each morning:

- **A — Artifact link (zero setup, recommended to start).** The job publishes
  `battle-artifacts/morning-report.{md,html}` as artifacts. Open the HTML from
  the job's *Browse* button, or bookmark the latest-artifact URL:
  `https://gitlab.lci.ge/commissioning/commissioning-local/-/jobs/artifacts/main/file/battle-artifacts/morning-report.html?job=morning-report`.
  No creds, no extra moving parts.

- **B — Email.** GitLab has no native "email this artifact". Add an SMTP relay
  reachable from the runner and a small notify step that mails
  `morning-report.md`. More setup; only worth it if email is the channel people
  actually read.

- **C — Zulip.** The org runs Zulip at `192.168.5.81`. Post the banner + a link
  to the HTML artifact to a stream via an incoming webhook / bot. **Creds are
  not available yet**, so this is a documented TODO — the snippet has a
  commented `after_script` ready to fill in once `ZULIP_BOT_EMAIL` /
  `ZULIP_API_KEY` exist as masked CI variables.

**Recommendation:** ship **A** now (it works immediately and is the durable
record), and add **C (Zulip)** as the push channel once a bot token + target
stream are provisioned — a one-line banner + artifact link in a `#ci` stream is
the lowest-friction "did anything break overnight?" signal for the team.

## Sample (real data, 24h window, 2026-06-29)

Generated against the real last-24h pipelines (banner showed **7 FAILURE(S)** —
two `battle-e2e` spec failures, a `nightly-battle` I5/I3 fail after PLC flaps, a
`battle-delta` I4 with 7 suspect drops, plus three jobs that failed before
writing a verdict). The full sample is reproduced in the build report; a slice:

```
# Overnight CI — Morning Report

**7 FAILURE(S)** — 22 run(s) in the last 24h. Generated 2026-06-29 ... UTC.
Project: `24` · 45 relevant job(s) across 18 pipeline(s).

| Suite        | Verdict | Duration | Latency  | Data safety (writes/wipes/drops) | E2E              |
|--------------|---------|----------|----------|----------------------------------|------------------|
| battle-delta | PASS    | 39m      | p95 36ms | writes 464 / wipes 0 / drops 0   | -                |
| nightly-battle | FAIL  | 8h03m    | p95 95ms | writes 305 / wipes 0 / drops 0   | -                |
| battle-delta | FAIL    | 36m      | p95 46ms | writes 463 / wipes 0 / drops 7   | -                |
| battle-e2e   | FAIL    | 13m      | -        | -                                | 4/6 pass (+1 flaky) |
| frontend-verify | PASS | 2m       | -        | -                                | -                |
...
### nightly-battle — pipeline #1118
- **I5_stability** — server_starts=2 plc_flaps=7
- **I3_restore_evidence** — injected_downloads=14, reconnect_restores_seen=1
### battle-delta — pipeline #1114
- **I4_no_data_loss** — true_wipes=0 suspect_silent_drops=7 divergence=0 pending_at_end=0
```
