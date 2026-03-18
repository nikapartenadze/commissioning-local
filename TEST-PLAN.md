# IO Checkout Tool — Field Test Plan

**Version:** 1.1
**Date:** 2026-03-17
**Purpose:** Set up and validate the IO Checkout Tool at the factory. Complete each section and send results back.

---

## Part 1: Setup

### 1.1 — Server Setup

The server PC is the Windows machine that will run the app. All tablets/laptops connect to it.

| # | Step | Done? | Notes |
|---|------|-------|-------|
| 1 | Copy the `portable/` folder to the server PC (e.g., `C:\IOCheckout`) | | |
| 2 | Double-click `START.bat` | | |
| 3 | First run: Windows will ask for admin permission (firewall) — click **Yes** | | |
| 4 | Wait for the console to show "IO Checkout Tool" with the URL and IP addresses | | |
| 5 | Note the server IP shown in the console | IP: _______ | |

The app is now running. Leave the console window open.

### 1.2 — Admin First Login

| # | Step | Done? | Notes |
|---|------|-------|-------|
| 1 | On any device, open `http://<SERVER_IP>:3000` | | |
| 2 | Enter PIN `111111` → log in | | |
| 3 | You should see the commissioning page (empty, no IOs yet) | | |

### 1.3 — Change Admin PIN

| # | Step | Done? | Notes |
|---|------|-------|-------|
| 1 | Click user icon (top-right) → **Manage Users** | | |
| 2 | Find "Admin" → click **Reset PIN** | | |
| 3 | Enter your new 6-digit PIN → **Save** | | |
| 4 | New admin PIN: _______ (write it down!) | | |

### 1.4 — Create Technician Accounts

| # | Step | Done? | Notes |
|---|------|-------|-------|
| 1 | Still in Manage Users, enter a technician's full name + 6-digit PIN | | |
| 2 | Click **Create User** | | |
| 3 | Repeat for each technician who will be testing | | |
| 4 | Users created: _______ (list names) | | |

### 1.5 — Pull IOs from Cloud

| # | Step | Done? | Notes |
|---|------|-------|-------|
| 1 | Click the **PLC** button (chip icon in toolbar) | | |
| 2 | You're on the **Cloud Data** tab | | |
| 3 | Enter Subsystem ID: _______ | | |
| 4 | Enter Remote URL: _______ | | |
| 5 | Enter API Password (if required) | | |
| 6 | Click **Pull IOs from Cloud** | | |
| 7 | Wait for "Pulled X IOs" success message | | IOs pulled: _______ |
| 8 | Close the dialog — IO list should now appear in the table | | |

### 1.6 — Connect to PLC

| # | Step | Done? | Notes |
|---|------|-------|-------|
| 1 | Open PLC config again → switch to **PLC Connection** tab | | |
| 2 | Enter PLC IP: _______ | | |
| 3 | Enter Communication Path (e.g., `1,0`): _______ | | |
| 4 | Click **Connect to PLC** | | |
| 5 | Wait for connection — log shows tag count | | Tags OK: _____ / Failed: _____ |
| 6 | If tags failed, click **Copy Report** and save it | | |
| 7 | Close dialog — PLC icon in toolbar should be green | | |

### 1.7 — Verify on a Tablet

| # | Step | Done? | Notes |
|---|------|-------|-------|
| 1 | On a tablet/phone, open `http://<SERVER_IP>:3000` | | |
| 2 | Log in with a technician PIN | | |
| 3 | IO list appears, PLC icon is green | | |
| 4 | State dots should show current PLC states (green/red circles) | | |

**If this works, setup is complete. Move to Part 2.**

**If the tablet can't connect:**
- Check the tablet is on the same network/Wi-Fi as the server
- Try `STATUS.bat` on the server to confirm the IP
- Check if Windows firewall prompt was accepted in step 1.3

---

## Part 2: Testing — Local Network

### Test A: Single User Basic Flow

**Setup:** One device on the same network as the server.

| # | Step | Expected | Pass/Fail | Notes |
|---|------|----------|-----------|-------|
| A1 | Press **START** to begin testing | Button turns red "STOP" | | |
| A2 | Physically trigger an input (sensor/switch) | State dot turns green, Pass/Fail dialog appears | | |
| A3 | Click **Pass** | Row turns green, result shows "Passed" | | |
| A4 | Trigger another input, click **Fail** | Asked for failure mode, row turns red | | |
| A5 | On a failed IO, click the **?** Help button | Diagnostic troubleshooting steps appear | | |
| A6 | Click **FIRE** on an output IO | Output activates on PLC | | |
| A7 | Hold FIRE button, then release | Output stays ON while held, OFF on release | | |
| A8 | Use search bar to find a specific IO | Results filter as you type | | |
| A9 | Click filter buttons (Pass/Fail/Left/In/Out) | List filters correctly | | |
| A10 | Press **STOP** | Returns to START, no errors | | |

**Responsiveness:**
- Input activation → dialog appears: _______ (<1s / 1-3s / >3s)
- Overall feel: _______ (snappy / acceptable / sluggish)

### Test B: Multiple Users (3-5 devices)

**Setup:** 3-5 devices, each logged in as a different user.

| # | Step | Expected | Pass/Fail | Notes |
|---|------|----------|-----------|-------|
| B1 | All devices log in | Each sees IO list with PLC states | | |
| B2 | User A presses START | Only User A sees STOP; others still see START | | |
| B3 | User B presses START | Both A and B see STOP independently | | |
| B4 | Trigger an input | All testing users see the state change | | |
| B5 | User A marks Pass on IO #1, User B marks Fail on IO #2 | Each action goes to the correct IO | | |
| B6 | User A fires an output | All devices see the output state change | | |
| B7 | Two users fire different outputs simultaneously | Both work, no errors | | |
| B8 | User A stops testing | Only A goes back to START; B still testing | | |
| B9 | Admin pulls new IOs | All devices refresh automatically | | |
| B10 | Admin disconnects PLC | All devices show red PLC icon | | |

**Observations:**
- Devices stay in sync? (yes / sometimes / no): _______
- Any "Server returned 500" errors? (yes — describe / no): _______
- Any WebSocket disconnects? (yes — describe / no): _______

---

## Part 3: Testing — Remote Access via Tailscale

*Connect to the server via Tailscale (use the server's Tailscale IP instead of the local IP), then repeat the same tests from Part 2.*

| # | Step | Expected | Pass/Fail | Notes |
|---|------|----------|-----------|-------|
| C1 | Connect to Tailscale on your device | Connected | | |
| C2 | Open `http://<TAILSCALE_IP>:3000` | Login page loads | | |
| C3 | Repeat tests A1–A8 via Tailscale | Same results as local | | Note any extra lag |
| C4 | Repeat tests B1–B3 with one user local + one via Tailscale | Both users see updates | | |

---

## Part 4: Resilience

| # | Step | Expected | Pass/Fail | Notes |
|---|------|----------|-----------|-------|
| R1 | Disconnect Wi-Fi for 10 sec, reconnect | App shows "Reconnecting...", then resumes | | |
| R2 | Lock tablet screen for 2 min, unlock | App works or auto-reconnects | | |
| R3 | Close browser tab, reopen URL | Login page, can resume after login | | |
| R4 | (VPN) Disconnect Tailscale, reconnect | App resumes | | |

---

## Part 5: Performance

| # | Step | Expected | Pass/Fail | Notes |
|---|------|----------|-----------|-------|
| P1 | Scroll through full IO list (1000+) | Smooth scrolling | | |
| P2 | Search/filter with 1000+ IOs | Instant results | | |
| P3 | Check server Task Manager while 5 users connected | Node.js memory: _______ MB, CPU: _______ % | | |

---

---

## Issues Found

| # | Description | Severity (blocking / annoying / minor) | How to reproduce |
|---|-------------|---------------------------------------|------------------|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |

---

## Summary

| Category | Rating (1-5) | Comments |
|----------|:---:|----------|
| Setup process | | |
| Local network — single user | | |
| Local network — multi user | | |
| Tailscale VPN (if tested) | | |
| Mobile/tablet usability | | |
| Overall reliability | | |
| **Ready for production?** | **Yes / No / With caveats** | |

**Tester:** _______
**Date:** _______
**Time spent:** _______
