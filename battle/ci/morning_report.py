#!/usr/bin/env python3
"""
morning_report.py — aggregate ALL overnight commissioning-local CI runs into ONE
readable report (Markdown + HTML).

Today the verdicts of the nightly battle soak, the delta/smoke/central runs, the
Playwright E2E job and the frontend-verify unit suite each live inside their own
per-pipeline GitLab artifact bundle. This script walks the pipelines updated in a
lookback window, pulls the one key artifact from each relevant job (verdict.json
for the battle family, the Playwright results.json for E2E), reads the GitLab job
status for everything else, and emits a single skimmable report:

  - a top banner (ALL GREEN / N FAILURES),
  - a per-run table (suite, verdict, duration, the key metrics that matter:
    I1 p95 latency, I4 soak_writes / true_wipes / suspect_drops, E2E pass/total),
  - the failing items called out with their reason,
  - links back to the source pipelines + jobs.

Stdlib only (urllib, json, os, sys, datetime, html) — it runs in a minimal CI
python image with no pip install.

Configuration (env, with CLI overrides):
  CI_API_V4_URL / GL_API     GitLab API base, e.g. https://gitlab.lci.ge/api/v4
  CI_JOB_TOKEN  / GL_TOKEN    API token. CI_JOB_TOKEN uses the JOB-TOKEN header;
                              a personal/project token (GL_TOKEN) uses PRIVATE-TOKEN.
  GL_PROJECT_ID              project id (default 24 = commissioning/commissioning-local)
  LOOKBACK_HOURS             window in hours (default 16)
  OUT_DIR                    output dir (default battle-artifacts)

CLI:
  --hours N            override lookback window
  --project ID         override project id
  --api URL            override API base
  --out DIR            override output dir
  --dry-run            print what WOULD be fetched, fetch nothing, write nothing
"""

import os
import io
import sys
import json
import html
import zipfile
import datetime as dt
import urllib.request
import urllib.parse
import urllib.error

# ── job name → "kind" classification ─────────────────────────────────────────
# Battle-family jobs publish a verdict.json; battle-e2e publishes a Playwright
# results.json; everything else we score from the GitLab job status alone.
BATTLE_JOBS = {"nightly-battle", "central-battle", "battle-delta", "battle-smoke"}
E2E_JOBS = {"battle-e2e"}
STATUS_JOBS = {"frontend-verify", "build-tool-image", "refresh-cloud-image"}
# The set of jobs we report on (others — e.g. the morning-report job itself — skip).
RELEVANT_JOBS = BATTLE_JOBS | E2E_JOBS | STATUS_JOBS

DEFAULT_PROJECT = "24"
DEFAULT_HOURS = 16


# ── tiny HTTP layer (stdlib) ─────────────────────────────────────────────────
class GitLab:
    def __init__(self, api_base, token, token_header):
        self.api = api_base.rstrip("/")
        self.token = token
        self.token_header = token_header  # "JOB-TOKEN" or "PRIVATE-TOKEN"

    def _req(self, url, raw=False):
        req = urllib.request.Request(url)
        if self.token:
            req.add_header(self.token_header, self.token)
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
        return data if raw else json.loads(data.decode("utf-8"))

    def pipelines(self, project, updated_after_iso):
        # paginate; the window is small (one night) so a couple of pages is plenty.
        out = []
        page = 1
        while True:
            q = urllib.parse.urlencode(
                {
                    "updated_after": updated_after_iso,
                    "per_page": 50,
                    "page": page,
                    "order_by": "updated_at",
                    "sort": "desc",
                }
            )
            url = f"{self.api}/projects/{project}/pipelines?{q}"
            batch = self._req(url)
            if not batch:
                break
            out.extend(batch)
            if len(batch) < 50 or page >= 10:
                break
            page += 1
        return out

    def jobs(self, project, pipeline_id):
        url = f"{self.api}/projects/{project}/pipelines/{pipeline_id}/jobs?per_page=100"
        return self._req(url)

    def artifact_file(self, project, job_id, path):
        """Fetch a single file from a job's artifact archive. Returns bytes or None."""
        url = f"{self.api}/projects/{project}/jobs/{job_id}/artifacts/{path}"
        try:
            return self._req(url, raw=True)
        except urllib.error.HTTPError as e:
            if e.code in (404, 403):
                return None
            raise

    def find_in_archive(self, project, job_id, suffix):
        """Last-resort: download the job's artifact zip and return the bytes of the
        first member whose path ends with `suffix`. Heavier than artifact_file but
        works when the in-archive path isn't known (e.g. an unguessable run-dir
        token). Returns bytes or None."""
        url = f"{self.api}/projects/{project}/jobs/{job_id}/artifacts"
        try:
            raw = self._req(url, raw=True)
        except urllib.error.HTTPError as e:
            if e.code in (404, 403):
                return None
            raise
        try:
            zf = zipfile.ZipFile(io.BytesIO(raw))
        except zipfile.BadZipFile:
            return None
        for name in zf.namelist():
            if name.endswith(suffix):
                return zf.read(name)
        return None


# ── data extraction ──────────────────────────────────────────────────────────
def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def fetch_battle_verdict(gl, project, job, pipeline_id):
    """Battle jobs write battle-artifacts/ci-<scenario>-<pipelineid>/verdict.json.
    The <scenario> token isn't on the job object, so probe the known run-dir names."""
    name = job["name"]
    # The run-dir token is RUN_ID="ci-<SCENARIO>-<pipelineid>" (battle/ci/
    # run_scenario.sh) and SCENARIO isn't on the job object, so try the known
    # per-job scenarios cheaply first…
    scenario_hints = {
        "battle-delta": ["delta"],
        "battle-smoke": ["s2", "all", "smoke"],
        "nightly-battle": ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "all", "mutate", "central"],
        "central-battle": ["central-cdw5-split", "central-cdw5", "central"],
    }.get(name, [])
    candidates = [f"battle-artifacts/ci-{s}-{pipeline_id}/verdict.json" for s in scenario_hints]
    candidates.append("battle-artifacts/verdict.json")  # flat fallback
    for path in candidates:
        raw = gl.artifact_file(project, job["id"], path)
        if raw:
            try:
                return json.loads(raw.decode("utf-8")), path
            except (ValueError, UnicodeDecodeError):
                continue
    # …then fall back to scanning the artifact archive for any */verdict.json
    # (covers custom/api-triggered scenarios with an unguessable run-dir token).
    raw = gl.find_in_archive(project, job["id"], "/verdict.json")
    if raw:
        try:
            return json.loads(raw.decode("utf-8")), "battle-artifacts/<run>/verdict.json"
        except (ValueError, UnicodeDecodeError):
            pass
    return None, None


def fetch_e2e_results(gl, project, job):
    raw = gl.artifact_file(project, job["id"], "battle-artifacts/e2e/results.json")
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def summarize_e2e(results):
    """Flatten Playwright JSON report → {expected,unexpected,flaky,skipped,total,
    failing:[titles]}."""
    stats = results.get("stats", {}) or {}
    failing = []

    def walk(suites):
        for s in suites or []:
            for sp in s.get("specs", []) or []:
                if sp.get("ok") is False:
                    failing.append(sp.get("title", "?"))
            walk(s.get("suites"))

    walk(results.get("suites"))
    expected = int(stats.get("expected", 0) or 0)
    unexpected = int(stats.get("unexpected", 0) or 0)
    flaky = int(stats.get("flaky", 0) or 0)
    skipped = int(stats.get("skipped", 0) or 0)
    total = expected + unexpected + flaky + skipped
    return {
        "expected": expected,
        "unexpected": unexpected,
        "flaky": flaky,
        "skipped": skipped,
        "total": total,
        "pass": expected + flaky,  # flaky passed on retry
        "failing": failing,
        "duration_s": _num(stats.get("duration")),
    }


def battle_failures(verdict):
    """Return list of (invariant, reason) for invariants that FAILED and are not
    report-only."""
    report_only = set(verdict.get("report_only", []) or [])
    out = []
    for inv, body in (verdict.get("invariants", {}) or {}).items():
        if not isinstance(body, dict):
            continue
        if body.get("pass") is False and inv not in report_only:
            out.append((inv, _reason_for(inv, body)))
    return out


def _reason_for(inv, body):
    """Human one-liner for a failed invariant, picking the metric that matters."""
    if inv == "I1_responsiveness":
        return (
            f"p95={_fmt_ms(body.get('p95'))} p99={_fmt_ms(body.get('p99'))} "
            f"max={_fmt_ms(body.get('max'))} gaps>10s={body.get('gaps_over_10s')}"
        )
    if inv == "I2_no_leak":
        return f"rss_slope={body.get('rss_slope_mb_per_h')} MB/h ({body.get('rss_samples')} samples)"
    if inv == "I4_no_data_loss":
        return (
            f"true_wipes={body.get('true_wipes')} "
            f"suspect_silent_drops={body.get('suspect_silent_drops')} "
            f"divergence={body.get('divergence_lww_or_business')} "
            f"pending_at_end={body.get('pending_queue_at_end')}"
        )
    if inv in ("I7_cloud_propagation", "I11_delta_propagation"):
        return (
            f"cloud_added={body.get('cloud_added')} "
            f"not_propagated={body.get('not_propagated_to_local')}"
        )
    if inv == "I12_delete_propagation":
        return (
            f"cloud_deleted={body.get('cloud_deleted')} "
            f"still_present_unguarded={body.get('still_present_unguarded')}"
        )
    if inv == "I5_stability":
        return f"server_starts={body.get('server_starts')} plc_flaps={body.get('plc_flaps')}"
    if inv == "I8_live_channel":
        return f"auth_failures={body.get('auth_failures_401_403')} note={body.get('note')}"
    if inv == "I9_backup_bound":
        return f"created={body.get('created')} total_mb={body.get('total_mb')}"
    # generic
    bits = [f"{k}={v}" for k, v in body.items() if k != "pass" and not isinstance(v, (list, dict))]
    return ", ".join(bits[:4]) if bits else "failed"


def _fmt_ms(v):
    n = _num(v)
    if n is None:
        return "-"
    return f"{n:.0f}ms" if n >= 10 else f"{n:.1f}ms"


# ── per-run record ────────────────────────────────────────────────────────────
class RunRow:
    """One row in the report — a relevant job in a pipeline."""

    def __init__(self, job, pipeline):
        self.job = job
        self.pipeline = pipeline
        self.name = job["name"]
        self.job_status = job["status"]  # success/failed/canceled/skipped/...
        self.duration_s = _num(job.get("duration"))
        self.verdict = None
        self.verdict_path = None
        self.e2e = None
        self.note = ""

    # The single source of truth for the row's pass/fail.
    @property
    def passed(self):
        if self.verdict is not None:
            return bool(self.verdict.get("pass"))
        if self.e2e is not None:
            return self.e2e["unexpected"] == 0
        # status-only job
        return self.job_status == "success"

    @property
    def finished(self):
        """Did the job reach a terminal state? A still-running or never-started job
        has no result to report on yet."""
        return self.job_status in ("success", "failed")

    @property
    def counted(self):
        """Does this row count toward GREEN/RED? Only finished jobs are an overnight
        result; manual/created/running/skipped/canceled are not."""
        return self.finished

    @property
    def shown(self):
        """Show in the runs table? Finished jobs and currently-running ones are
        interesting; jobs that never started (manual/created/skipped) are not — they
        just mirror the pipeline's job list and bury the real results."""
        return self.finished or self.job_status == "running"

    @property
    def kind(self):
        if self.name in BATTLE_JOBS:
            return "battle"
        if self.name in E2E_JOBS:
            return "e2e"
        return "status"

    def metrics_cells(self):
        """(latency, data_safety, e2e) short strings for the table."""
        if self.verdict is not None:
            inv = self.verdict.get("invariants", {}) or {}
            i1 = inv.get("I1_responsiveness", {}) or {}
            i4 = inv.get("I4_no_data_loss", {}) or {}
            lat = f"p95 {_fmt_ms(i1.get('p95'))}" if i1 else "-"
            ds = (
                f"writes {i4.get('soak_writes', '-')} / wipes {i4.get('true_wipes', '-')} "
                f"/ drops {i4.get('suspect_silent_drops', '-')}"
                if i4
                else "-"
            )
            return lat, ds, "-"
        if self.e2e is not None:
            e = self.e2e
            extra = f" (+{e['flaky']} flaky)" if e["flaky"] else ""
            return "-", "-", f"{e['pass']}/{e['total']} pass{extra}"
        return "-", "-", "-"

    def web_url(self):
        return self.job.get("web_url") or self.pipeline.get("web_url", "")


# ── report assembly ──────────────────────────────────────────────────────────
def build_rows(gl, project, pipelines, dry_run):
    rows = []
    for pl in pipelines:
        # We only care about pipelines that contain a relevant job.
        try:
            jobs = gl.jobs(project, pl["id"]) if not dry_run else _dry_jobs(pl)
        except urllib.error.HTTPError as e:
            print(f"  ! pipeline {pl['id']}: jobs fetch failed ({e.code})", file=sys.stderr)
            continue
        for job in jobs:
            if job["name"] not in RELEVANT_JOBS:
                continue
            row = RunRow(job, pl)
            if dry_run:
                rows.append(row)
                continue
            # Only finished jobs have an artifact worth fetching. A running job is
            # shown (so you see it's still going) but we don't probe / note it.
            if not row.finished:
                rows.append(row)
                continue
            if row.kind == "battle":
                verdict, path = fetch_battle_verdict(gl, project, job, pl["id"])
                if verdict is not None:
                    row.verdict = verdict
                    row.verdict_path = path
                else:
                    row.note = "no verdict.json (job did not reach verdict)"
            elif row.kind == "e2e":
                results = fetch_e2e_results(gl, project, job)
                if results is not None:
                    row.e2e = summarize_e2e(results)
                else:
                    row.note = "no Playwright results.json"
            rows.append(row)
    # newest pipeline first, then by job name
    rows.sort(key=lambda r: (r.pipeline.get("updated_at", ""), r.name), reverse=True)
    return rows


def _dry_jobs(pl):
    # In dry-run we don't hit /jobs; synthesize a placeholder so --dry-run prints
    # the pipelines and the artifact paths it WOULD probe.
    return []


def _fmt_dur(s):
    if s is None:
        return "-"
    s = int(s)
    if s < 90:
        return f"{s}s"
    m = s // 60
    if m < 90:
        return f"{m}m"
    return f"{m // 60}h{m % 60:02d}m"


def _short_dt(iso):
    if not iso:
        return "-"
    try:
        d = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return d.strftime("%m-%d %H:%M")
    except ValueError:
        return iso


def render_markdown(rows, meta):
    counted = [r for r in rows if r.counted]
    failures = [r for r in counted if not r.passed]
    green = len(failures) == 0
    banner = "ALL GREEN" if green else f"{len(failures)} FAILURE(S)"

    L = []
    L.append("# Overnight CI — Morning Report")
    L.append("")
    L.append(f"**{banner}** — {len(counted)} run(s) in the last {meta['hours']}h "
             f"(window since {meta['since']} UTC). Generated {meta['generated']} UTC.")
    L.append("")
    L.append(f"Project: `{meta['project']}` · {len(rows)} relevant job(s) across "
             f"{meta['n_pipelines']} pipeline(s).")
    L.append("")

    # Per-run table
    L.append("## Runs")
    L.append("")
    L.append("| Suite | Verdict | Duration | Latency | Data safety (writes/wipes/drops) | E2E | Pipeline |")
    L.append("|---|---|---|---|---|---|---|")
    shown_rows = [r for r in rows if r.shown]
    for r in shown_rows:
        verdict = _verdict_label_md(r)
        lat, ds, e2e = r.metrics_cells()
        pid = r.pipeline.get("id")
        url = r.web_url()
        plink = f"[#{pid}]({url})" if url else f"#{pid}"
        suite = r.name + (f" ({r.pipeline.get('ref')})" if r.pipeline.get("ref") not in (None, "main") else "")
        L.append(f"| {suite} | {verdict} | {_fmt_dur(r.duration_s)} | {lat} | {ds} | {e2e} | {plink} |")
    L.append("")

    # Failures called out
    L.append("## Failures")
    L.append("")
    if green:
        L.append("_None. Every counted run passed._")
    else:
        for r in failures:
            pid = r.pipeline.get("id")
            L.append(f"### {r.name} — pipeline #{pid}  ({_short_dt(r.pipeline.get('updated_at'))})")
            L.append(f"- source: `{r.pipeline.get('source')}` · ref `{r.pipeline.get('ref')}` · {r.web_url()}")
            if r.verdict is not None:
                fails = battle_failures(r.verdict)
                if fails:
                    for inv, reason in fails:
                        L.append(f"- **{inv}** — {reason}")
                else:
                    L.append("- verdict.pass=false but no non-report-only invariant flagged "
                             "(check report-only invariants / run log)")
                ro = r.verdict.get("report_only") or []
                if ro:
                    L.append(f"- _report-only this run (not gating): {', '.join(ro)}_")
            elif r.e2e is not None:
                e = r.e2e
                L.append(f"- {e['unexpected']} spec(s) failed of {e['total']} "
                         f"({e['pass']} pass, {e['flaky']} flaky, {e['skipped']} skipped):")
                for t in e["failing"]:
                    L.append(f"  - {t}")
            else:
                L.append(f"- job status `{r.job_status}`"
                         + (f" — {r.note}" if r.note else ""))
            L.append("")

    # Notes (missing artifacts etc.)
    noted = [r for r in rows if r.note]
    if noted:
        L.append("## Notes")
        L.append("")
        for r in noted:
            L.append(f"- {r.name} (pipeline #{r.pipeline.get('id')}): {r.note}")
        L.append("")

    L.append("---")
    L.append(f"_Source: GitLab project {meta['project']} · "
             f"`battle/ci/morning_report.py` · stdlib-only._")
    return "\n".join(L) + "\n"


def _verdict_label_md(r):
    if not r.counted:
        return f"_{r.job_status}_"
    return "PASS" if r.passed else "**FAIL**"


# ── HTML rendering (self-contained, inline CSS) ──────────────────────────────
HTML_CSS = """
:root{--ok:#1a7f37;--bad:#cf222e;--muted:#57606a;--bg:#fff;--line:#d0d7de;--head:#f6f8fa}
*{box-sizing:border-box}
body{font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2328;margin:0;background:#fff}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:24px;margin:0 0 4px}
h2{font-size:17px;margin:32px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
h3{font-size:15px;margin:20px 0 6px}
.banner{display:inline-block;font-weight:700;font-size:15px;padding:8px 16px;border-radius:8px;color:#fff;margin:10px 0}
.banner.ok{background:var(--ok)}.banner.bad{background:var(--bad)}
.sub{color:var(--muted);margin:4px 0}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;min-width:760px;font-size:13px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
th{background:var(--head);font-weight:600;position:sticky;top:0}
tr:last-child td{border-bottom:none}
.pass{color:var(--ok);font-weight:700}.fail{color:var(--bad);font-weight:700}
.skip{color:var(--muted);font-style:italic}
.metric{font-variant-numeric:tabular-nums;color:#1f2328}
a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
.failcard{border:1px solid var(--line);border-left:4px solid var(--bad);border-radius:6px;padding:10px 14px;margin:10px 0;background:#fff6f6}
.failcard ul{margin:6px 0 0 18px;padding:0}
.failcard .meta{color:var(--muted);font-size:12px}
code{background:var(--head);padding:1px 5px;border-radius:4px;font-size:12px}
.note{color:var(--muted);font-size:13px;margin:3px 0}
footer{color:var(--muted);font-size:12px;margin-top:36px;border-top:1px solid var(--line);padding-top:10px}
"""


def render_html(rows, meta):
    counted = [r for r in rows if r.counted]
    failures = [r for r in counted if not r.passed]
    green = len(failures) == 0
    e = html.escape

    P = []
    P.append('<div class="wrap">')
    P.append("<h1>Overnight CI — Morning Report</h1>")
    bcls = "ok" if green else "bad"
    btxt = "ALL GREEN" if green else f"{len(failures)} FAILURE(S)"
    P.append(f'<div class="banner {bcls}">{btxt}</div>')
    P.append(f'<p class="sub">{len(counted)} run(s) in the last {meta["hours"]}h '
             f'(window since {e(meta["since"])} UTC). Generated {e(meta["generated"])} UTC.</p>')
    P.append(f'<p class="sub">Project <code>{e(str(meta["project"]))}</code> · '
             f'{len(rows)} relevant job(s) across {meta["n_pipelines"]} pipeline(s).</p>')

    # table
    P.append("<h2>Runs</h2>")
    P.append('<div class="tablewrap"><table>')
    P.append("<thead><tr>"
             "<th>Suite</th><th>Verdict</th><th>Duration</th><th>Latency</th>"
             "<th>Data safety (writes / wipes / drops)</th><th>E2E</th><th>Pipeline</th>"
             "</tr></thead><tbody>")
    for r in [r for r in rows if r.shown]:
        lat, ds, e2e = r.metrics_cells()
        if not r.counted:
            vcell = f'<span class="skip">{e(r.job_status)}</span>'
        elif r.passed:
            vcell = '<span class="pass">PASS</span>'
        else:
            vcell = '<span class="fail">FAIL</span>'
        pid = r.pipeline.get("id")
        url = r.web_url()
        plink = f'<a href="{e(url)}">#{pid}</a>' if url else f"#{pid}"
        ref = r.pipeline.get("ref")
        suite = e(r.name) + (f' <span class="note">({e(ref)})</span>' if ref not in (None, "main") else "")
        P.append("<tr>"
                 f"<td>{suite}</td><td>{vcell}</td><td class='metric'>{e(_fmt_dur(r.duration_s))}</td>"
                 f"<td class='metric'>{e(lat)}</td><td class='metric'>{e(ds)}</td>"
                 f"<td class='metric'>{e(e2e)}</td><td>{plink}</td></tr>")
    P.append("</tbody></table></div>")

    # failures
    P.append("<h2>Failures</h2>")
    if green:
        P.append('<p class="note">None. Every counted run passed.</p>')
    else:
        for r in failures:
            pid = r.pipeline.get("id")
            P.append('<div class="failcard">')
            P.append(f"<h3>{e(r.name)} — pipeline #{pid}</h3>")
            P.append(f'<div class="meta">source <code>{e(str(r.pipeline.get("source")))}</code> · '
                     f'ref <code>{e(str(r.pipeline.get("ref")))}</code> · '
                     f'{_short_dt(r.pipeline.get("updated_at"))} · '
                     f'<a href="{e(r.web_url())}">open</a></div>')
            P.append("<ul>")
            if r.verdict is not None:
                fails = battle_failures(r.verdict)
                if fails:
                    for inv, reason in fails:
                        P.append(f"<li><b>{e(inv)}</b> — {e(reason)}</li>")
                else:
                    P.append("<li>verdict.pass=false but no non-report-only invariant flagged</li>")
                ro = r.verdict.get("report_only") or []
                if ro:
                    P.append(f'<li class="note">report-only this run (not gating): {e(", ".join(ro))}</li>')
            elif r.e2e is not None:
                ee = r.e2e
                P.append(f"<li>{ee['unexpected']} spec(s) failed of {ee['total']} "
                         f"({ee['pass']} pass, {ee['flaky']} flaky, {ee['skipped']} skipped):</li>")
                for t in ee["failing"]:
                    P.append(f"<li>&nbsp;&nbsp;{e(t)}</li>")
            else:
                P.append(f"<li>job status <code>{e(r.job_status)}</code>"
                         + (f" — {e(r.note)}" if r.note else "") + "</li>")
            P.append("</ul></div>")

    noted = [r for r in rows if r.note]
    if noted:
        P.append("<h2>Notes</h2>")
        for r in noted:
            P.append(f'<p class="note">{e(r.name)} (pipeline #{r.pipeline.get("id")}): {e(r.note)}</p>')

    P.append(f'<footer>Source: GitLab project {e(str(meta["project"]))} · '
             f'<code>battle/ci/morning_report.py</code> · stdlib-only.</footer>')
    P.append("</div>")
    body = "\n".join(P)
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>Morning Report — {e(meta['generated'])}</title>"
        f"<style>{HTML_CSS}</style></head><body>{body}</body></html>\n"
    )


# ── config + main ─────────────────────────────────────────────────────────────
def resolve_config(argv):
    api = os.environ.get("CI_API_V4_URL") or os.environ.get("GL_API")
    # token: prefer CI_JOB_TOKEN (job-scoped) → JOB-TOKEN header; else GL_TOKEN.
    token = os.environ.get("CI_JOB_TOKEN")
    token_header = "JOB-TOKEN"
    if not token:
        token = os.environ.get("GL_TOKEN")
        token_header = "PRIVATE-TOKEN"
    project = os.environ.get("GL_PROJECT_ID") or os.environ.get("CI_PROJECT_ID") or DEFAULT_PROJECT
    hours = int(os.environ.get("LOOKBACK_HOURS") or DEFAULT_HOURS)
    out_dir = os.environ.get("OUT_DIR") or "battle-artifacts"
    dry_run = False

    it = iter(argv)
    for a in it:
        if a == "--hours":
            hours = int(next(it))
        elif a == "--project":
            project = next(it)
        elif a == "--api":
            api = next(it)
        elif a == "--out":
            out_dir = next(it)
        elif a == "--dry-run":
            dry_run = True
        elif a in ("-h", "--help"):
            print(__doc__)
            sys.exit(0)
    return {
        "api": api,
        "token": token,
        "token_header": token_header,
        "project": project,
        "hours": hours,
        "out_dir": out_dir,
        "dry_run": dry_run,
    }


def main(argv):
    cfg = resolve_config(argv)
    if not cfg["api"]:
        print("ERROR: set CI_API_V4_URL or GL_API (e.g. https://gitlab.lci.ge/api/v4)",
              file=sys.stderr)
        return 2

    now = dt.datetime.now(dt.timezone.utc)
    since = now - dt.timedelta(hours=cfg["hours"])
    since_iso = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    meta = {
        "project": cfg["project"],
        "hours": cfg["hours"],
        "since": since_iso,
        "generated": now.strftime("%Y-%m-%d %H:%M:%S"),
    }

    gl = GitLab(cfg["api"], cfg["token"], cfg["token_header"])

    print(f"Fetching pipelines for project {cfg['project']} since {since_iso} "
          f"({cfg['hours']}h window)...", file=sys.stderr)
    pipelines = gl.pipelines(cfg["project"], since_iso)
    print(f"  {len(pipelines)} pipeline(s) in window.", file=sys.stderr)
    meta["n_pipelines"] = len(pipelines)

    if cfg["dry_run"]:
        print("\n[DRY RUN] would inspect these pipelines and fetch their relevant artifacts:")
        for pl in pipelines:
            print(f"  pipeline #{pl['id']} {pl.get('ref')} {pl.get('status')} "
                  f"src={pl.get('source')} {pl.get('updated_at')}")
            print(f"    GET /projects/{cfg['project']}/pipelines/{pl['id']}/jobs")
            print(f"    for battle jobs: GET .../jobs/<id>/artifacts/"
                  f"battle-artifacts/ci-<scenario>-{pl['id']}/verdict.json")
            print(f"    for battle-e2e:  GET .../jobs/<id>/artifacts/"
                  f"battle-artifacts/e2e/results.json")
        return 0

    rows = build_rows(gl, cfg["project"], pipelines, dry_run=False)
    print(f"  {len(rows)} relevant job row(s).", file=sys.stderr)

    md = render_markdown(rows, meta)
    html_doc = render_html(rows, meta)

    os.makedirs(cfg["out_dir"], exist_ok=True)
    md_path = os.path.join(cfg["out_dir"], "morning-report.md")
    html_path = os.path.join(cfg["out_dir"], "morning-report.html")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(md)
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html_doc)
    print(f"Wrote {md_path} and {html_path}", file=sys.stderr)

    # echo the markdown to stdout so it's visible in the CI job log too.
    print(md)

    # exit non-zero if there were failures, so the schedule surfaces red (optional;
    # delivery can ignore the code). Counted-only.
    counted = [r for r in rows if r.counted]
    failures = [r for r in counted if not r.passed]
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
