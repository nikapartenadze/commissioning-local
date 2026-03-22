; IO Checkout Tool — NSIS Installer Script
; Builds a Windows installer with NSSM service integration
;
; Features:
;   - Installs app + bundled Node.js + NSSM service
;   - Upgrades in-place (preserves database + config)
;   - Auto-starts on boot, restarts on crash
;   - Firewall rules for ports 3000 + 3002
;   - Clean uninstall (stops service, removes firewall rules)

!include "MUI2.nsh"
!include "FileFunc.nsh"

; ── Version & Metadata ──────────────────────────────────────
!define APP_NAME "IO Checkout Tool"
!define APP_SHORT "IOCheckout"
!define APP_PUBLISHER "autStand"
!define APP_URL "https://commissioning.lci.ge"
!ifndef APP_VERSION
  !define APP_VERSION "2.8.0"
!endif

!define INSTALL_DIR "$PROGRAMFILES\${APP_SHORT}"
!define SERVICE_NAME "IOCheckout"
!define SERVICE_DISPLAY "IO Checkout Tool"

Var DATA_DIR

; ── Installer Settings ──────────────────────────────────────
Name "${APP_NAME} ${APP_VERSION}"
OutFile "..\IOCheckout-Setup-v${APP_VERSION}.exe"
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
StrCpy $DATA_DIR "$DATA_DIR\IOCheckout"

  ; Stop existing service if upgrading
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" stop ${SERVICE_NAME}'
  ; Wait for service to stop
  Sleep 2000

  ; ── Create data directory (preserved across upgrades) ──
  CreateDirectory "$DATA_DIR"
  CreateDirectory "$DATA_DIR\logs"
  CreateDirectory "$DATA_DIR\backups"

  ; ── Copy app files (replaced on upgrade) ──
  SetOutPath "$INSTDIR\node"
  File /r "${PORTABLE_DIR}\node\*.*"

  SetOutPath "$INSTDIR\app"
  File /r "${PORTABLE_DIR}\app\*.*"

  ; ── Copy NSSM + icon ──
  SetOutPath "$INSTDIR"
  File "${NSSM_PATH}"
  File "app.ico"

  ; ── Create .env pointing to data directory ──
  FileOpen $0 "$INSTDIR\app\.env" w
  FileWrite $0 "DATABASE_URL=file:$DATA_DIR\database.db$\r$\n"
  FileWrite $0 "JWT_SECRET_KEY=io-checkout-svc-$HWNDPARENT$\r$\n"
  FileWrite $0 "PLC_WS_PORT=3002$\r$\n"
  FileWrite $0 "PORT=3000$\r$\n"
  FileWrite $0 "HOSTNAME=0.0.0.0$\r$\n"
  FileWrite $0 "NODE_ENV=production$\r$\n"
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

  ; Install service
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" install ${SERVICE_NAME} "$INSTDIR\node\node.exe" "server.js"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppDirectory "$INSTDIR\app"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} DisplayName "${SERVICE_DISPLAY}"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} Description "Industrial I/O commissioning tool — PLC testing and validation"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} Start SERVICE_AUTO_START'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppStdout "$DATA_DIR\logs\service.log"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppStderr "$DATA_DIR\logs\service-error.log"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppStdoutCreationDisposition 4'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppStderrCreationDisposition 4'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppRotateFiles 1'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppRotateBytes 10485760'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppExit Default Restart'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SERVICE_NAME} AppRestartDelay 5000'

  ; ── Firewall Rules ──
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="IO Checkout - App"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="IO Checkout - WebSocket"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="IO Checkout - App" dir=in action=allow protocol=tcp localport=3000'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="IO Checkout - WebSocket" dir=in action=allow protocol=tcp localport=3002'

  ; ── Start Service ──
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" start ${SERVICE_NAME}'

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

  ; ── Start Menu Shortcuts ──
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  ; Create a URL shortcut to open the app in browser
  FileOpen $0 "$SMPROGRAMS\${APP_NAME}\Open IO Checkout.url" w
  FileWrite $0 "[InternetShortcut]$\r$\n"
  FileWrite $0 "URL=http://localhost:3000$\r$\n"
  FileWrite $0 "IconIndex=0$\r$\n"
  FileWrite $0 "IconFile=$INSTDIR\app.ico$\r$\n"
  FileClose $0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk" "$INSTDIR\uninstall.exe"

  ; ── Desktop Shortcut ──
  FileOpen $0 "$DESKTOP\IO Checkout.url" w
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
StrCpy $DATA_DIR "$DATA_DIR\IOCheckout"

  ; Stop and remove service
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" stop ${SERVICE_NAME}'
  Sleep 2000
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" remove ${SERVICE_NAME} confirm'

  ; Remove firewall rules
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="IO Checkout - App"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="IO Checkout - WebSocket"'

  ; Remove app files (NOT data directory)
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\app"
  Delete "$INSTDIR\nssm.exe"
  Delete "$INSTDIR\app.ico"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  ; Remove shortcuts
  Delete "$DESKTOP\IO Checkout.url"
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
