IO Checkout Tool — Windows Installer Guide
===========================================

WHAT THIS INSTALLER DOES
  - Installs the IO Checkout Tool as a Windows service
  - App runs in the background automatically — no CMD window
  - Auto-starts on Windows boot, restarts on crash
  - Opens firewall ports 3000 + 3002

FIRST TIME INSTALL
  1. Run IOCheckout-Setup-vX.X.X.exe (requires admin)
  2. Click Next → Install → Finish
  3. Open http://localhost:3000 in your browser
  4. Log in with PIN: 111111 (change it immediately)
  5. A desktop shortcut "IO Checkout" is created automatically

UPGRADING TO A NEW VERSION
  Just run the new IOCheckout-Setup-vX.X.X.exe
  - No need to uninstall the old version
  - Database, config, and test results are preserved
  - The installer stops the service, updates files, restarts

ACCESSING THE APP
  On this PC:     http://localhost:3000
  On tablets:     http://THIS_PC_IP:3000
  Desktop shortcut: "IO Checkout" (opens browser)
  Start Menu:       IO Checkout Tool > Open IO Checkout

SERVICE MANAGEMENT
  The app runs as a Windows service called "IOCheckout".
  It starts automatically on boot — you don't need to do anything.

  To check status:    Open Services (services.msc) → find "IO Checkout Tool"
  To stop manually:   Run in admin CMD: nssm stop IOCheckout
  To start manually:  Run in admin CMD: nssm start IOCheckout
  To restart:         Run in admin CMD: nssm restart IOCheckout

WHERE FILES ARE STORED
  App files:     C:\Program Files\IOCheckout\        (replaced on upgrade)
  Database:      C:\ProgramData\IOCheckout\           (preserved on upgrade)
  Config:        C:\ProgramData\IOCheckout\config.json
  Logs:          C:\ProgramData\IOCheckout\logs\
  Backups:       C:\ProgramData\IOCheckout\backups\

UNINSTALLING
  Control Panel → Add/Remove Programs → IO Checkout Tool → Uninstall
  - Stops the service and removes app files
  - Asks whether to keep or delete your data (database, config, logs)

PORTS
  3000  — Web app (HTTP) — technicians connect here
  3002  — WebSocket — real-time PLC state updates (auto-connected by the UI)
  Both ports are opened in Windows Firewall during install.

TROUBLESHOOTING
  App not loading:
    - Check service is running: services.msc → "IO Checkout Tool"
    - Check logs: C:\ProgramData\IOCheckout\logs\service.log

  Tablets can't connect:
    - Use this PC's IP address, not "localhost"
    - Check firewall: ports 3000 and 3002 must be open
    - Run "ipconfig" to find the IP

  After upgrade, old data missing:
    - Data is in C:\ProgramData\IOCheckout\ — check database.db exists
    - Pull IOs from cloud to refresh

  Service won't start after upgrade:
    - Run as admin: nssm restart IOCheckout
    - Check logs: C:\ProgramData\IOCheckout\logs\service-error.log
