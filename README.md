# Commissioning Workspace

This directory is an umbrella workspace for three related applications that are developed and deployed together but kept in their own repositories.

## Projects

| Path | Role | Primary Runtime |
|------|------|-----------------|
| `frontend/` | Local commissioning tool used on site for PLC I/O checkout, offline-first operation, and field testing | Vite + React + Express + SQLite + libplctag |
| `commissioning-cloud/` | Cloud commissioning app and sync API used by field tools and dashboards | Next.js + Prisma + PostgreSQL |
| `installation-tracker/` | Installation progress tracker for warehouse/distribution projects | Next.js + Prisma + PostgreSQL |

## Why They Live Side by Side

These apps share system context:

- They move together through the same delivery pipeline.
- They depend on common data contracts and operational assumptions.
- They are tied to one central PostgreSQL system in the broader platform.
- The local field tool also keeps a local SQLite working database for offline use and syncs central state through the cloud app.

Keeping the repos adjacent makes cross-project work tractable when a change touches:

- database schema or table ownership
- sync payloads and versioning
- shared project/subsystem/IO concepts
- deployment and environment assumptions

## Repo Boundaries

The directories are intentionally colocated, but they are not one merged codebase.

- `frontend/` belongs to the local commissioning tool codebase in this workspace.
- `commissioning-cloud/` has its own Git repository and release flow.
- `installation-tracker/` has its own Git repository and release flow.

When a task spans multiple apps:

1. Inspect each affected repo directly.
2. Treat contracts as explicit: API shapes, schema fields, version rules, auth, and deployment assumptions.
3. Commit and push in the owning repo for each app.
4. Do not assume a root `git status` represents the nested repos.

## System Topology

```text
Field Tablet / Laptop
  -> frontend/ local commissioning app
  -> local SQLite cache + PLC connection
  -> sync/update APIs in commissioning-cloud/
  -> central PostgreSQL data used across cloud services
  -> installation-tracker/ reads and writes related project/install data
```

## Documentation Map

Workspace-level:

- [CLAUDE.md](CLAUDE.md)
- [SYNC-ARCHITECTURE.md](SYNC-ARCHITECTURE.md)
- [DEPLOYMENT-STRATEGY.md](DEPLOYMENT-STRATEGY.md)

Per app:

- [frontend/CLAUDE.md](frontend/CLAUDE.md)
- [commissioning-cloud/CLAUDE.md](commissioning-cloud/CLAUDE.md)
- [installation-tracker/CLAUDE.md](installation-tracker/CLAUDE.md)

Operational docs for the local tool:

- [deploy/BUILD-RELEASE-GUIDE.md](deploy/BUILD-RELEASE-GUIDE.md)
- [deploy/INSTALLER-GUIDE.md](deploy/INSTALLER-GUIDE.md)
- [docs/SYNC-CONTRACT.md](docs/SYNC-CONTRACT.md)
- [docs/SYNC-VALIDATION-CHECKLIST.md](docs/SYNC-VALIDATION-CHECKLIST.md)
- [docs/HOST-UPDATER.md](docs/HOST-UPDATER.md)

## Working Rule

Use the root as the workspace entry point, then drop into the owning app before making assumptions about runtime, framework, or deployment details.
