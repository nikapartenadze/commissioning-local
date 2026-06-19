; Commissioning Tool — NSIS Installer Script
; Builds a Windows installer with NSSM service integration
;
; Features:
;   - Installs app + bundled Node.js + NSSM service
;   - Upgrades in-place (preserves database + config)
;   - Auto-starts on boot, restarts on crash
;   - Firewall rules for port 3000 (WebSocket shares the same port)
;   - Clean uninstall (stops service, removes firewall rules)

!include "MUI2.nsh"
!include "FileFunc.nsh"

; ── Version & Metadata ──────────────────────────────────────
!define APP_NAME "Commissioning Tool"
!define APP_SHORT "CommissioningTool"
!define APP_PUBLISHER "autStand"
!define APP_URL "https://commissioning.lci.ge"
!ifndef APP_VERSION
  !define APP_VERSION "2.25.4"
!endif

!define INSTALL_DIR "$PROGRAMFILES\${APP_SHORT}"
!define SERVICE_NAME "CommissioningTool"
!define SERVICE_DISPLAY "Commissioning Tool"

; ── CENTRAL (multi-MCM split) build ─────────────────────────
; Define CENTRAL on the makensis command line (/DCENTRAL=1) to build the
; centralized-server installer: TWO services — a plc-gateway that owns every
; PLC connection (PLC_MODE unset, libplctag, :3200) and the app in
; PLC_MODE=remote that routes all PLC I/O to the gateway. This is the
; production architecture for a single box driving many MCMs (the app event
; loop never blocks on tag I/O). Without CENTRAL the installer builds the
; unchanged single-process embedded field-tablet service.
!define GATEWAY_SERVICE_NAME "CommissioningGateway"
!define GATEWAY_SERVICE_DISPLAY "Commissioning PLC Gateway"

Var DATA_DIR

; ── Installer Settings ──────────────────────────────────────
!ifdef CENTRAL
Name "${APP_NAME} (Central) ${APP_VERSION}"
OutFile "..\CommissioningTool-Central-Setup-v${APP_VERSION}.exe"
!else
Name "${APP_NAME} ${APP_VERSION}"
OutFile "..\CommissioningTool-Setup-v${APP_VERSION}.exe"
!endif
InstallDir "${INSTALL_DIR}"
InstallDirRegKey HKLM "Software\${APP_SHORT}" "InstallDir"
RequestExecutionLevel admin

; ── UI ──────────────────────────────────────────────────────
!define MUI_ICON "app.ico"
!define MUI_UNICON "app.ico"
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ── StrContains: returns "1" if the haystack on the stack contains the
;    needle on the stack, else "0". Used for parsing `sc query` output.
;    Stack convention: push haystack, push needle, call → push result.
Function StrContains
  Exch $R1     ; needle
  Exch
  Exch $R2     ; haystack
  Push $R3
  Push $R4
  StrLen $R4 $R1
  StrCpy $R3 0
  loop:
    StrCpy $R0 $R2 $R4 $R3
    StrCmp $R0 $R1 found
    StrCmp $R0 "" notfound
    IntOp $R3 $R3 + 1
    Goto loop
  found:
    StrCpy $R0 "1"
    Goto done
  notfound:
    StrCpy $R0 "0"
  done:
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

; ── Install Section ─────────────────────────────────────────
Section "Install"
  SetOutPath "$INSTDIR"
  ReadEnvStr $DATA_DIR "ProgramData"
StrCpy $DATA_DIR "$DATA_DIR\CommissioningTool"

  ; ══════════════════════════════════════════════════════════════════
  ; SHUT DOWN THE RUNNING SERVICE BEFORE TOUCHING ANY FILES.
  ;
  ; node.exe holds locks on its own image and on app/dist-server/
  ; node_modules native modules (better-sqlite3.node, ffi-rs DLL).
  ; If we touch the file tree before the process is dead, NSIS `File`
  ; either silently skips (default) or pops a Retry/Cancel dialog
  ; (with SetOverwrite on). Either outcome breaks unattended upgrades.
  ;
  ; The sequence below ratchets through increasingly aggressive
  ; cleanup until *no* node.exe rooted in $INSTDIR remains, then
  ; verifies file locks have actually released by probing a rename
  ; of node.exe. If even that fails (e.g. AV scanner has a handle),
  ; we fall back to scheduling the replacement on next reboot.
  ;
  ; First-install path: every step is a no-op when the service /
  ; processes don't exist. No errors, just falls through.
  ; ══════════════════════════════════════════════════════════════════
  DetailPrint "Stopping ${SERVICE_NAME} service before upgrade..."

  ; Step 0: neutralize auto-restart BEFORE stopping. The service carries SCM
  ; recovery actions (sc failure ... restart/5000) + NSSM AppExit Restart.
  ; Without this, force-killing leftover node.exe below makes the SCM treat it
  ; as a crash and respawn the whole service ~5s later — right as the file copy
  ; runs — re-locking node.exe ("error opening file for writing node.exe").
  ; Disable start + clear failure actions so NOTHING respawns mid-install.
  nsExec::ExecToLog 'sc.exe config ${SERVICE_NAME} start= disabled'
  nsExec::ExecToLog 'sc.exe failure ${SERVICE_NAME} reset= 0 actions= ""'

  ; Step 1: graceful stop. nsExec returns immediately, we poll below.
  nsExec::ExecToLog 'sc.exe stop ${SERVICE_NAME}'

  ; Step 2: poll up to 30s (15× 2s) for STOPPED. Returns fast on
  ; missing service or already-stopped.
  StrCpy $1 0
  poll_stopped_loop:
    IntCmp $1 15 poll_stopped_done
    nsExec::ExecToStack 'cmd.exe /c sc query ${SERVICE_NAME} ^| findstr /C:"STATE"'
    Pop $2  ; exit code (0 = found)
    Pop $3  ; output line
    StrCmp $2 "0" 0 poll_stopped_done   ; service missing → done
    Push $3
    Push "STOPPED"
    Call StrContains
    Pop $4
    StrCmp $4 "1" poll_stopped_done
    Sleep 2000
    IntOp $1 $1 + 1
    Goto poll_stopped_loop
  poll_stopped_done:

  ; Step 3: drop the service config (NSSM kills the wrapped process
  ; tree on remove). If the service didn't exist, this no-ops.
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" remove ${SERVICE_NAME} confirm'
  ; Hard fallback in case nssm.exe is itself missing/locked.
  nsExec::ExecToLog 'sc.exe delete ${SERVICE_NAME}'
  Sleep 1000

  ; Stop + remove the plc-gateway service UNCONDITIONALLY (even on a non-central
  ; build). A prior CENTRAL install leaves CommissioningGateway running; if this
  ; cleanup is skipped, its node.exe/nssm.exe keep the install files locked and
  ; the copy below fails with "error opening file for writing node.exe".
  ; CRITICAL: poll for STOPPED exactly like the app
  ; service above. A fixed Sleep was too short — if the gateway took >2s to
  ; die, `nssm remove` ran while node.exe was still live and the file copy
  ; below failed with "cannot write node.exe". Poll up to 30s instead.
  DetailPrint "Stopping ${GATEWAY_SERVICE_NAME} service before upgrade..."
  ; Same anti-respawn neutralization as the app service above. THIS is the one
  ; that bit v2.42.1: the gateway's restart/5000 recovery respawned it ~5s after
  ; the kill, racing (and re-locking) the file copy. Disable + clear FIRST.
  nsExec::ExecToLog 'sc.exe config ${GATEWAY_SERVICE_NAME} start= disabled'
  nsExec::ExecToLog 'sc.exe failure ${GATEWAY_SERVICE_NAME} reset= 0 actions= ""'
  nsExec::ExecToLog 'sc.exe stop ${GATEWAY_SERVICE_NAME}'
  StrCpy $1 0
  poll_gw_stopped_loop:
    IntCmp $1 15 poll_gw_stopped_done
    nsExec::ExecToStack 'cmd.exe /c sc query ${GATEWAY_SERVICE_NAME} ^| findstr /C:"STATE"'
    Pop $2  ; exit code (0 = found)
    Pop $3  ; output line
    StrCmp $2 "0" 0 poll_gw_stopped_done   ; service missing → done
    Push $3
    Push "STOPPED"
    Call StrContains
    Pop $4
    StrCmp $4 "1" poll_gw_stopped_done
    Sleep 2000
    IntOp $1 $1 + 1
    Goto poll_gw_stopped_loop
  poll_gw_stopped_done:
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" remove ${GATEWAY_SERVICE_NAME} confirm'
  ; Hard fallback in case nssm.exe is itself missing/locked.
  nsExec::ExecToLog 'sc.exe delete ${GATEWAY_SERVICE_NAME}'
  Sleep 1000

  ; Step 4: last-resort process kill. WMIC / PowerShell can filter
  ; node.exe by ExecutablePath, which taskkill cannot do. The earlier
  ; `taskkill /FI "WINDOWDIR eq..."` trick was a no-op in practice —
  ; service-spawned node has no window, and WINDOWDIR doesn't filter
  ; on the executable's path anyway. PowerShell's CIM query is the
  ; first filter that actually targets the right process: only kills
  ; node.exe instances whose binary lives under $INSTDIR, leaving any
  ; other node.exe the user might be running alone.
  DetailPrint "Killing any leftover node.exe under $INSTDIR..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name = ''node.exe'' OR Name = ''nssm.exe''\" | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith(''$INSTDIR'', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Sleep 2000

  ; Step 5: belt-and-suspenders retry on the process kill. Even if
  ; `nssm remove` returned cleanly, the OS can take a beat to release
  ; file handles. We loop the PowerShell kill up to 3 times with a 2s
  ; pause between, accepting "no matching processes" as success. After
  ; this, $INSTDIR is virtually guaranteed to have no live node.exe
  ; from our app, so the file copies below can overwrite freely.
  StrCpy $1 0
  process_kill_loop:
    IntCmp $1 3 process_kill_done
    nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$found = Get-CimInstance Win32_Process -Filter \"Name = ''node.exe'' OR Name = ''nssm.exe''\" | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith(''$INSTDIR'', [StringComparison]::OrdinalIgnoreCase) }; if ($$found) { $$found | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 1 } else { exit 0 }"'
    Pop $2  ; exit code: 0 = no processes left, 1 = had to kill some
    Pop $3  ; (output, ignored)
    StrCmp $2 "0" process_kill_done
    Sleep 2000
    IntOp $1 $1 + 1
    Goto process_kill_loop
  process_kill_done:

  ; ══════════════════════════════════════════════════════════════════
  ; WINDOWS DEFENDER EXCLUSION (best-effort, runs elevated)
  ;
  ; Newer Win11 laptops quarantine our UNSIGNED native DLL (plctag.dll).
  ; The app then can't initialize libplctag and PLC testing dies with
  ; "Failed to load libplctag … searched paths …". Code-signing is the
  ; proper fix but we have no cert budget, so we add a Defender path
  ; exclusion for the install + data dirs *before* copying files — the
  ; DLL then lands in an already-excluded path and is never scanned /
  ; quarantined. Also register an ASR-only exclusion for the two DLL
  ; paths in case an Attack-Surface-Reduction "block untrusted/low-
  ; reputation executables" rule is the blocker rather than plain
  ; real-time scanning.
  ;
  ; Best-effort and non-fatal: wrapped in try/catch. No-ops when a third-
  ; party AV is in use, and may be refused on org-managed Defender with
  ; Tamper Protection on (those laptops need a central exclusion pushed
  ; from IT). Does NOT defeat Smart App Control — an SAC-enforced machine
  ; still requires a signed binary or SAC turned off.
  ; ══════════════════════════════════════════════════════════════════
  DetailPrint "Adding Windows Defender exclusion for $INSTDIR (max 20s, best-effort) ..."
  ; Add-MpPreference can HANG indefinitely on org-managed Defender / Tamper
  ; Protection, and nsExec waits for it — that froze the installer mid-run.
  ; Run it inside a background job bounded by Wait-Job -Timeout: the installer
  ; waits at most ~20s, then moves on (the orphaned job dies with this host).
  ; Still best-effort/non-fatal; the exclusion just may not apply on locked-down
  ; machines (those need a central exclusion from IT).
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$j = Start-Job { try { Add-MpPreference -ExclusionPath \"$INSTDIR\",\"$DATA_DIR\" -ErrorAction Stop; Add-MpPreference -AttackSurfaceReductionOnlyExclusions \"$INSTDIR\app\plctag.dll\",\"$INSTDIR\app\dist-server\plctag.dll\" -ErrorAction SilentlyContinue } catch {} }; Wait-Job $$j -Timeout 20 | Out-Null"'

  ; ── Create data directory (preserved across upgrades) ──
  CreateDirectory "$DATA_DIR"
  CreateDirectory "$DATA_DIR\logs"
  CreateDirectory "$DATA_DIR\backups"

  ; ── Pre-upgrade database backup (safety net for rollback) ──
  IfFileExists "$DATA_DIR\database.db" 0 skip_backup
    ; Copy database to backups with version + timestamp in filename
    ; Format: pre-upgrade-vX.Y.Z-YYYYMMDD-HHMMSS.db
    ; Read previous version from registry (if upgrading)
    ReadRegStr $1 HKLM "Software\${APP_SHORT}" "Version"
    StrCmp $1 "" no_prev_version
      ${GetTime} "" "L" $2 $3 $4 $5 $6 $7 $8
      CopyFiles /SILENT "$DATA_DIR\database.db" "$DATA_DIR\backups\pre-upgrade-v$1-$4$3$2-$6$7.db"
      DetailPrint "Database backed up: pre-upgrade-v$1-$4$3$2-$6$7.db"
    no_prev_version:
  skip_backup:

  ; ── Copy app files (replaced on upgrade) ──
  ; The portable build places node.exe at the root of the portable dir
  ; (single ~88MB binary, not a folder). Mirror that layout into $INSTDIR.
  ;
  ; SetOverwrite on  →  if a file is locked, NSIS will retry up to a
  ; handful of times and then prompt the user with a Retry/Cancel/Ignore
  ; dialog. We've already taken the steps above to make sure nothing
  ; SHOULD be locked; this turns silent failure into a visible one if
  ; the worst happens.
  SetOverwrite on
  SetOutPath "$INSTDIR"
  File "${PORTABLE_DIR}\node.exe"

  ; Visual C++ runtime — sits next to node.exe (the application directory,
  ; FIRST in Windows' DLL search order) so plctag.dll's dependency on
  ; vcruntime140.dll resolves on clean laptops that have no VC++ redist
  ; installed. This is the real fix for the "Failed to load libplctag …
  ; os error 126 (module could not be found)" failures on new machines:
  ; the file was present, its dependency was not. App-local VC++ runtime
  ; deployment is permitted by Microsoft. (Copies also land inside \app
  ; via the recursive copy below for belt-and-suspenders.)
  File "${PORTABLE_DIR}\vcruntime140.dll"

  SetOutPath "$INSTDIR\app"
  File /r "${PORTABLE_DIR}\app\*.*"

  ; ── Copy NSSM + icon ──
  SetOutPath "$INSTDIR"
  File "${NSSM_PATH}"
  File "app.ico"

  ; ── Create .env pointing to data directory ──
  FileOpen $0 "$INSTDIR\app\dist-server\.env" w
  FileWrite $0 "DATABASE_URL=file:$DATA_DIR\database.db$\r$\n"
  FileWrite $0 "JWT_SECRET_KEY=commissioning-tool-svc-$HWNDPARENT$\r$\n"
  FileWrite $0 "PORT=3000$\r$\n"
  FileWrite $0 "HOSTNAME=0.0.0.0$\r$\n"
  FileWrite $0 "NODE_ENV=production$\r$\n"
  FileWrite $0 "APP_VERSION=${APP_VERSION}$\r$\n"
  FileWrite $0 "UPDATE_MANIFEST_URL=$\r$\n"
  ; NOTE: PLC_MODE is deliberately NOT written to this shared .env. The app AND
  ; the gateway both run from $INSTDIR\app and load THIS file — writing
  ; PLC_MODE=remote here makes the GATEWAY read it too and fatally exit
  ; ("PLC_MODE=remote is invalid for the gateway process"). The app gets
  ; PLC_MODE/GATEWAY_URL from its own service env only (AppEnvironmentExtra,
  ; below); the gateway is pinned to embedded there too. .env stays mode-agnostic.
  FileClose $0

  ; ── Database initialization ──
  ; Intentionally NO bundled DB. The runtime (lib/db-sqlite.ts) creates
  ; the SQLite file in WAL mode on first launch and applies the schema
  ; bootstrap. Shipping a default DB risks overwriting customer data on
  ; upgrade and exposes whatever happened to be in the build's working
  ; tree at packaging time.

  ; ── Preserve config.json across upgrades ──
  IfFileExists "$DATA_DIR\config.json" config_exists
    ; First install — copy default config if exists
    IfFileExists "$INSTDIR\app\config.json" 0 config_exists
      CopyFiles /SILENT "$INSTDIR\app\config.json" "$DATA_DIR\config.json"
  config_exists:
  ; Symlink config.json so the app finds it in its working directory
  ; (Delete old one first in case it's a regular file from portable)
  Delete "$INSTDIR\app\config.json"
  CopyFiles /SILENT "$DATA_DIR\config.json" "$INSTDIR\app\config.json"

  ; ── Ensure VC++ x64 runtime is registered system-wide (belt-and-suspenders) ──
  ; plctag.dll imports vcruntime140.dll, which a clean Windows 11 laptop does
  ; NOT ship — its absence is what produced "Failed to load libplctag … os
  ; error 126 (module could not be found)" on new machines. The app already
  ; works without this step because we drop an app-local vcruntime140.dll next
  ; to node.exe (first in Windows' DLL search order), so this is NOT required
  ; for the tool to run. But registering the runtime system-wide is cleaner and
  ; covers any other native component. If the 2015-2022 x64 runtime isn't
  ; registered AND the build bundled vc_redist, install it silently. Best-effort
  ; and never fatal — VCREDIST_PATH is only defined when the redist was fetched.
!ifdef VCREDIST_PATH
  ClearErrors
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  IntCmp $0 1 vcrt_done
    DetailPrint "VC++ x64 runtime not registered — installing bundled vc_redist.x64.exe ..."
    SetOutPath "$INSTDIR"
    File "${VCREDIST_PATH}"
    nsExec::ExecToLog '"$INSTDIR\vc_redist.x64.exe" /install /quiet /norestart'
    Delete "$INSTDIR\vc_redist.x64.exe"
  vcrt_done:
!endif

  ; ── Install/Update Windows Service ──
  ; Service was already removed at the top of this section (before the
  ; file copies, so node.exe couldn't keep locks on the new binaries).
  ; Just install fresh below — no second remove needed.

!ifdef CENTRAL
  ; ════════════════════════════════════════════════════════════════════
  ; PLC GATEWAY SERVICE (central build). Owns libplctag + every PLC
  ; connection (PLC_MODE unset = embedded owner), listens on 127.0.0.1:3200,
  ; and POSTs tag/connection events to the app's :3102 broadcast seam. Same
  ; lifecycle hardening as the app service. Must be up before the app's
  ; first gateway poll — the app retries, and we also set a service
  ; dependency + start the gateway first.
  ; ════════════════════════════════════════════════════════════════════
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" install ${GATEWAY_SERVICE_NAME} "$INSTDIR\node.exe" "--max-old-space-size=512 --optimize-for-size dist-server\gateway-server.js"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} AppDirectory "$INSTDIR\app"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} DisplayName "${GATEWAY_SERVICE_DISPLAY}"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} Description "Owns PLC (libplctag) connections for the central commissioning server"'
  ; GATEWAY_HOST 127.0.0.1: only the local app talks to it (never exposed).
  ; PLC_MODE=embedded pins this process to owner mode — defensive belt so a
  ; stray PLC_MODE in the machine/user env or a shared .env can never flip the
  ; gateway into remote (which it rejects as fatal).
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} AppEnvironmentExtra PLC_MODE=embedded GATEWAY_PORT=3200 GATEWAY_HOST=127.0.0.1 WS_BROADCAST_URL=http://127.0.0.1:3102/broadcast NODE_ENV=production'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} ObjectName LocalSystem'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} Type SERVICE_WIN32_OWN_PROCESS'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} Start SERVICE_DELAYED_AUTO_START'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} AppNoConsole 1'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} AppExit Default Restart'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} AppThrottle 1500'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} AppRestartDelay 5000'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} AppKillProcessTree 1'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} AppStdout "$DATA_DIR\logs\gateway.log"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} AppStderr "$DATA_DIR\logs\gateway-error.log"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} AppStdoutCreationDisposition 4'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} AppStderrCreationDisposition 4'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} AppRotateFiles 1'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} AppRotateOnline 1'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${GATEWAY_SERVICE_NAME} AppRotateBytes 10485760'
  nsExec::ExecToLog 'sc.exe failure ${GATEWAY_SERVICE_NAME} reset= 86400 actions= restart/5000/restart/5000/restart/30000'
  nsExec::ExecToLog 'sc.exe failureflag ${GATEWAY_SERVICE_NAME} 1'
!endif

  ; Install service — node runs the Express server with a 512MB heap budget.
  ; Heap was 256MB but tight on laptops doing concurrent WAL + sync queue
  ; flushes; bumping to 512MB keeps headroom while staying small enough for
  ; an 8GB tablet.
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" install ${SERVICE_NAME} "$INSTDIR\node.exe" "--max-old-space-size=512 --optimize-for-size dist-server\server-express.js"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppDirectory "$INSTDIR\app"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} DisplayName "${SERVICE_DISPLAY}"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} Description "Industrial I/O commissioning tool — PLC testing and validation"'

  ; ── SERVICE LIFECYCLE — battle-tested for laptops on factory floors ──
  ; Run as LocalSystem (not the installing user). EXPLICIT, even though it's
  ; the NSSM default, because the worst class of bug is "service stops on
  ; user logout" — that only happens if ObjectName is a user account.
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} ObjectName LocalSystem'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} Type SERVICE_WIN32_OWN_PROCESS'

  ; DELAYED auto-start lets Windows finish booting before we try to bind
  ; sockets/talk to PLC. Stops the boot-time race where the network adapter
  ; isn't ready and the service crashes immediately.
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} Start SERVICE_DELAYED_AUTO_START'

  ; No console window — service runs headless.
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppNoConsole 1'

  ; Restart any time the process exits (crash, OOM, panic, anything).
  ; Throttle window 1500ms: if process exits in less than that, NSSM
  ; suspects a config/code crash and waits longer between retries.
  ; AppRestartDelay 5000ms is the *initial* delay between restart attempts.
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppExit Default Restart'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppThrottle 1500'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppRestartDelay 5000'

  ; On stop, kill the entire process tree and graceful-stop sequence: send
  ; Ctrl+C, then close window, then thread terminate, then process kill.
  ; AppKillProcessTree=1 ensures any child processes (if a future build
  ; spawns them) also die cleanly — no orphans blocking upgrades.
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppKillProcessTree 1'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppStopMethodSkip 0'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppStopMethodConsole 5000'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppStopMethodWindow 5000'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppStopMethodThreads 5000'

  ; ── Logging ──
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppStdout "$DATA_DIR\logs\service.log"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppStderr "$DATA_DIR\logs\service-error.log"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppStdoutCreationDisposition 4'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppStderrCreationDisposition 4'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppRotateFiles 1'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppRotateOnline 1'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppRotateBytes 10485760'

  ; ── SCM-level failure recovery (belt + suspenders) ──
  ; If NSSM itself dies or gives up, Windows Service Control Manager will
  ; still restart the service. Reset the failure counter every 24h, and
  ; restart 5s after first/second failure, 30s after third.
  nsExec::ExecToLog 'sc.exe failure ${SERVICE_NAME} reset= 86400 actions= restart/5000/restart/5000/restart/30000'

  ; Trigger restart on any failure type (not just non-zero exit code).
  nsExec::ExecToLog 'sc.exe failureflag ${SERVICE_NAME} 1'

!ifdef CENTRAL
  ; App runs in remote mode and depends on the gateway. PLC_MODE/GATEWAY_URL
  ; are also in .env (belt-and-suspenders), but set them on the service env
  ; too so they apply regardless of dotenv load order. DependOnService makes
  ; the SCM start the gateway before the app.
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppEnvironmentExtra PLC_MODE=remote GATEWAY_URL=http://127.0.0.1:3200'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} DependOnService ${GATEWAY_SERVICE_NAME}'
  ; Start the gateway first so it owns the PLC connections before the app polls.
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" start ${GATEWAY_SERVICE_NAME}'
  Sleep 3000
!endif

  ; ── Firewall Rules ──
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Commissioning Tool - App"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Commissioning Tool - WebSocket"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Commissioning Tool - App" dir=in action=allow protocol=tcp localport=3000'

  ; ── Start Service ──
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" start ${SERVICE_NAME}'

  ; ── Log upgrade event (append to install-history.log for audit trail) ──
  ReadRegStr $1 HKLM "Software\${APP_SHORT}" "Version"
  StrCmp $1 "" fresh_install
    ; Upgrade
    ${GetTime} "" "L" $2 $3 $4 $5 $6 $7 $8
    FileOpen $0 "$DATA_DIR\logs\install-history.log" a
    FileSeek $0 0 END
    FileWrite $0 "$4-$3-$2 $6:$7:$8 UPGRADE v$1 -> v${APP_VERSION}$\r$\n"
    FileClose $0
    Goto reg_write
  fresh_install:
    ${GetTime} "" "L" $2 $3 $4 $5 $6 $7 $8
    FileOpen $0 "$DATA_DIR\logs\install-history.log" a
    FileSeek $0 0 END
    FileWrite $0 "$4-$3-$2 $6:$7:$8 INSTALL v${APP_VERSION} (fresh)$\r$\n"
    FileClose $0
  reg_write:

  ; ── Registry (for uninstall + upgrade detection) ──
  WriteRegStr HKLM "Software\${APP_SHORT}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\${APP_SHORT}" "DataDir" "$DATA_DIR"
  WriteRegStr HKLM "Software\${APP_SHORT}" "Version" "${APP_VERSION}"

  ; ── Add/Remove Programs entry ──
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_SHORT}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_SHORT}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_SHORT}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_SHORT}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_SHORT}" "URLInfoAbout" "${APP_URL}"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_SHORT}" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_SHORT}" "NoRepair" 1

  ; ── Service status helper for ops ──
  File /oname=$INSTDIR\SERVICE-STATUS.bat "templates\SERVICE-STATUS.bat"

  ; ── Start Menu Shortcuts ──
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\Service Status.lnk" "$INSTDIR\SERVICE-STATUS.bat" "" "$INSTDIR\app.ico"
  ; Create a URL shortcut to open the app in browser
  FileOpen $0 "$SMPROGRAMS\${APP_NAME}\Open Commissioning Tool.url" w
  FileWrite $0 "[InternetShortcut]$\r$\n"
  FileWrite $0 "URL=http://localhost:3000$\r$\n"
  FileWrite $0 "IconIndex=0$\r$\n"
  FileWrite $0 "IconFile=$INSTDIR\app.ico$\r$\n"
  FileClose $0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk" "$INSTDIR\uninstall.exe"

  ; ── Desktop Shortcut ──
  FileOpen $0 "$DESKTOP\Commissioning Tool.url" w
  FileWrite $0 "[InternetShortcut]$\r$\n"
  FileWrite $0 "URL=http://localhost:3000$\r$\n"
  FileWrite $0 "IconIndex=0$\r$\n"
  FileWrite $0 "IconFile=$INSTDIR\app.ico$\r$\n"
  FileClose $0

  ; ── Uninstaller ──
  WriteUninstaller "$INSTDIR\uninstall.exe"

SectionEnd

; ── Uninstall Section ───────────────────────────────────────
Section "Uninstall"
  ReadEnvStr $DATA_DIR "ProgramData"
StrCpy $DATA_DIR "$DATA_DIR\CommissioningTool"

  ; Stop and remove service
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" stop ${SERVICE_NAME}'
  Sleep 2000
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" remove ${SERVICE_NAME} confirm'

!ifdef CENTRAL
  ; Central build also has the plc-gateway service.
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" stop ${GATEWAY_SERVICE_NAME}'
  Sleep 2000
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" remove ${GATEWAY_SERVICE_NAME} confirm'
!endif

  ; Remove firewall rules
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Commissioning Tool - App"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Commissioning Tool - WebSocket"'

  ; Remove app files (NOT data directory)
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\vcruntime140.dll"
  Delete "$INSTDIR\vcruntime140_1.dll"
  RMDir /r "$INSTDIR\app"
  Delete "$INSTDIR\nssm.exe"
  Delete "$INSTDIR\app.ico"
  Delete "$INSTDIR\SERVICE-STATUS.bat"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  ; Remove shortcuts
  Delete "$DESKTOP\Commissioning Tool.url"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"

  ; Remove registry
  DeleteRegKey HKLM "Software\${APP_SHORT}"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_SHORT}"

  ; Note: $DATA_DIR (database, config, logs) is intentionally NOT removed
  ; so data is preserved if they reinstall later
  MessageBox MB_YESNO "Remove application data (database, config, logs)?$\r$\n$\r$\nLocation: $DATA_DIR" IDYES remove_data IDNO keep_data
  remove_data:
    RMDir /r "$DATA_DIR"
  keep_data:

SectionEnd
