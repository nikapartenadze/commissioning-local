#!/usr/bin/env bash
# PostToolUse hook: when a schema/migration/provisioning file is edited, inject a
# reminder so migration safety + cloud-provisioning steps are never forgotten.
# Reads the tool payload on stdin; matches the file path; emits additionalContext.
payload=$(cat)
if printf '%s' "$payload" | grep -qiE 'db-sqlite|schema\.prisma|prisma/migrations|/migration|add-[a-z0-9_-]+-column|synthetic-column|lib/cloud/pull-core'; then
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"MIGRATION/SCHEMA FILE EDITED — checklist before finishing: (1) LOCAL SQLite migrations (frontend/lib/db-sqlite.ts) auto-run on startup and MUST be additive + idempotent (ALTER TABLE ADD COLUMN / CREATE TABLE IF NOT EXISTS). A startup migration that DELETEs or rewrites data has wiped operator data before (Belt Tracked, commit 5a5bf16) — NEVER put a destructive statement in the startup path; confirm a DB backup exists first. (2) Cloud DATA provisioning (add-*-column scripts, lib/l2-synthetic-columns) does NOT auto-run in prod — you MUST run the script against prod AND the field tool must PULL to receive the new column. A redeploy does NOT add cloud data rows (this is why the Run Verified column 422d). (3) New LOCAL table column = a startup ALTER; new SPREADSHEET/L2 column = cloud provision + field pull — decide which and say so. (4) Update ONSITE-DEBUG-RUNBOOK migrations section and the migrations memory."}}
JSON
fi
