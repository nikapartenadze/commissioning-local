# IO Checkout Tool — Build & Release Guide

How to create a new portable distribution (ZIP) and installer (EXE) for release.

## Prerequisites

On the build machine (any Windows PC):
- **Git** — to pull the latest code
- **Node.js 20+** — for building (the portable output bundles its own Node.js, so end users don't need it)
- **Internet access** — the build scripts download Node.js v20.20.1 and libplctag DLL automatically

For the installer (EXE) only:
- **NSIS** — `winget install NSIS.NSIS`
- **NSSM** — `winget install NSSM.NSSM`

## Quick Steps

```bash
# 1. Pull latest code
cd commissioning-local
git checkout migrate/node.js
git pull

# 2. Build portable distribution
deploy\BUILD-PORTABLE.bat

# 3. (Optional) Build installer EXE
deploy\BUILD-INSTALLER.bat

# 4. Zip the portable folder
# PowerShell:
Compress-Archive -Path portable\* -DestinationPath io-checkout-v2.9.15-portable.zip

# 5. Create GitHub release
gh release create v2.9.15 --title "v2.9.15" --target migrate/node.js \
  --notes "Release notes here" \
  io-checkout-v2.9.15-portable.zip \
  IOCheckout-Setup-v2.9.15.exe
```

## What Each Script Does

### `deploy\BUILD-PORTABLE.bat`

Creates a fully self-contained `portable/` folder that runs on any Windows PC with zero installation. The script performs 7 steps:

| Step | What it does |
|------|-------------|
| 1. Check Node.js | Uses system Node.js for building. If not installed, downloads portable Node.js |
| 2. Download libplctag | Downloads `plctag.dll` (PLC communication library) if not already in `frontend/` |
| 3. Clean previous build | Deletes the `portable/` folder and starts fresh |
| 4. Install dependencies | Runs `npm ci` in `frontend/` to install all packages |
| 5. Generate Prisma client | Runs `npx prisma generate` to create the database client |
| 6. Build Next.js | Runs `npm run build` which produces a standalone output in `frontend/.next/standalone/` |
| 7. Assemble portable | Copies everything into `portable/` — see structure below |

**What gets assembled in step 7:**

```
portable/
├── node/                  # Bundled Node.js v20.20.1 (downloaded separately for distribution)
│   ├── node.exe
│   ├── npm.cmd
│   └── node_modules/      # npm's own modules
├── app/                   # The application
│   ├── server.js          # Custom production server (Next.js + WebSocket merged)
│   ├── next-server.js     # Original Next.js standalone server (kept as fallback)
│   ├── .next/             # Compiled Next.js app (from standalone output + static files)
│   ├── public/            # Static assets
│   ├── plctag.dll         # PLC native library
│   ├── prisma/            # Database schema + seed scripts
│   ├── lib/               # startup-backup.js
│   ├── node_modules/      # Only runtime deps: .prisma, @prisma/client, ws, http-proxy
│   ├── database.db        # Pre-initialized SQLite database (empty, schema applied)
│   └── .env               # Generated environment config
├── START.bat              # Launch the app
├── STATUS.bat             # Check if running, show IP addresses
├── SETUP-FIREWALL.bat     # Open port 3000 in Windows Firewall (run once as admin)
├── SEED-NETWORK.bat       # Seed network topology data
└── README.txt             # Quick start instructions
```

**Key details:**
- Node.js for building (step 1) and Node.js for distribution (step 7) can be different versions — the build uses whatever's on the system, the portable folder always bundles v20.20.1
- The `.env` file is generated with a random JWT secret — each build gets a unique one
- The database is pre-initialized with `prisma db push` so it's ready to use immediately
- Only essential `node_modules` are copied (not the full `node_modules/` from development)

### `deploy\BUILD-INSTALLER.bat`

Creates a Windows installer EXE using NSIS. It:

1. Checks that NSIS and NSSM are installed
2. Reads the version from `deploy\BUILD-INSTALLER.bat` (hardcoded `APP_VERSION=2.9.15`)
3. Runs `BUILD-PORTABLE.bat` if the `portable/` folder doesn't exist yet
4. Compiles `deploy\installer.nsi` with NSIS, embedding the entire `portable/` folder

**The installer adds on top of the portable version:**
- Installs to `C:\Program Files\IOCheckout`
- Stores data (database, config, logs) in `C:\ProgramData\IOCheckout`
- Creates a Windows service via NSSM (auto-start on boot, restart on crash)
- Sets up firewall rules automatically
- Creates desktop shortcut and Start Menu entry
- Supports in-place upgrades (preserves database and config)

**Output:** `IOCheckout-Setup-v{VERSION}.exe` in the project root

## Updating the Version Number

The version is set in two places:

1. **Installer version**: `deploy\BUILD-INSTALLER.bat` line 54 — `set "APP_VERSION=2.9.15"`
2. **GitHub release tag**: whatever you pass to `gh release create`

These don't need to match `frontend/package.json` (which is `1.0.0` and unused for distribution versioning).

## Creating a GitHub Release

After building, create a release on GitHub:

```bash
# Zip the portable folder
powershell -Command "Compress-Archive -Path portable\* -DestinationPath io-checkout-v2.9.15-portable.zip -Force"

# Create release with both artifacts
gh release create v2.9.15 \
  --title "v2.9.15" \
  --target migrate/node.js \
  --notes "## What's New
- Feature X
- Bug fix Y" \
  io-checkout-v2.9.15-portable.zip \
  IOCheckout-Setup-v2.9.15.exe \
  deploy/INSTALLER-GUIDE.md
```

For portable-only releases (no EXE):
```bash
gh release create v2.9.15 \
  --title "v2.9.15" \
  --target migrate/node.js \
  --notes "Release notes" \
  io-checkout-v2.9.15-portable.zip
```

## Deploying to a Factory PC

### Portable (recommended for most sites)

1. Download the ZIP from the GitHub release
2. Extract to any folder (e.g., `C:\IOCheckout\`)
3. Run `SETUP-FIREWALL.bat` as Administrator (once)
4. Run `START.bat`
5. Access at `http://localhost:3000` or `http://<PC-IP>:3000` from tablets

### Installer

1. Download the EXE from the GitHub release
2. Run the installer as Administrator
3. The app starts automatically as a Windows service
4. Access at `http://localhost:3000`

## Troubleshooting Builds

| Issue | Solution |
|-------|----------|
| `npm ci failed` | Delete `frontend/node_modules` and retry |
| `Prisma generate failed` | Run `cd frontend && npx prisma generate` manually |
| `Build failed` with TypeScript error | Fix the code error, then retry the build |
| `NSIS not found` | `winget install NSIS.NSIS` |
| `NSSM not found` | `winget install NSSM.NSSM` |
| Portable folder too large | Normal size is ~160MB unzipped, ~60MB zipped |
| `plctag.dll` not found | The script auto-downloads it; check internet connection |

## File Sizes (Approximate)

| Artifact | Size |
|----------|------|
| `portable/` folder (unzipped) | ~160 MB |
| Portable ZIP | ~60 MB |
| Installer EXE | ~57 MB |
