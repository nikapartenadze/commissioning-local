# IO Checkout Tool — Field Test Plan

**Version:** 1.0
**Date:** 2026-03-16
**Purpose:** Validate the IO Checkout Tool works reliably in factory network conditions, including Tailscale VPN access. Please complete each section and send results back.

---

## Test Environment Info (fill in)

| Item | Value |
|------|-------|
| Server PC (running the app) | OS: _______ / IP: _______ |
| Server Node.js version | `node --version`: _______ |
| Number of test devices (tablets/phones/laptops) | _______ |
| Device types & browsers | e.g. iPad Safari, Android Chrome, Windows Chrome |
| Network type | Factory LAN / Wi-Fi / Tailscale VPN / Mixed |
| Tailscale version (if used) | _______ |
| PLC model & IP | _______ |
| Subsystem ID being tested | _______ |
| Number of IOs in subsystem | _______ |

---

## Test 1: Local Network — Single User

**Setup:** One tablet/laptop on the same LAN/Wi-Fi as the server PC. No VPN.

| # | Step | Expected | Pass/Fail | Notes |
|---|------|----------|-----------|-------|
| 1.1 | Open `http://<SERVER_IP>:3000` in browser | Login page loads within 2-3 seconds | | |
| 1.2 | Log in with PIN | Commissioning page loads, IO list appears | | |
| 1.3 | Admin: Open PLC config, connect to PLC | PLC connects, green status shows | | |
| 1.4 | Start testing mode | START button changes to red STOP | | |
| 1.5 | Trigger a physical input (sensor/switch) | State dot turns green within ~1 second, Pass/Fail dialog appears | | |
| 1.6 | Mark as Passed | Row turns green, result shows "Passed" | | |
| 1.7 | Fire an output (press FIRE button) | Output activates on PLC, state changes | | |
| 1.8 | Scroll through IO list | Smooth scrolling, no lag or stutter | | |
| 1.9 | Stop testing mode | STOP → START, no errors | | |

**Latency observations:**
- Time from physical input activation to dialog appearing: _______ (estimate: <1s / 1-3s / >3s)
- General responsiveness (snappy / acceptable / sluggish): _______

---

## Test 2: Local Network — Multiple Users (3-5 simultaneous)

**Setup:** 3-5 devices on the same LAN/Wi-Fi. All logged in as different users.

| # | Step | Expected | Pass/Fail | Notes |
|---|------|----------|-----------|-------|
| 2.1 | All devices log in with different PINs | Each sees the commissioning page | | |
| 2.2 | User A starts testing | Only User A sees STOP button; others still see START | | |
| 2.3 | User B starts testing | User B sees STOP; User A still sees STOP (independent) | | |
| 2.4 | Trigger an input while multiple users are testing | All testing users see the state change in real-time | | |
| 2.5 | User A marks Pass, User B marks a different IO as Fail | Each user's action applies to the correct IO | | |
| 2.6 | User A fires an output | All devices see the state change | | |
| 2.7 | Two users fire different outputs at the same time | Both outputs activate correctly, no errors | | |
| 2.8 | User A stops testing | Only User A returns to START; User B still testing | | |
| 2.9 | Admin pulls new IOs (cloud pull) | All devices refresh IO list automatically (no manual reload) | | |
| 2.10 | Admin disconnects PLC | All devices show PLC disconnected (red icon) automatically | | |

**Observations:**
- Do all devices stay in sync? (yes / sometimes / no): _______
- Any "Server returned 500" errors? (yes — describe / no): _______
- Any devices lose WebSocket connection? (yes — describe / no): _______

---

## Test 3: Tailscale VPN — Single User

**Setup:** One device connected via Tailscale VPN (not on local network). Server is on factory LAN.

| # | Step | Expected | Pass/Fail | Notes |
|---|------|----------|-----------|-------|
| 3.1 | Confirm Tailscale is connected | `tailscale status` shows server device online | | |
| 3.2 | Note the Tailscale IP of the server | IP: _______ | | |
| 3.3 | Open `http://<TAILSCALE_IP>:3000` | Login page loads | | |
| 3.4 | Note page load time | _______ seconds | | |
| 3.5 | Log in with PIN | Commissioning page loads with IO data | | |
| 3.6 | Note IO list load time | _______ seconds | | |
| 3.7 | Start testing, trigger a physical input | Pass/Fail dialog appears | | |
| 3.8 | Note delay from input activation to dialog | _______ seconds (estimate) | | |
| 3.9 | Fire an output | Output activates on PLC | | |
| 3.10 | Note delay from button press to state change | _______ seconds | | |
| 3.11 | Scroll through IO list rapidly | Smooth / jerky / freezing? | | |
| 3.12 | Leave the page open for 5 minutes idle, then interact | Still responsive? WebSocket still connected? | | |

**Key question:** Is the lag on Tailscale tolerable for commissioning work? (yes / no / borderline): _______

---

## Test 4: Tailscale VPN — Multiple Users

**Setup:** 2+ devices on Tailscale VPN simultaneously. Optionally mix with local network devices.

| # | Step | Expected | Pass/Fail | Notes |
|---|------|----------|-----------|-------|
| 4.1 | Both VPN devices log in | Both see commissioning page | | |
| 4.2 | Both start testing | Each has independent testing state | | |
| 4.3 | Trigger input, check both devices see it | Real-time state update on both | | |
| 4.4 | Note sync delay between devices | _______ seconds | | |
| 4.5 | One device marks Pass, check other device sees update | Result appears on both devices | | |
| 4.6 | Mix: 1 device local + 1 device VPN, trigger input | Both see state change, compare timing | | |

**Observations:**
- VPN user lag compared to local user: (similar / noticeably slower / unusable): _______
- Any WebSocket disconnections on VPN? (yes — how often / no): _______

---

## Test 5: Network Resilience

| # | Step | Expected | Pass/Fail | Notes |
|---|------|----------|-----------|-------|
| 5.1 | Disconnect Wi-Fi on a device for 10 seconds, reconnect | App recovers, shows "Reconnecting..." banner, then resumes | | |
| 5.2 | Switch a device from Wi-Fi to cellular (or vice versa) | App reconnects automatically | | |
| 5.3 | Disconnect Tailscale VPN, reconnect | App resumes after VPN reconnects | | |
| 5.4 | Close browser tab, reopen the URL | Login page appears, can log back in and resume | | |
| 5.5 | Lock tablet screen for 2 minutes, unlock | App still works or auto-reconnects | | |

---

## Test 6: Ports & Firewall

Both ports **3000** (HTTP) and **3001** (WebSocket) must be accessible from client devices.

| # | Step | Expected | Pass/Fail | Notes |
|---|------|----------|-----------|-------|
| 6.1 | From a client device, test HTTP: open `http://<SERVER_IP>:3000` | Page loads | | |
| 6.2 | Check WebSocket: open browser console, look for WS connection | Console shows WebSocket connected (no red errors) | | |
| 6.3 | If using Tailscale: confirm ports are not blocked by Tailscale ACLs | Both 3000 and 3002 accessible via Tailscale IP | | |
| 6.4 | If Windows firewall: confirm rules exist | Run `netsh advfirewall firewall show rule name="IO Checkout"` | | |

**Note:** If WebSocket (port 3002) is blocked, the app will load but real-time updates won't work — state changes won't appear until manual page refresh.

---

## Test 7: Performance Under Load

| # | Step | Expected | Pass/Fail | Notes |
|---|------|----------|-----------|-------|
| 7.1 | With 1000+ IOs loaded, scroll the list | Smooth virtual scrolling | | |
| 7.2 | Use search/filter with 1000+ IOs | Results appear instantly | | |
| 7.3 | 5 users connected, rapid input changes on PLC | All devices update, server CPU stays reasonable | | |
| 7.4 | Check server memory: Task Manager on server PC | Node.js memory usage: _______ MB | | |

---

## Issues & Observations

Use this space to document anything unexpected:

| Issue # | Description | Severity (blocking/annoying/minor) | Steps to reproduce |
|---------|-------------|------------------------------------|--------------------|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |

---

## Tailscale-Specific Troubleshooting

If Tailscale is lagging, please also record:

1. **Ping from VPN device to server:** `ping <TAILSCALE_IP>` — average latency: _______ ms
2. **Tailscale relay or direct?** Run `tailscale status` — does it show "relay" or "direct"?
   - If **relay (DERP)**: Traffic is going through Tailscale's relay servers. This adds 50-200ms latency. To fix: ensure both devices can establish direct WireGuard connections (may need UDP port 41641 open on NAT/firewall).
   - If **direct**: Latency should be similar to normal network. If still slow, the issue is elsewhere.
3. **Tailscale exit node?** Is an exit node enabled? Disable it for local factory access.
4. **MTU issues?** Try `ping -f -l 1400 <TAILSCALE_IP>` (Windows) — if it fails, there may be MTU/fragmentation issues.

---

## Summary (fill in after testing)

| Category | Rating (1-5, 5=excellent) | Comments |
|----------|--------------------------|----------|
| Local network single user | | |
| Local network multi-user | | |
| Tailscale VPN single user | | |
| Tailscale VPN multi-user | | |
| Overall reliability | | |
| Ready for production use? | Yes / No / With caveats | |

**Tester name:** _______
**Test date:** _______
**Total time spent testing:** _______
