"use client"

import { useState, useCallback } from "react"
import {
  ArrowLeft, ArrowRight, CheckCircle2, Cpu,
  Play, Cloud, Download, Search,
  Network, Settings, Users, HelpCircle, AlertTriangle,
  Zap, MessageSquare, RotateCcw, Home, BookOpen, Wrench,
  Database, FileDown, ClipboardList, UserPlus, Shield
} from "lucide-react"
import Link from "next/link"
import { cn } from "@/lib/utils"

// ── Guide Steps ─────────────────────────────────────────────────

interface GuideStep {
  id: string
  title: string
  icon: React.ReactNode
  content: React.ReactNode
  adminOnly?: boolean // Only shown when admin view is toggled on
}

const steps: GuideStep[] = [
  {
    id: "welcome",
    title: "Welcome",
    icon: <Home className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p className="text-lg">
          This app helps you test every input and output on a PLC system. Your job is simple:
        </p>
        <div className="bg-card border rounded-lg p-4 space-y-2">
          <p className="text-sm"><strong>1.</strong> Log in with your PIN</p>
          <p className="text-sm"><strong>2.</strong> Press <strong>START</strong></p>
          <p className="text-sm"><strong>3.</strong> Go to the panel and trigger a device (flip a switch, block a sensor, etc.)</p>
          <p className="text-sm"><strong>4.</strong> The app detects the change and asks: <strong className="text-green-500">Pass</strong> or <strong className="text-red-500">Fail</strong>?</p>
          <p className="text-sm"><strong>5.</strong> Click your answer — move to the next device — repeat</p>
        </div>
        <p className="text-sm text-muted-foreground">
          That's the entire workflow. Everything else — cloud sync, comments, exports — happens automatically or is optional.
          This guide covers each part in detail.
        </p>
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
          <p className="text-sm text-blue-400 font-medium">This guide is read-only</p>
          <p className="text-sm text-muted-foreground mt-1">
            Nothing in this guide affects your real data, PLC connection, or test results.
            You can read through it safely at any time.
          </p>
        </div>
        <Video src="/guide/flow-full-workflow.webm" caption="Full workflow overview — login, navigate, search, test" />
      </div>
    ),
  },
  {
    id: "login",
    title: "Logging In",
    icon: <Users className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>Open the app URL on your tablet or laptop browser. You'll see the login screen with a number pad.</p>
        <Video src="/guide/flow-tech-login.webm" caption="Login flow — enter your 6-digit PIN" />
        <Screenshot src="/guide/login.png" alt="Login screen with PIN entry" />
        <StepList steps={[
          "Tap your 6-digit PIN on the number pad",
          "Tap the checkmark button to log in",
          "The IO list loads — you're ready to work",
        ]} />
        <Tip>Your admin will give you your PIN. If you're the admin setting up for the first time, the default PIN is <strong>111111</strong>.</Tip>
        <div className="bg-card border rounded-lg p-3 text-sm space-y-1">
          <p><strong>After login you'll see:</strong></p>
          <p className="text-muted-foreground">A table with all the IO points for your subsystem. Each row is one device connection (a sensor, motor, switch, etc.) that needs to be tested. If the table is empty, your admin needs to pull IOs from cloud first.</p>
        </div>
      </div>
    ),
  },
  {
    id: "pull-ios",
    title: "Pulling IOs from Cloud",
    icon: <Cloud className="w-5 h-5" />,
    adminOnly: true,
    content: (
      <div className="space-y-4">
        <p>Before testing, you need to load the IO list from the cloud server.</p>
        <StepList steps={[
          "Click the PLC chip icon in the toolbar (it will be red initially)",
          "You're on the Cloud Data tab",
          "Enter the Subsystem ID (your admin will provide this)",
          "Enter the Remote URL (cloud server address)",
          "Enter the API Password",
          "Click \"Pull IOs from Cloud\"",
          "Wait for the success message showing how many IOs were loaded",
          "Close the dialog — IO list appears in the table",
        ]} />
        <Tip>These settings are saved automatically. You only need to enter them once — they persist after app restart.</Tip>
      </div>
    ),
  },
  {
    id: "connect-plc",
    title: "Connecting to PLC",
    icon: <Cpu className="w-5 h-5" />,
    adminOnly: true,
    content: (
      <div className="space-y-4">
        <p>Connect to the Allen-Bradley PLC to read live tag states.</p>
        <Screenshot src="/guide/plc-config.png" alt="PLC connection settings" />
        <StepList steps={[
          "Open PLC config dialog → switch to PLC Connection tab",
          "Enter the PLC IP address (your admin will provide this)",
          "Enter the Communication Path (usually 1,0)",
          "Click \"Connect to PLC\"",
          "Wait for the connection log — it shows how many tags were loaded",
          "Close the dialog — PLC icon turns green",
        ]} />
        <Warning>If tags fail, click \"Copy Report\" and send it to your admin. Failed tags usually mean the tag names don't match the PLC program.</Warning>
      </div>
    ),
  },
  {
    id: "toolbar",
    title: "Understanding the Toolbar",
    icon: <Settings className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>The toolbar at the top of the screen has everything you need. Here's what each part does:</p>
        <Screenshot src="/guide/toolbar.png" alt="Main toolbar with status indicators" />
        <div className="space-y-3">
          <div className="bg-card border rounded-lg p-3 text-sm">
            <p className="font-medium">START / STOP button</p>
            <p className="text-muted-foreground mt-1">Toggles testing mode. When green (START), testing is off. Press it to begin — it turns red (STOP). While testing is active, the app watches for state changes on the PLC.</p>
          </div>
          <div className="bg-card border rounded-lg p-3 text-sm">
            <p className="font-medium">Pass / Fail / Left counters</p>
            <p className="text-muted-foreground mt-1">Shows how many IOs you've passed, failed, and how many are left to test. Click any counter to filter the table to show only those IOs.</p>
          </div>
          <div className="bg-card border rounded-lg p-3 text-sm">
            <p className="font-medium">Connection status bar (Cloud → Backend → PLC → Modules)</p>
            <p className="text-muted-foreground mt-1">Shows the health of each connection in the chain. You need all of these green for testing to work.</p>
          </div>
        </div>
        <h3 className="text-sm font-semibold mt-2">Status colors</h3>
        <div className="grid gap-2">
          <IndicatorRow icon={<div className="w-3 h-3 rounded-full bg-green-500" />} label="Green" desc="Connected and working" />
          <IndicatorRow icon={<div className="w-3 h-3 rounded-full bg-red-500" />} label="Red" desc="Not connected — ask your admin to configure" />
          <IndicatorRow icon={<div className="w-3 h-3 rounded-full bg-amber-500 animate-pulse" />} label="Amber" desc="Reconnecting — wait, it recovers automatically" />
        </div>
      </div>
    ),
  },
  {
    id: "testing-input",
    title: "Testing an Input",
    icon: <CheckCircle2 className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p className="text-lg font-medium">This is your main workflow — what you'll do for every IO.</p>
        <StepList steps={[
          "Press the green START button in the toolbar — this puts the app in testing mode",
          "Walk to the electrical panel and trigger the device you want to test (flip a switch, block a sensor, press a button — whatever that IO is wired to)",
          "Come back to your tablet — a dialog has appeared automatically because the app detected the state change",
        ]} />
        <Screenshot src="/guide/pass-fail-dialog.png" alt="Pass/Fail dialog — appears automatically when the app detects a state change" />
        <div className="bg-card border rounded-lg p-3 text-sm space-y-2">
          <p><strong>What to click:</strong></p>
          <p><strong className="text-green-500">Pass</strong> — the correct IO responded to your action. The wiring is good.</p>
          <p><strong className="text-red-500">Fail</strong> — the wrong IO responded, or nothing happened. Something is wrong.</p>
          <p><strong>Cancel</strong> — skip this one for now and come back later.</p>
        </div>
        <p className="text-sm text-muted-foreground">After you click Pass or Fail, the row in the table updates with the result. Move on to the next device and repeat.</p>
        <Screenshot src="/guide/io-grid-results.png" alt="IO testing grid — green rows passed, red rows failed, gray rows not yet tested" />
        <Warning>You don't need to find the IO in the table first. Just trigger the device — the app finds it for you. The dialog shows which IO changed so you can confirm it's the right one.</Warning>
        <Tip>If you press START and nothing happens when you trigger a device, check that the PLC icon in the toolbar is green (connected). If it's red, the PLC isn't connected yet — ask your admin.</Tip>
      </div>
    ),
  },
  {
    id: "testing-fail",
    title: "When an IO Fails",
    icon: <AlertTriangle className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>When you click <strong className="text-red-500">Fail</strong>, this form appears to document the failure:</p>
        <Screenshot src="/guide/fail-dialog.png" alt="Failure details form — select reason and add comments" />
        <StepList steps={[
          "Select the failure reason from the dropdown (required)",
          "Optionally type a comment with more detail about the problem",
          "Click Confirm Failure to save",
        ]} />
        <Tip>Comments are synced to the cloud dashboard. Off-site engineers can see your failure notes in real-time and help troubleshoot without being at the panel.</Tip>
      </div>
    ),
  },
  {
    id: "testing-output",
    title: "Testing an Output (Fire)",
    icon: <Zap className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>Inputs are triggered by you at the panel — the app detects them. But <strong>outputs</strong> work the other way: you activate them from the app and verify at the panel that the right thing happens.</p>
        <div className="bg-card border rounded-lg p-3 text-sm space-y-1">
          <p><strong>Input</strong> = you trigger the device → app detects it (sensor, switch, button)</p>
          <p><strong>Output</strong> = app activates the device → you verify it (motor, valve, light)</p>
        </div>
        <Screenshot src="/guide/fire-output.png" alt="Fire button — hold to activate output on PLC" />
        <StepList steps={[
          "Find the output IO in the table (use the \"Out\" filter button to show only outputs)",
          "Click and HOLD the FIRE button (lightning bolt icon) on that row",
          "While holding: look at the panel — the device should activate (motor spins, light turns on, valve opens)",
          "Release the button — the device turns OFF",
          "The Pass/Fail dialog appears — mark the result based on what you observed",
        ]} />
        <Warning>The FIRE button activates real equipment. Before pressing it, make sure the area around the device is clear and safe. Never fire an output while someone is working near the equipment.</Warning>
      </div>
    ),
  },
  {
    id: "comments",
    title: "Adding Comments",
    icon: <MessageSquare className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>You can add notes to any IO — useful for documenting issues, observations, or context for off-site engineers.</p>
        <StepList steps={[
          "Find the IO in the table — look for the \"+ Add note\" text in the Notes column",
          "Click it and type your comment",
          "Comments save automatically — no save button needed",
          "Your comment syncs to the cloud within 1-2 seconds",
        ]} />
        <Tip>Comments are visible to everyone — other technicians on site and engineers on the cloud dashboard. Use them to leave notes like \"wire loose on terminal 3\" or \"need to recheck after panel power cycle\".</Tip>
      </div>
    ),
  },
  {
    id: "reset",
    title: "Resetting a Test Result",
    icon: <RotateCcw className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>If you need to re-test an IO, you can clear its result.</p>
        <Screenshot src="/guide/reset-action.png" alt="Reset button (circular arrow) clears the test result" />
        <StepList steps={[
          "Find the IO in the table",
          "Click the reset button (circular arrow icon) on that row",
          "The result is cleared — the IO goes back to \"Not Tested\"",
          "You can now test it again",
        ]} />
        <Warning>The old result is preserved in the test history (audit trail). Resetting doesn't delete history — it just allows re-testing.</Warning>
      </div>
    ),
  },
  {
    id: "sync",
    title: "Cloud Sync",
    icon: <Cloud className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>You don't need to do anything for sync — it's fully automatic.</p>
        <div className="bg-card border rounded-lg p-3 text-sm space-y-2">
          <p>Every time you mark Pass or Fail, the result is:</p>
          <p className="text-muted-foreground"><strong>1.</strong> Saved to the local database immediately (crash-safe, never lost)</p>
          <p className="text-muted-foreground"><strong>2.</strong> Pushed to the cloud within 1-2 seconds</p>
          <p className="text-muted-foreground"><strong>3.</strong> Visible to off-site engineers on the cloud dashboard in real-time</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <InfoCard icon={<Zap />} title="Instant Push" desc="Every Pass/Fail syncs within 1-2 seconds" />
          <InfoCard icon={<RotateCcw />} title="Auto Retry" desc="If cloud is offline, retries every 30 seconds" />
          <InfoCard icon={<Download />} title="Multi-User" desc="Other technicians' results appear within 60 seconds" />
          <InfoCard icon={<CheckCircle2 />} title="Offline Safe" desc="Lose Wi-Fi? Keep testing. Syncs when you reconnect" />
        </div>
        <Tip>You never need to manually sync, save, or upload anything. Just test and the rest happens automatically.</Tip>
      </div>
    ),
  },
  {
    id: "network",
    title: "Network Topology",
    icon: <Network className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>The Network tab shows the DLR ring topology and connected devices with live status.</p>
        <Screenshot src="/guide/network-view.png" alt="Network topology — ring layout with status indicators" />
        <StepList steps={[
          "Click the Network tab at the top of the page",
          "You'll see the ring layout: MCM controller → DPM nodes → back to MCM",
          "Click any DPM node to expand and see its connected devices",
          "Each device shows live status from the PLC",
        ]} />
        <div className="grid gap-2 mt-2">
          <IndicatorRow icon={<div className="w-3 h-3 rounded-full bg-green-500" />} label="Green" desc="Device is healthy (ConnectionFaulted = false)" />
          <IndicatorRow icon={<div className="w-3 h-3 rounded-full bg-red-500" />} label="Red" desc="Device is faulted (ConnectionFaulted = true)" />
          <IndicatorRow icon={<div className="w-3 h-3 rounded-full bg-gray-500" />} label="Gray" desc="No status tag or can't read" />
        </div>
        <Tip>Click on any device card to see its name, IP address, and port number.</Tip>
      </div>
    ),
  },
  {
    id: "reconnect",
    title: "Connection Loss & Recovery",
    icon: <AlertTriangle className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>The app handles connection problems automatically. Here's what happens:</p>
        <div className="space-y-3">
          <ScenarioCard
            title="PLC loses power or network drops"
            desc="The PLC icon turns amber and shows 'Reconnecting'. The app retries every 5 seconds. When PLC comes back, testing resumes automatically. No admin action needed."
          />
          <ScenarioCard
            title="Cloud goes offline"
            desc="Your testing continues normally. Results save locally and queue up. When cloud returns, everything syncs automatically within 30 seconds."
          />
          <ScenarioCard
            title="Your tablet loses Wi-Fi"
            desc="If you're on the server's local network, the app still works. If you lose all connectivity, results are safe in the local database and sync when you reconnect."
          />
          <ScenarioCard
            title="Server laptop crashes"
            desc="Restart the laptop and double-click START.bat. All data is safe in the database. Reconnect PLC from the config dialog."
          />
        </div>
      </div>
    ),
  },
  {
    id: "user-management",
    title: "Managing Users",
    icon: <UserPlus className="w-5 h-5" />,
    adminOnly: true,
    content: (
      <div className="space-y-4">
        <p>Admins can create, edit, and deactivate user accounts. Each user logs in with a unique 6-digit PIN.</p>
        <StepList steps={[
          "Click \"Manage Users\" in the top-right toolbar",
          "You'll see a list of all users with their roles and status",
          "Click \"Add User\" to create a new account",
          "Enter the user's name, assign a 6-digit PIN, and choose their role (Admin or User)",
          "Click Save — the user can now log in immediately",
        ]} />
        <div className="grid gap-3 sm:grid-cols-2 mt-2">
          <InfoCard icon={<Shield />} title="Admin Role" desc="Full access — PLC config, cloud sync, user management, all settings" />
          <InfoCard icon={<Users />} title="User Role" desc="Testing only — can pass/fail IOs, add comments, view results" />
        </div>
        <h3 className="text-sm font-semibold mt-4">Resetting a PIN</h3>
        <StepList steps={[
          "Open Manage Users",
          "Click the edit button on the user's row",
          "Enter a new 6-digit PIN",
          "Click Save — the user logs in with the new PIN next time",
        ]} />
        <h3 className="text-sm font-semibold mt-4">Deactivating a User</h3>
        <p className="text-sm text-muted-foreground">
          Toggle the user's active status to prevent login. Their test history is preserved.
          Deactivated users cannot log in until reactivated.
        </p>
        <Tip>The default admin PIN is 111111. Change it after first login for security.</Tip>
      </div>
    ),
  },
  {
    id: "csv-export",
    title: "Exporting Results (CSV)",
    icon: <FileDown className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>Export your test results as a CSV file for reporting, archiving, or sharing with stakeholders.</p>
        <StepList steps={[
          "Open the I/O Testing page",
          "Click the download icon (↓) in the toolbar, near the column visibility controls",
          "A CSV file downloads with all IO data — description, IO point, state, result, tester, timestamp, and comments",
          "Open in Excel, Google Sheets, or any spreadsheet tool",
        ]} />
        <Tip>The CSV includes all IOs regardless of your current filter. If you have Pass/Fail/Untested filters active, the export still includes everything.</Tip>
        <Warning>Export regularly during commissioning as a backup. While data is safe in the local database and cloud, a CSV gives you an offline copy you can email or print.</Warning>
      </div>
    ),
  },
  {
    id: "change-requests",
    title: "Change Requests",
    icon: <ClipboardList className="w-5 h-5" />,
    adminOnly: true,
    content: (
      <div className="space-y-4">
        <p>If an IO definition is incorrect (wrong description, wrong tag name, etc.), technicians or admins can submit a change request instead of modifying the data directly.</p>
        <StepList steps={[
          "Find the IO that needs correction",
          "Click the change request icon on that row",
          "Select the request type (rename, reassign, remove, etc.)",
          "Add a description of what needs to change and why",
          "Submit — the request is saved and visible to all admins",
        ]} />
        <h3 className="text-sm font-semibold mt-4">Reviewing Change Requests (Admin)</h3>
        <StepList steps={[
          "Open the change requests panel from the toolbar",
          "Review each pending request — see who submitted it and why",
          "Approve or reject with an optional comment",
          "Approved changes should be made in the cloud system, then re-pulled",
        ]} />
        <Tip>Change requests create a paper trail. Even rejected requests are preserved so you can see what was considered and why.</Tip>
      </div>
    ),
  },
  {
    id: "backups",
    title: "Database Backups",
    icon: <Database className="w-5 h-5" />,
    adminOnly: true,
    content: (
      <div className="space-y-4">
        <p>The app stores all data in a local SQLite database. Backups let you save a snapshot you can restore from if needed.</p>
        <StepList steps={[
          "Open the backup panel from the admin toolbar",
          "Click \"Create Backup\" — a timestamped copy of the database is saved",
          "Click \"Download\" on any backup to save it to your computer",
          "To restore, upload a backup file — this replaces the current database",
        ]} />
        <Warning>Restoring a backup overwrites all current data. Make sure to create a fresh backup before restoring an older one.</Warning>
        <h3 className="text-sm font-semibold mt-4">When to Create Backups</h3>
        <div className="space-y-2">
          <TipCard title="Before Pull IOs" desc="Pulling new IO definitions replaces the current list. A backup preserves your existing results." />
          <TipCard title="End of Shift" desc="Create a backup at the end of each work day as insurance." />
          <TipCard title="Before Major Changes" desc="If you're about to re-configure PLC connections or sync settings, back up first." />
        </div>
        <Tip>Backups can also be synced to the cloud for off-site safekeeping.</Tip>
      </div>
    ),
  },
  {
    id: "diagnostics",
    title: "Diagnostic Help",
    icon: <HelpCircle className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>When an IO fails, the app can suggest troubleshooting steps based on the device type.</p>
        <StepList steps={[
          "When viewing a failed IO, look for the help (?) icon",
          "Click it to see diagnostic steps specific to that tag type (FIOM, VFD, PMM, etc.)",
          "Follow the suggested steps — check wiring, verify power, inspect connections",
          "Common failure modes and solutions are pre-loaded for each device type",
        ]} />
        <h3 className="text-sm font-semibold mt-4">Available Diagnostics by Device Type</h3>
        <div className="grid gap-2 sm:grid-cols-2 mt-2">
          <InfoCard icon={<Cpu />} title="FIOM" desc="Field IO modules — check terminal wiring, DIN rail power, module LEDs" />
          <InfoCard icon={<Zap />} title="VFD" desc="Motor drives — verify motor wiring, drive fault codes, parameter settings" />
          <InfoCard icon={<Network />} title="DPM" desc="Network switches — check Ethernet cables, port LEDs, ring status" />
          <InfoCard icon={<Settings />} title="PMM / SIO" desc="Power monitors, smart IO — verify CT connections, scaling, communication" />
        </div>
        <Tip>Diagnostics are pre-seeded by your admin. If steps are missing for a device type, ask your admin to add them via the diagnostics management page.</Tip>
      </div>
    ),
  },
  {
    id: "faq",
    title: "FAQ",
    icon: <HelpCircle className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>Common questions from technicians in the field.</p>
        <div className="space-y-3">
          <ScenarioCard
            title="What if I accidentally mark Pass instead of Fail?"
            desc="Reset the IO (circular arrow icon) and test again. The old result is kept in history."
          />
          <ScenarioCard
            title="Can two people test the same IO?"
            desc="Yes, but the first result to sync wins. Both attempts are recorded in audit history."
          />
          <ScenarioCard
            title="What happens if I close the browser during testing?"
            desc="All results are saved locally. Log back in and continue."
          />
          <ScenarioCard
            title="Do I need to click Save?"
            desc="No. Everything saves automatically — results, comments, sync."
          />
          <ScenarioCard
            title="Can I test without cloud connection?"
            desc="Yes. Results save locally and sync when cloud is available."
          />
        </div>
      </div>
    ),
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    icon: <Wrench className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>Common problems and how to fix them.</p>
        <div className="space-y-3">
          <ScenarioCard
            title="PLC won't connect"
            desc="Check IP address, verify PLC is powered on and on the same network, check communication path (usually 1,0)."
          />
          <ScenarioCard
            title="IOs not showing up"
            desc="Admin needs to pull IOs from cloud first. Ask your admin to open the PLC config dialog and pull."
          />
          <ScenarioCard
            title="State dots not updating"
            desc="Check PLC connection (green icon). If amber/reconnecting, wait — it recovers automatically."
          />
          <ScenarioCard
            title="Cloud icon is red"
            desc="Check Wi-Fi/network connection. Cloud syncs automatically when connectivity returns."
          />
          <ScenarioCard
            title="Tags show errors on connect"
            desc="Some tag names may not match the PLC program. Send the error report to your admin."
          />
        </div>
      </div>
    ),
  },
  {
    id: "glossary",
    title: "Glossary",
    icon: <BookOpen className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>Industrial terms used in this tool.</p>
        <div className="space-y-2">
          <GlossaryItem term="IO" definition="Input/Output — a single sensor, switch, motor, or valve connection" />
          <GlossaryItem term="PLC" definition="Programmable Logic Controller — the industrial computer controlling the equipment" />
          <GlossaryItem term="DPM" definition="Data Power Module — network switch connecting devices to the PLC" />
          <GlossaryItem term="FIOM" definition="Field IO Module — remote IO module with sensor/actuator connections" />
          <GlossaryItem term="VFD" definition="Variable Frequency Drive — motor speed controller" />
          <GlossaryItem term="PMM" definition="Power Monitor Module" />
          <GlossaryItem term="SIO" definition="Smart IO module" />
          <GlossaryItem term="DLR" definition="Device Level Ring — network topology for industrial Ethernet" />
          <GlossaryItem term="MCM" definition="Master Communication Module — ring supervisor/controller" />
          <GlossaryItem term="Tag" definition='A named data point in the PLC program (e.g., "FIOM1_X0.PIN4_DI")' />
          <GlossaryItem term="ConnectionFaulted" definition="PLC tag indicating a device has lost communication" />
        </div>
      </div>
    ),
  },
  {
    id: "shortcuts",
    title: "Tips & Shortcuts",
    icon: <HelpCircle className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>Helpful tips to work faster:</p>
        <div className="space-y-3">
          <TipCard title="Search" desc="Use the search bar to instantly find any IO by name. Works as you type." />
          <Video src="/guide/flow-tech-search.webm" caption="Search in action — type to filter IOs instantly" />
          <TipCard title="Filters" desc="Click Pass/Fail/Not Tested buttons to focus on specific results. Click Inputs/Outputs to filter by IO type." />
          <TipCard title="CSV Export" desc="Click the download button to export all results as a CSV file for your records." />
          <TipCard title="Multiple Users" desc="Multiple technicians can connect to the same PLC simultaneously. Each person's results sync independently." />
          <TipCard title="Dark/Light Mode" desc="Click the sun/moon icon in the top-right to switch between dark and light themes." />
          <TipCard title="Diagnostic Help" desc="When an IO fails, click the ? help button for troubleshooting steps specific to that IO type." />
        </div>
      </div>
    ),
  },
]

// ── Helper Components ───────────────────────────────────────────

function Screenshot({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="border rounded-lg overflow-hidden bg-muted/30">
      <img src={src} alt={alt} className="w-full h-auto" loading="lazy" />
      <p className="text-[10px] text-muted-foreground px-3 py-1.5 border-t">{alt}</p>
    </div>
  )
}

function Video({ src, caption }: { src: string; caption: string }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <div className="border rounded-lg overflow-hidden bg-muted/30 cursor-pointer" onClick={() => setExpanded(true)}>
        <video src={src} autoPlay loop muted playsInline className="w-full h-auto" />
        <p className="text-[10px] text-muted-foreground px-3 py-1.5 border-t flex items-center gap-1.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          {caption}
          <span className="ml-auto text-[10px] opacity-60">Click to expand</span>
        </p>
      </div>
      {expanded && (
        <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center" onClick={() => setExpanded(false)}>
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(false) }}
            className="absolute top-4 right-4 text-white hover:text-gray-300 text-3xl font-bold z-[101] w-10 h-10 flex items-center justify-center"
          >
            &times;
          </button>
          <div className="max-w-[90vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <video src={src} autoPlay loop muted playsInline className="max-w-full max-h-[90vh] rounded-lg" />
          </div>
        </div>
      )}
    </>
  )
}

function StepList({ steps }: { steps: string[] }) {
  return (
    <ol className="space-y-2">
      {steps.map((step, i) => (
        <li key={i} className="flex items-start gap-3">
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
            {i + 1}
          </span>
          <span className="text-sm">{step}</span>
        </li>
      ))}
    </ol>
  )
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
      <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
      <p className="text-sm text-emerald-400">{children}</p>
    </div>
  )
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
      <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
      <p className="text-sm text-amber-400">{children}</p>
    </div>
  )
}

function InfoCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 bg-card border rounded-lg p-3">
      <div className="text-primary mt-0.5">{icon}</div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
    </div>
  )
}

function IndicatorRow({ icon, label, desc }: { icon: React.ReactNode; label: string; desc: string }) {
  return (
    <div className="flex items-center gap-3 p-2 rounded bg-card border">
      {icon}
      <span className="text-sm font-medium w-16">{label}</span>
      <span className="text-sm text-muted-foreground">{desc}</span>
    </div>
  )
}


function ScenarioCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="bg-card border rounded-lg p-3">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground mt-1">{desc}</p>
    </div>
  )
}

function GlossaryItem({ term, definition }: { term: string; definition: string }) {
  return (
    <div className="flex items-start gap-3 p-2 rounded bg-card border">
      <span className="text-sm font-mono font-bold text-primary shrink-0 min-w-[140px]">{term}</span>
      <span className="text-sm text-muted-foreground">{definition}</span>
    </div>
  )
}

function TipCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 p-2">
      <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 shrink-0" />
      <div>
        <span className="text-sm font-medium">{title}</span>
        <span className="text-sm text-muted-foreground"> — {desc}</span>
      </div>
    </div>
  )
}

// ── Main Guide Page ─────────────────────────────────────────────

export default function GuidePage() {
  const [showAdmin, setShowAdmin] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)

  const filteredSteps = showAdmin ? steps : steps.filter(s => !s.adminOnly)
  const step = filteredSteps[currentStep]
  const isFirst = currentStep === 0
  const isLast = currentStep === filteredSteps.length - 1

  // Reset step index when toggling role
  const handleRoleToggle = () => {
    setShowAdmin(!showAdmin)
    setCurrentStep(0)
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="font-bold">IO Checkout Tool — Guide</h1>
              <p className="text-xs text-muted-foreground">Step {currentStep + 1} of {filteredSteps.length}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleRoleToggle}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                showAdmin
                  ? "bg-blue-500/10 border-blue-500/30 text-blue-500"
                  : "bg-muted border-border text-muted-foreground hover:text-foreground"
              )}
            >
              <Settings className="w-3 h-3" />
              {showAdmin ? "Admin + Technician" : "Technician"}
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto flex flex-col lg:flex-row gap-0 min-h-[calc(100vh-57px)]">
        {/* Sidebar — step navigation */}
        <nav className="lg:w-64 lg:border-r bg-card/50 p-3 lg:p-4 overflow-x-auto lg:overflow-y-auto">
          <div className="flex lg:flex-col gap-1">
            {filteredSteps.map((s, i) => (
              <button
                key={s.id}
                onClick={() => setCurrentStep(i)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm whitespace-nowrap lg:whitespace-normal transition-colors",
                  i === currentStep
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                {s.icon}
                <span className="hidden sm:inline">
                  {s.title}
                  {s.adminOnly && <span className="text-[10px] text-blue-500 ml-1">(Admin)</span>}
                </span>
              </button>
            ))}
          </div>
        </nav>

        {/* Content */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8">
          <div className="mb-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                {step.icon}
              </div>
              <h2 className="text-2xl font-bold">{step.title}</h2>
            </div>
            {/* Progress bar */}
            <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${((currentStep + 1) / filteredSteps.length) * 100}%` }} />
            </div>
          </div>

          <div className="prose prose-sm dark:prose-invert max-w-none">
            {step.content}
          </div>

          {/* Navigation */}
          <div className="flex items-center justify-between mt-8 pt-4 border-t">
            <button
              onClick={() => setCurrentStep(Math.max(0, currentStep - 1))}
              disabled={isFirst}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                isFirst ? "text-muted-foreground cursor-not-allowed" : "bg-muted hover:bg-accent"
              )}
            >
              <ArrowLeft className="w-4 h-4" />
              Previous
            </button>
            <span className="text-xs text-muted-foreground">
              {currentStep + 1} / {filteredSteps.length}
            </span>
            <button
              onClick={() => setCurrentStep(Math.min(filteredSteps.length - 1, currentStep + 1))}
              disabled={isLast}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                isLast ? "text-muted-foreground cursor-not-allowed" : "bg-primary text-primary-foreground hover:bg-primary/90"
              )}
            >
              Next
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </main>
      </div>
    </div>
  )
}
