# IO Checkout Tool — Windows Installer Guide

## What the Installer Does

- Installs IO Checkout as a **Windows service** — runs in the background, no CMD window
- **Auto-starts on boot** — survives reboots, no manual action needed
- **Auto-restarts on crash** — 5 second delay, then back up
- **Firewall rules** — port 3000 opened automatically during install (WebSocket shares the same port)
- **Desktop shortcut** — "IO Checkout" with CIO icon, opens the app in your browser

---

## First Time Install

1. Run **`IOCheckout-Setup-vX.X.X.exe`** (requires admin)
2. Click **Next** → **Install** → **Finish**
3. Open **http://localhost:3000** in your browser
4. Log in with PIN: **`111111`** (change it immediately via Manage Users)

> The app is now running as a service. You can close the browser — the server stays running.

---

## Upgrading to a New Version

**Just run the new `IOCheckout-Setup-vX.X.X.exe`** — that's it.

- **No need to uninstall** the old version
- **Database and config are preserved** — your test results, cloud settings, and users stay intact
- The installer automatically: stops service → updates files → restarts service

---

## Accessing the App

| From | URL |
|------|-----|
| **This PC** | http://localhost:3000 |
| **Tablets / Laptops** | http://`SERVER_IP`:3000 |
| **Desktop shortcut** | "IO Checkout" (auto-created) |
| **Start Menu** | IO Checkout Tool → Open IO Checkout |

> Run `ipconfig` in CMD to find your server's IP address for tablet access.

---

## Where Files Are Stored

| What | Location | On Upgrade |
|------|----------|------------|
| **App files** | `C:\Program Files\IOCheckout\` | **Replaced** |
| **Database** | `C:\ProgramData\IOCheckout\database.db` | **Preserved** |
| **Config** | `C:\ProgramData\IOCheckout\config.json` | **Preserved** |
| **Logs** | `C:\ProgramData\IOCheckout\logs\` | **Preserved** |
| **Backups** | `C:\ProgramData\IOCheckout\backups\` | **Preserved** |

> Everything in `ProgramData` survives upgrades. Everything in `Program Files` gets replaced.

### Log Files

All logs are in **`C:\ProgramData\IOCheckout\logs\`**:

| File | What's in it |
|------|-------------|
| **`app.log`** | Detailed app activity — PLC connections, cloud sync, test recordings (with timestamps) |
| **`errors.log`** | Errors and warnings only — check this first when something breaks |
| **`service.log`** | Raw console output captured by the service manager |
| **`service-error.log`** | Raw error output captured by the service manager |

- Logs **auto-rotate** at 10MB — old files are renamed with a timestamp
- Max **3 rotated files** per type (30MB cap) — old ones auto-deleted
- Logs are **preserved across upgrades** — useful for diagnosing issues after an update

---

## Service Management

The app runs as a Windows service called **"IOCheckout"**. It starts automatically — you don't need to do anything.

| Action | How |
|--------|-----|
| **Check status** | `services.msc` → find **"IO Checkout Tool"** |
| **Stop** | Admin CMD: `nssm stop IOCheckout` |
| **Start** | Admin CMD: `nssm start IOCheckout` |
| **Restart** | Admin CMD: `nssm restart IOCheckout` |

---

## Ports

| Port | Purpose |
|------|---------|
| **3000** | Web app + WebSocket (HTTP + real-time PLC state updates) |

WebSocket connections are upgraded on the same port via the `/ws` path. Only port 3000 needs to be opened in the firewall.

---

## Uninstalling

**Control Panel** → **Add/Remove Programs** → **IO Checkout Tool** → **Uninstall**

- Stops the service and removes app files
- **Asks whether to keep or delete your data** (database, config, logs)
- If you keep data, reinstalling later will pick up where you left off

---

## Troubleshooting

### App not loading in browser
1. Check the service is running: `services.msc` → **"IO Checkout Tool"** → should say **Running**
2. Check logs: **`C:\ProgramData\IOCheckout\logs\service.log`**
3. Try restarting: admin CMD → `nssm restart IOCheckout`

### Tablets can't connect
1. Use the server's **IP address**, not `localhost` → run `ipconfig` to find it
2. Check firewall: port **3000** must be open
3. Make sure tablets are on the **same network** as the server

### Service won't start after upgrade
1. Run as admin: `nssm restart IOCheckout`
2. Check error log: **`C:\ProgramData\IOCheckout\logs\service-error.log`**
3. If all else fails: uninstall → reinstall (keep data when asked)

### After upgrade, data seems missing
- Your data is in **`C:\ProgramData\IOCheckout\`** — it's preserved across upgrades
- Pull IOs from cloud to refresh IO definitions
