IO Checkout Tool - Portable Distribution
=========================================

ZERO INSTALL REQUIRED. Everything is included.

FIRST TIME SETUP:
  1. Double-click START.bat
     (Firewall, database, and diagnostic help data are set up automatically)

DAILY USE:
  START.bat    — Launch the app (close the window to stop)
  STATUS.bat   — Check if running, show tablet access URLs

ACCESS:
  On this PC:  http://localhost:3000
  On tablets:  http://THIS_PC_IP:3000  (run STATUS.bat to see the IP)
  Admin PIN:   111111

PORTS:
  3000  — Web app + WebSocket (HTTP + real-time PLC updates)

TROUBLESHOOTING:
  - If tablets can't connect, run SETUP-FIREWALL.bat as Administrator
  - If PLC won't connect, check IP address and that PLC is on the network
  - App data is stored in app\database.db (auto-backed up before cloud pulls)
