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
  !define APP_VERSION "2.23.2"
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

; ── Install Section ─────────────────────────────────────────
Section "Install"
  SetOutPath "$INSTDIR"
  ReadEnvStr $DATA_DIR "ProgramData"
StrCpy $DATA_DIR "$DATA_DIR\CommissioningTool"

  ; Stop existing service if upgrading
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" stop ${SERVICE_NAME}'
  ; Wait for service to stop
  Sleep 2000

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

  ; ── Initialize database if first install ──
  IfFileExists "$DATA_DIR\database.db" db_exists
    ; First install — copy database from portable build
    CopyFiles /SILENT "$INSTDIR\app\database.db" "$DATA_DIR\database.db"
  db_exists:

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
  ; Remove old service if exists (clean reinstall)
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" remove ${SERVICE_NAME} confirm'
  Sleep 1000

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
