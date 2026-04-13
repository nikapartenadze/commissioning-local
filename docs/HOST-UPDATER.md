# Host Updater

## Goal

- The app runs as a Windows service on one on-site host.
- Browser users can see when an update is available.
- The actual installation happens on the host machine through a detached PowerShell updater.

## Runtime Inputs

- `APP_VERSION`
- `UPDATE_MANIFEST_URL`

Both are read from the runtime `.env` used by the installed service.

## Manifest Format

Use [release-manifest.example.json](../deploy/release-manifest.example.json) as the reference shape:

```json
{
  "version": "2.10.1",
  "installerUrl": "https://example/IOCheckout-Setup-v2.10.1.exe",
  "publishedAt": "2026-04-13T12:00:00Z",
  "notes": "Release notes shown in the UI."
}
```

## Update Flow

1. UI calls `GET /api/update/status`
2. Server compares local `APP_VERSION` to the remote manifest version
3. UI shows `Update available`
4. User triggers `POST /api/update/install`
5. Server launches `tools/install-update.ps1` in a detached PowerShell process
6. Updater downloads installer, stops service, backs up DB/config, installs silently, restarts service, and runs health check
7. Updater writes progress to `update-status.json` in the storage root

## Storage

- update state file: beside the database/config storage root
- database backup: `ProgramData\IOCheckout\backups\database-*-pre-update.db`
- config backup: `ProgramData\IOCheckout\backups\config-*-pre-update.json`
