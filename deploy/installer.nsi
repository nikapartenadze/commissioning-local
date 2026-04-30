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

Var DATA_DIR

; ── Installer Settings ──────────────────────────────────────
Name "${APP_NAME} ${APP_VERSION}"
OutFile "..\CommissioningTool-Setup-v${APP_VERSION}.exe"
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
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name = ''node.exe''\" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(''$INSTDIR'', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"'
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
    nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$found = Get-CimInstance Win32_Process -Filter \"Name = ''node.exe''\" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(''$INSTDIR'', [StringComparison]::OrdinalIgnoreCase) }; if ($found) { $found | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 1 } else { exit 0 }"'
    Pop $2  ; exit code: 0 = no processes left, 1 = had to kill some
    Pop $3  ; (output, ignored)
    StrCmp $2 "0" process_kill_done
    Sleep 2000
    IntOp $1 $1 + 1
    Goto process_kill_loop
  process_kill_done:

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

  ; ── Install/Update Windows Service ──
  ; Service was already removed at the top of this section (before the
  ; file copies, so node.exe couldn't keep locks on the new binaries).
  ; Just install fresh below — no second remove needed.

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

  ; Remove firewall rules
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Commissioning Tool - App"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Commissioning Tool - WebSocket"'

  ; Remove app files (NOT data directory)
  Delete "$INSTDIR\node.exe"
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
