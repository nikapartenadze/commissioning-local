# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workspace Overview

This directory contains three related applications that are intentionally kept next to each other for shared context:

1. `frontend/` - local commissioning tool used in the field
2. `commissioning-cloud/` - cloud commissioning app and sync API
3. `installation-tracker/` - installation progress tracker

They are colocated because they share domain concepts, database contracts, deployment sequencing, and cross-app integration work.

## Repo Model

Do not treat this workspace as a single monorepo.

- `commissioning-cloud/` is its own Git repository.
- `installation-tracker/` is its own Git repository.
- The local commissioning tool lives in this workspace and should be treated as its own codebase as well.

Practical implication:

- A change may require edits in more than one sibling directory.
- Review Git state inside the affected repo, not just at the workspace root.
- If work spans apps, expect separate commits and pushes in the owning repos.
- Do not infer that nested directories are safe to ignore just because they are adjacent.

## How The System Fits Together

At the platform level, these apps revolve around the same central operational data model.

- `commissioning-cloud/` is the central sync and dashboard surface for commissioning data.
- `installation-tracker/` operates against the same broader project/install data ecosystem.
- `frontend/` is the field/offline client. It keeps a local SQLite database for resilience, then syncs central state through cloud APIs.

When a task touches any of the following, inspect more than one app before changing anything:

- schema or shared table ownership
- API request/response shapes
- subsystem/project/IO identifiers
- version conflict rules
- auth headers or credentials
- deployment environment assumptions

## Authority By Directory

Use the nearest app guide as the implementation source of truth:

- `frontend/CLAUDE.md` for the local field tool
- `commissioning-cloud/CLAUDE.md` for the cloud app
- `installation-tracker/CLAUDE.md` for the tracker

The root docs are for workspace orientation, not detailed app internals.

## Important Notes

- Some older root-level documents still describe the local tool before its move away from a pure Next.js runtime. For local app runtime details, prefer `frontend/CLAUDE.md`.
- Cross-app changes should preserve explicit contracts rather than relying on matching names by convention.
- Deployment and release work should respect app ownership; colocated repos do not imply shared history.

## Ports

| Port | Purpose |
|------|---------|
| 3000 | HTTP server + WebSocket (`/ws` path upgrade) |
| 3102 | Internal broadcast API (localhost only, PLC tag events) |
| 5173 | Vite dev server (development only) |

## Distribution

The field tool ships as either a portable ZIP (~48MB) or a Windows NSIS installer (~55MB).

- Portable ZIP: `deploy/BUILD-PORTABLE.bat` — bundles Node.js 20, compiled server, Vite client, and `plctag.dll`
- NSIS Installer: `deploy/BUILD-INSTALLER.bat` — installs to `C:\Program Files\CommissioningTool\`, data in `C:\ProgramData\CommissioningTool\`, auto-start Windows Service via NSSM

See `DEPLOYMENT-STRATEGY.md` for trade-offs and roadmap.

## Useful Root Docs

- `README.md` — workspace map
- `SYNC-ARCHITECTURE.md` — local/cloud sync behavior and data safety
- `DEPLOYMENT-STRATEGY.md` — deployment options and packaging notes
- `TEST-PLAN.md` — field validation checklist (setup, single-user, multi-user, VPN, resilience)
- `docs/` — planning and migration notes
- `docs/SYNC-CONTRACT.md` — formal sync contract between local and cloud
- `docs/MEMORY-OPTIMIZATION-PLAN.md` — heap and memory profiling notes
