# IO Checkout Tool — Deployment Strategy Report

**Date:** 2026-03-22
**Purpose:** Evaluate deployment options for factory environments and recommend the best path forward.

---

## Current State: Portable ZIP (What We Have Now)

**How it works:** 48MB zip → unzip → double-click `START.bat` → done.

| Aspect | Details |
|--------|---------|
| Size | 48MB zipped, ~135MB unzipped |
| Setup steps | 2 (unzip + START.bat) |
| Admin required | Once (firewall prompt) |
| Node.js | Bundled (85MB of the 135MB) |
| Updates | Manual — download new zip, extract |
| Data on update | Lost unless manually backed up |
| Auto-start | No — must run START.bat each time |

### What's Good
- Zero install — works from USB stick, network share, anywhere
- Self-contained — no dependencies on the target machine
- Simple — factory technicians understand "unzip and double-click"
- Multi-instance — each person runs their own copy
- Small download — 48MB is manageable even on slow connections

### What's Painful
- **No auto-update** — must manually download and replace
- **Database lost on upgrade** — new zip has empty database
- **No auto-start** — must manually run START.bat after every reboot
- **Firewall fragile** — UAC can silently block the auto-setup
- **No rollback** — to downgrade, need the old zip
- **Console window** — app runs in a CMD window, closing it stops the app

---

## Options Evaluated

### 1. NSIS Installer (.exe)

A traditional Windows setup wizard. Double-click installer, click Next/Finish.

| Aspect | Rating | Notes |
|--------|--------|-------|
| User experience | Great | Standard Windows wizard everyone knows |
| Firewall setup | Yes | Can run netsh during install with admin elevation |
| Auto-start | Possible | Can add to Startup folder or create service |
| Auto-update | Hard | Requires custom update server and client logic |
| Data preservation | Manual | Must script database backup/restore on upgrade |
| Size | ~50MB | Similar to current zip |
| Dev effort | 3-5 days | NSIS scripting learning curve |
| Factory IT friendly | Moderate | Not GPO-deployable like MSI |

**Best for:** Small teams (5-10 PCs) where technicians self-manage updates.

### 2. MSI Installer (Windows Installer)

Enterprise-grade Windows installer. Deployable via Group Policy.

| Aspect | Rating | Notes |
|--------|--------|-------|
| User experience | Great | Standard wizard, silent install possible |
| Firewall setup | Yes | Via custom actions |
| Auto-start | Yes | Can register Windows Service |
| Auto-update | Partial | Version chains, but no true auto-update |
| Data preservation | Good | MSI upgrade logic can preserve data files |
| Size | ~50MB | Similar |
| Dev effort | 1-2 weeks | WiX Toolset XML, more complex |
| Factory IT friendly | Excellent | GPO deployment to 50+ PCs, `msiexec /quiet` |

**Best for:** Large factories with IT departments controlling deployment.

### 3. Electron (Desktop App)

Wrap the web app in Chromium. Gets a proper application window, taskbar icon, etc.

| Aspect | Rating | Notes |
|--------|--------|-------|
| User experience | Excellent | Native app feel, no console window |
| Auto-update | Excellent | electron-updater, delta updates from GitHub |
| Native FFI | Risky | ffi-rs may need recompilation for Electron's Node |
| Tablet access | Works | WebSocket still accessible on network |
| Size | 150-200MB | 3-4x larger than current |
| Dev effort | 2-4 weeks | Significant refactoring |
| Factory IT friendly | Moderate | Standard installer, but large download |

**Best for:** If you want a polished desktop app with auto-updates. Overkill for factory commissioning.

### 4. Tauri (Lightweight Desktop App)

Rust-based alternative to Electron. Uses system WebView instead of bundling Chromium.

| Aspect | Rating | Notes |
|--------|--------|-------|
| User experience | Excellent | Native app feel, smallest footprint |
| Auto-update | Good | Built-in updater |
| Native FFI | Excellent | Rust → C interop is natural |
| Tablet access | Works | WebSocket still accessible |
| Size | 60-80MB | Only ~30MB more than current |
| Dev effort | 3-5 weeks | Rust toolchain, hybrid architecture |
| Factory IT friendly | Moderate | Standard installer |

**Best for:** If willing to invest in Rust for a smaller, faster app. High upfront cost.

### 5. Docker

Container-based deployment with Docker Desktop.

| Aspect | Rating | Notes |
|--------|--------|-------|
| User experience | Poor | Docker Desktop required, complex setup |
| PLC access | Problematic | Network bridge mode can't reach PLCs easily |
| Admin required | Yes | Docker Desktop needs admin + WSL2 |
| Size | 500MB+ | Docker Desktop alone is 400MB |
| Dev effort | 1-2 days | Dockerfile already exists |
| Factory IT friendly | Very Low | Most factory IT won't allow Docker |

**Not recommended for factory deployment.** Docker is designed for server environments with Linux. Factory Windows PCs with restricted admin access, unreliable power, and direct PLC network requirements make Docker impractical. The existing `docker/` setup is useful for Linux dev servers, not field deployment.

### 6. Windows Service + NSIS Installer (Hybrid)

Combine NSIS installer with NSSM (service wrapper) for auto-start.

| Aspect | Rating | Notes |
|--------|--------|-------|
| User experience | Great | Install once, runs automatically forever |
| Auto-start | Yes | Starts on boot, restarts on crash |
| Console window | None | Runs in background |
| Firewall setup | Yes | During install |
| Data preservation | Good | Database in ProgramData, survives reinstall |
| Size | ~55MB | Installer + NSSM binary |
| Dev effort | 1 week | NSIS + NSSM integration |
| Factory IT friendly | Good | Proper install/uninstall, auto-start |

**Best for:** Factory PCs that are always-on commissioning stations.

### 7. pkg (Single .exe)

Compile everything into one executable file.

| Aspect | Rating | Notes |
|--------|--------|-------|
| User experience | Simple | One file, double-click to run |
| Size | 90-150MB | Larger than current zip |
| Native FFI | Uncertain | ffi-rs may not work with pkg's bundled Node |
| Auto-update | No | Must replace entire .exe |
| Dev effort | 1-2 days | But may not work with ffi-rs |
| Factory IT friendly | Low | No install/uninstall, no service |

**Not recommended.** The appeal of "one file" is undermined by needing firewall setup, database files, and plctag.dll alongside it anyway.

---

## Recommendation

### Short Term (Now): Keep Portable ZIP + Add Smart Upgrades

The current approach is working. Don't change the deployment method — instead, fix the two biggest pain points:

1. **Auto-migrate database on startup** — when the app starts, check if the schema needs updating and run it automatically. Technicians never lose their data on upgrade.

2. **Version check banner** — on login, the app checks GitHub releases for a newer version and shows a non-blocking "Update available: v2.8.0" banner with a download link.

**Effort:** 2-3 days. Maximum impact for minimum work.

### Medium Term (3-6 months): NSIS Installer + Windows Service

When you have 10+ factory sites deploying this:

1. **NSIS installer** — proper Windows setup wizard with firewall setup, Start Menu shortcut
2. **NSSM service** — auto-starts on boot, runs in background, restarts on crash
3. **Database in ProgramData** — survives reinstall, auto-migrates schema
4. **Delta updates** — installer checks for updates on launch, downloads only changed files

**Effort:** 1-2 weeks. Transforms from "developer tool" to "professional product."

### Long Term (1+ year): Only if Needed

- **MSI** if enterprise GPO deployment becomes a requirement
- **Tauri** if you want a native desktop feel with auto-updates
- **Electron** only if you need deep OS integration (system tray, notifications, etc.)

---

## Comparison Matrix

| | Portable ZIP | NSIS + Service | MSI | Electron | Tauri | Docker |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Setup complexity | None | Low | Low | Low | Low | High |
| Auto-start on boot | No | Yes | Yes | Yes | Yes | Yes |
| Auto-update | No | Possible | Partial | Yes | Yes | Yes |
| Data survives update | No | Yes | Yes | Yes | Yes | Yes |
| Factory IT friendly | Good | Good | Excellent | Moderate | Moderate | Poor |
| PLC native FFI | Works | Works | Works | Risky | Excellent | Problematic |
| Tablet access | Works | Works | Works | Works | Works | Problematic |
| Size | 48MB | 55MB | 55MB | 200MB | 80MB | 500MB+ |
| Dev effort | Done | 1 week | 2 weeks | 4 weeks | 5 weeks | 2 days |
| Multi-instance | Yes | Yes | Yes | Yes | Yes | Complex |

---

## Summary

**Right now:** Portable ZIP is the right choice. It works, it's simple, and factory technicians can handle it.

**Next improvement:** Add database auto-migration + version check banner to the existing portable approach. 2-3 days of work, solves the biggest pain points.

**When you scale:** NSIS installer with Windows Service. Professional install experience, auto-start, data preservation. 1-2 weeks of work.

**Don't bother with:** Docker (wrong environment), Electron (overkill + FFI risk), pkg (doesn't solve real problems), MSIX (sandboxing blocks PLC access).
