# Commissioning Local Tool Production Deployment Recommendation

Date: 2026-04-11

## Executive Summary

The correct long-term deployment model for the commissioning local tool is:

1. One Windows host per site or subsystem area.
2. The tool runs as a Windows service on that host.
3. Technicians use the app through their browsers from tablets or laptops.
4. SQLite stays local on that one host only.
5. Updates are applied on the host, not on every technician device.

This is already close to the direction of the codebase. The service-oriented installer path is the right foundation. The next step is not a new platform. The next step is to make the Windows service path the primary production path, then add a controlled updater around it.

## Why This Is The Right Model

The app already behaves like a shared local server:

- `frontend/server-express.ts` binds the app to `0.0.0.0` on port `3000` and serves both HTTP and WebSocket traffic.
- `deploy/installer.nsi` installs the app as a Windows service with auto-start, restart-on-failure, firewall rules, and `ProgramData` storage.
- The local database is SQLite with WAL enabled and schema auto-initialization in `frontend/lib/db-sqlite.ts`.
- Browser clients are already the intended access model for other devices on the LAN.

This matches SQLite's documented strengths well: SQLite is a good fit for edge devices and local application storage, and SQLite explicitly warns against treating a network filesystem as the shared database layer. That means one host process with local disk is correct; multiple machines directly opening one shared SQLite file is not.

## Recommended Production Architecture

### Runtime Topology

- One commissioning server PC runs the app continuously.
- The app runs as a Windows service.
- All field users access `http://SERVER_IP:3000` from browsers.
- The server keeps the only writable local SQLite database.
- The server is the only machine talking to the PLC.
- Cloud sync remains server-side from that one host.

### Data Placement

Store all mutable runtime data under one data root:

- `C:\ProgramData\IOCheckout\database.db`
- `C:\ProgramData\IOCheckout\config.json`
- `C:\ProgramData\IOCheckout\backups\`
- `C:\ProgramData\IOCheckout\logs\`
- `C:\ProgramData\IOCheckout\releases\` or `downloads\` for staged installers

Keep application binaries under:

- `C:\Program Files\IOCheckout\`

That separation is the correct production pattern because binaries can be replaced while data survives upgrades and rollbacks.

### Networking

Minimum:

- Open TCP `3000` only on the server host.
- Keep the internal broadcast endpoint bound to loopback only.

Recommended for any non-fully-trusted LAN:

- Put the app behind HTTPS on the server host or a local reverse proxy.
- Do not send login tokens or admin actions over plain HTTP on mixed networks.

## Recommended Update Strategy

## The Right UX

For this product, "automatic update" should mean:

1. The running server checks a release manifest.
2. An admin sees `Update available`.
3. Admin clicks one button.
4. The app creates a backup.
5. A separate updater process stops the service, installs the new version, restarts the service, runs a health check, and reports success.

That is the right model because the running server process should not try to overwrite its own binaries in place.

## Recommended Implementation Pattern

Use a two-process update design:

- Main app service:
  - Checks a signed update manifest on a schedule and on demand.
  - Shows current version, target version, release notes, and update status.
  - Calls a local privileged updater when the admin approves.

- Updater agent:
  - Separate executable or service companion.
  - Downloads installer to a staging folder.
  - Verifies SHA-256 and signature.
  - Creates a pre-update database backup.
  - Stops the service.
  - Runs the installer silently.
  - Starts the service.
  - Calls `/api/health`.
  - Rolls back or leaves the previous installer available if the health check fails.

This gives you the "one button on the running server" experience without turning the app itself into the installer.

## Release Channel Recommendation

Use a simple signed manifest first. Example fields:

- `version`
- `channel`
- `publishedAt`
- `minSupportedVersion`
- `installerUrl`
- `installerSha256`
- `releaseNotesUrl`
- `mandatory`

Recommended channels:

- `stable`
- `pilot`
- `hotfix`

The server should default to `stable`, with pilot only for internal verification machines.

## Packaging Recommendation

### Primary Packaging

Keep the Windows installer path as the production package.

Recommended target:

- Installer upgrades in place.
- Service is recreated or refreshed safely.
- Data is preserved in `ProgramData`.
- Silent install is supported for updater-driven upgrades.

### Secondary Packaging

Keep the portable ZIP only for:

- development
- emergency recovery
- field diagnostics
- temporary trials

Do not make portable ZIP the long-term production standard for shared on-site deployment.

## Enterprise Option

If later you need IT-managed rollout across many sites, add a managed package channel instead of changing the runtime architecture.

Two realistic options:

1. `winget` private source
2. MSI for GPO/Intune/SCCM-heavy environments

`winget` is attractive because Microsoft supports private sources and silent upgrades. That is useful when factory IT wants to own the upgrade process. It is not required for the first production-ready updater.

## MSIX Assessment

MSIX and App Installer can provide on-launch and background update behavior. That is real and documented. But for this tool it should be treated as a later option, not the immediate path, because:

- it introduces package signing and publisher identity requirements
- it adds packaging work while the current service installer path is already mostly in place
- the tool is fundamentally a local server plus native PLC library, not a typical desktop-only client app

Conclusion: possible, but not the shortest path to a reliable commissioning deployment.

## Current Repo Findings That Matter Before Productionizing Updates

These are not reasons to abandon the service model. They are the cleanup list before one-click updates become safe.

### 1. Config persistence is not actually aligned with the installer contract

`deploy/installer.nsi` says config is preserved in `ProgramData`, but `frontend/lib/config/config-service.ts` reads and writes `process.cwd()/config.json`.

In service mode, the installer copies `ProgramData\config.json` into the app directory, but the runtime then writes back to the app directory, not to `ProgramData`. That means upgrade-time config preservation is weaker than the docs imply.

Required fix:

- Make the runtime read and write config from a single authoritative path in `ProgramData`.
- Stop copying config into the app directory as the live source of truth.

### 2. Startup backup path is not based on the real runtime database path

`frontend/lib/startup-backup.js` looks for `../prisma/database.db`, but production uses `DATABASE_URL` and the installer points that database at `C:\ProgramData\IOCheckout\database.db`.

Required fix:

- Resolve the backup source from `DATABASE_URL`.
- Put startup backups under the same runtime data root.

### 3. Portable build and release docs are out of sync

The current codebase is Vite + Express, but some deployment docs still describe older Next.js-style output and older packaging assumptions.

Required fix:

- Rewrite the build/release docs to match the current Vite + Express output.
- Make the actual portable and installer layout match the documentation exactly.

### 4. Build reproducibility is weak

`deploy/BUILD-PORTABLE.bat` bundles `node.exe` from whatever build machine runs the script.

That is convenient, but it makes releases less reproducible.

Required fix:

- Build on a pinned Windows runner.
- Pin the exact Node version used for release builds.
- Emit a release manifest and checksums from CI.

### 5. Backups and database location assumptions need one contract

The repo currently has multiple path assumptions for database and backup storage.

Required fix:

- Centralize runtime path resolution behind one storage-path module.
- Use that module for DB, backups, logs, config, and updater staging.

## Recommended DevOps / Release Process

### Build

- Use a dedicated Windows CI runner.
- Pin Node version and native dependency versions.
- Build installer and portable artifact.
- Generate SHA-256 for every artifact.
- Stamp build metadata into the frontend and server.

### Verify

- Run automated tests.
- Run installer smoke test on a clean Windows VM.
- Run upgrade smoke test from previous stable version.
- Verify:
  - database preserved
  - config preserved
  - service starts
  - `/api/health` returns healthy
  - PLC library loads

### Publish

- Publish installer, portable ZIP, checksums, and manifest to a stable release bucket or GitHub Releases.
- Keep at least the last 3 stable installers available for rollback.

### Operate

- Service exposes health endpoint.
- Logs stay in `ProgramData`.
- Admin UI shows current version and update state.
- Updates create a named pre-update DB backup automatically.

## Rollback Practice

Rollback should be explicit and fast:

1. Stop service.
2. Reinstall previous stable version.
3. Restore the pre-update database backup only if schema or data regression requires it.
4. Start service.
5. Re-run health check.

Do not make rollback depend on rebuilding an old artifact from source.

## What I Would Do Next

### Phase 1: Make the current installer path production-correct

- Fix runtime path handling for config, backups, and database.
- Clean up installer and build docs.
- Add release manifest generation.
- Add checksum generation.
- Add version endpoint.

### Phase 2: Add admin-driven one-click updates

- Build local updater helper.
- Add UI for `Check for updates` and `Install update`.
- Add backup-before-upgrade.
- Add post-upgrade health verification.

### Phase 3: Add managed rollout support if needed

- Add `winget` private source or MSI packaging for enterprise IT.
- Add pilot/stable channels.
- Add audit log entries for update attempts and results.

## Final Recommendation

The correct deployment approach is:

- single Windows host
- Windows service
- browser clients from other devices
- SQLite only on that host
- installer-based upgrades
- one-click admin-triggered updater using a separate helper process

Do not optimize around portable multi-instance installs anymore. That was a useful transition state, but it is not the right final production model for a shared commissioning server.

## External References

- SQLite, Appropriate Uses For SQLite: https://www.sqlite.org/whentouse.html
- SQLite, SQLite Over a Network: https://www.sqlite.org/useovernet.html
- Microsoft Learn, `winget upgrade`: https://learn.microsoft.com/en-us/windows/package-manager/winget/upgrade
- Microsoft Learn, `winget source`: https://learn.microsoft.com/en-us/windows/package-manager/winget/source
- Microsoft Learn, App Installer update settings for MSIX: https://learn.microsoft.com/en-us/windows/msix/app-installer/how-to-create-appinstaller-file
- WinSW project: https://github.com/winsw/winsw
