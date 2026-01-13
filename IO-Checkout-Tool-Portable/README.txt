IO CHECKOUT TOOL - PORTABLE VERSION
====================================

BEFORE FIRST USE:
1. Open the backend folder
2. Rename config.json.template to config.json
3. Edit config.json with Notepad - set the PLC IP address and path
4. See FACTORY-SETUP.txt for detailed instructions

STARTING:
1. Double-click START.bat
2. Wait for both servers to start (about 10 seconds)
3. Browser opens automatically to http://localhost:3000
4. Default admin PIN: 852963

STOPPING:
- Double-click STOP.bat

ACCESS FROM OTHER COMPUTERS:
- Find this computer's IP address (run: ipconfig)
- On tablets/other PCs, open browser to: http://THIS_COMPUTER_IP:3000
- Example: http://192.168.1.50:3000

MULTIPLE USERS:
- Multiple people can test the same subsystem at the same time
- All browsers show live updates when someone marks a point passed/failed
- Each person should log in with their own PIN

FIREWALL:
If other computers cannot connect, run these commands as Administrator:
  netsh advfirewall firewall add rule name="IO Checkout 5000" dir=in action=allow protocol=tcp localport=5000
  netsh advfirewall firewall add rule name="IO Checkout 3000" dir=in action=allow protocol=tcp localport=3000

FILES:
- backend/           - Application server
- backend/config.json - PLC connection settings (you must create this)
- backend/database.db - Test data (created automatically)
- frontend/          - Web interface
- nodejs/            - Node.js runtime
- FACTORY-SETUP.txt  - Detailed setup instructions

TROUBLESHOOTING:
- Backend fails: Check config.json exists and has correct PLC IP
- Cannot connect to PLC: Verify network connection and IP address
- Other computers cannot access: Check firewall rules above
- See config-help.txt in backend folder for configuration details
