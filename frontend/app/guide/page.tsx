"use client"

import { useState, useCallback } from "react"
import {
  ArrowLeft, ArrowRight, CheckCircle2, Cpu,
  Play, Cloud, Download, Search,
  Network, Settings, Users, HelpCircle, AlertTriangle,
  Zap, MessageSquare, RotateCcw, Home, BookOpen, Wrench
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
          This guide will walk you through everything you need to know to use the
          <strong> IO Checkout Tool</strong> for commissioning.
        </p>
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
          <p className="text-sm text-blue-400 font-medium">This guide is read-only</p>
          <p className="text-sm text-muted-foreground mt-1">
            Nothing in this guide affects your real data, PLC connection, or test results.
            You can read through it safely at any time.
          </p>
        </div>
        <Video src="/guide/flow-full-workflow.webm" caption="Full workflow overview — login, navigate, search, test" />
        <div className="grid gap-3 sm:grid-cols-2 mt-6">
          <InfoCard icon={<Cpu />} title="Connect to PLC" desc="Read live tag states from the controller" />
          <InfoCard icon={<CheckCircle2 />} title="Test I/Os" desc="Mark inputs/outputs as Pass or Fail" />
          <InfoCard icon={<Cloud />} title="Cloud Sync" desc="Results sync automatically to the cloud" />
          <InfoCard icon={<Network />} title="Network View" desc="See DPM topology and device status" />
        </div>
      </div>
    ),
  },
  {
    id: "login",
    title: "Logging In",
    icon: <Users className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>Open the app URL on your tablet or laptop browser. You'll see the login screen.</p>
        <Video src="/guide/flow-tech-login.webm" caption="Login flow — enter your 6-digit PIN" />
        <Screenshot src="/guide/login.png" alt="Login screen with PIN entry" />
        <StepList steps={[
          "Enter your 6-digit PIN (default admin PIN: 111111)",
          "Click Log In",
          "You'll see the main commissioning page",
        ]} />
        <Tip>Ask your admin to create your personal PIN if you don't have one yet.</Tip>
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
        <p>The toolbar at the top shows your connection status and testing controls.</p>
        <Screenshot src="/guide/toolbar.png" alt="Main toolbar with status indicators" />
        <div className="grid gap-2 mt-2">
          <IndicatorRow icon={<div className="w-3 h-3 rounded-full bg-green-500" />} label="Green" desc="Connected and working" />
          <IndicatorRow icon={<div className="w-3 h-3 rounded-full bg-red-500" />} label="Red" desc="Not connected — click to configure" />
          <IndicatorRow icon={<div className="w-3 h-3 rounded-full bg-amber-500 animate-pulse" />} label="Amber (pulsing)" desc="Reconnecting — wait, it will recover automatically" />
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
        <p className="text-lg font-medium">This is your main workflow.</p>
        <StepList steps={[
          "Press START in the toolbar to enter testing mode",
          "Go to the panel and physically trigger an input (press button, block photoeye, flip switch, etc.)",
          "The IO's state dot turns green in the table",
          "This dialog appears automatically:",
        ]} />
        <Screenshot src="/guide/pass-fail-dialog.png" alt="Pass/Fail dialog — appears when an IO state changes" />
        <StepList steps={[
          "Click Pass if the correct IO responded",
          "Click Fail if the wrong IO responded or nothing happened",
          "Click Cancel to skip this IO for now",
          "The row turns green (Pass) or red (Fail) in the table",
        ]} />
        <Screenshot src="/guide/io-grid-results.png" alt="IO testing grid — green rows passed, red rows failed, gray not tested" />
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
        <p>For output IOs, you need to manually activate them to test.</p>
        <Screenshot src="/guide/fire-output.png" alt="Fire button — hold to activate output on PLC" />
        <StepList steps={[
          "Find the output IO in the table",
          "Click and HOLD the FIRE button (lightning bolt icon)",
          "The output activates on the PLC — verify the physical device (motor spins, light turns on, valve opens)",
          "Release the button — output turns OFF",
          "The Pass/Fail dialog appears — mark the result",
        ]} />
        <Warning>Outputs activate real equipment. Make sure it's safe before firing — check that personnel are clear of moving parts.</Warning>
      </div>
    ),
  },
  {
    id: "comments",
    title: "Adding Comments",
    icon: <MessageSquare className="w-5 h-5" />,
    content: (
      <div className="space-y-4">
        <p>You can add notes to any IO — useful for documenting issues or observations.</p>
        <Screenshot src="/guide/comment-section.png" alt="Comment field on an IO — saves automatically" />
        <StepList steps={[
          "Click on any IO row to expand it",
          "Type your comment in the comment field",
          "Comments save automatically and sync to the cloud within 1-2 seconds",
          "When marking an IO as Failed, you can add a comment in the failure dialog",
        ]} />
        <Tip>Comments are visible to all technicians and appear in the cloud dashboard. Use them to communicate issues to off-site engineers helping with troubleshooting.</Tip>
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
        <p>Your test results sync to the cloud automatically. You don't need to do anything.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <InfoCard icon={<Zap />} title="Instant Push" desc="Every Pass/Fail syncs within 1-2 seconds" />
          <InfoCard icon={<RotateCcw />} title="Auto Retry" desc="If cloud is offline, retries every 30 seconds" />
          <InfoCard icon={<Download />} title="Auto Pull" desc="Other users' results appear within 60 seconds" />
          <InfoCard icon={<CheckCircle2 />} title="Crash Safe" desc="Results are saved locally first, never lost" />
        </div>
        <Tip>If you lose Wi-Fi or the cloud goes down, keep testing. Everything syncs automatically when connectivity returns.</Tip>
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
