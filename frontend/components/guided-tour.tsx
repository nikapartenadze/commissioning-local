"use client"

import React, { useState, useEffect } from 'react'
import Joyride, { CallBackProps, STATUS, Step } from 'react-joyride'
import { useTheme } from 'next-themes'

interface GuidedTourProps {
  run: boolean
  onFinish: () => void
}

function TourImage({ src, alt }: { src: string; alt: string }) {
  return (
    <div style={{ marginTop: 10, borderRadius: 8, overflow: 'hidden', border: '1px solid #333' }}>
      <img src={src} alt={alt} style={{ width: '100%', height: 'auto', display: 'block' }} />
    </div>
  )
}

const steps: Step[] = [
  {
    target: 'body',
    placement: 'center',
    title: 'Welcome to Commissioning Tool',
    content: (
      <div>
        <p>This tour will walk you through the testing workflow step by step.</p>
        <p style={{ marginTop: 8, fontSize: 12, color: '#22c55e' }}>
          This tour is read-only — it won't change any data or PLC settings.
        </p>
      </div>
    ),
    disableBeacon: true,
  },
  {
    target: '[data-tour="start-button"]',
    title: '1. Start Testing Mode',
    content: (
      <div>
        <p>Click <b>START</b> to enter testing mode. The button turns red and shows <b>STOP</b>.</p>
        <p style={{ marginTop: 6 }}>While testing is active, any IO that changes state will prompt you with a Pass/Fail dialog.</p>
      </div>
    ),
    disableBeacon: true,
  },
  {
    target: '[data-tour="io-grid"]',
    title: '2. The IO Grid',
    content: (
      <div>
        <p>Each row is one IO point. Green dot = input is ON. The result column shows Pass, Fail, or untested.</p>
      </div>
    ),
    disableBeacon: true,
  },
  {
    target: '[data-tour="io-grid"]',
    title: '3. When an Input Changes — Pass/Fail Dialog',
    content: (
      <div>
        <p>When you trigger an input on the panel, a dialog appears automatically.</p>
        <p style={{ marginTop: 8, fontSize: 13 }}>
          Click <b style={{ color: '#22c55e' }}>Pass</b> if it worked correctly, or <b style={{ color: '#ef4444' }}>Fail</b> if something is wrong.
        </p>
      </div>
    ),
    disableBeacon: true,
  },
  {
    target: '[data-tour="io-grid"]',
    title: '4. When an IO Fails — Document the Issue',
    content: (
      <div>
        <p>After clicking Fail, this form lets you document what went wrong:</p>
        <TourImage src="/guide/fail-dialog.png" alt="Failure details form" />
        <p style={{ marginTop: 8, fontSize: 12, color: '#999' }}>Select a failure reason and optionally add a comment. Off-site engineers see this on the cloud dashboard.</p>
      </div>
    ),
    disableBeacon: true,
  },
  {
    target: '[data-tour="io-grid"]',
    title: '5. Testing Outputs — Fire Button',
    content: (
      <div>
        <p>For output IOs, use the FIRE button to activate the output on the PLC:</p>
        <TourImage src="/guide/fire-output.png" alt="Fire output button" />
        <p style={{ marginTop: 8, fontSize: 13 }}>
          <b>Hold</b> the button to keep the output ON. <b>Release</b> to turn OFF. Verify the physical device activated, then mark Pass or Fail.
        </p>
      </div>
    ),
    disableBeacon: true,
  },
  {
    target: '[data-tour="search-area"]',
    title: '6. Search & Filter',
    content: (
      <div>
        <p>Use the search bar to find IOs by name. Filter buttons help focus on what's remaining:</p>
        <ul style={{ marginTop: 6, paddingLeft: 16, fontSize: 13, lineHeight: 1.8 }}>
          <li><b>Pass</b> — show only passed IOs</li>
          <li><b>Fail</b> — show only failed IOs</li>
          <li><b>Not Tested</b> — show remaining work</li>
          <li><b>Inputs / Outputs</b> — filter by IO type</li>
        </ul>
      </div>
    ),
    disableBeacon: true,
  },
  {
    target: '[data-tour="plc-status"]',
    title: '7. PLC Connection Status',
    content: (
      <div>
        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', display: 'inline-block', flexShrink: 0 }} />
            <span><b>Green</b> — Connected, reading tags</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#f59e0b', display: 'inline-block', flexShrink: 0 }} />
            <span><b>Amber</b> — Reconnecting (auto-recovers)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', display: 'inline-block', flexShrink: 0 }} />
            <span><b>Red</b> — Not connected</span>
          </div>
        </div>
      </div>
    ),
    disableBeacon: true,
  },
  {
    target: '[data-tour="cloud-status"]',
    title: '8. Cloud Sync',
    content: (
      <div>
        <p>Results sync to cloud <b>instantly</b> — within 1-2 seconds of every Pass/Fail.</p>
        <p style={{ marginTop: 6 }}>If cloud is offline, results save locally and sync when connection returns. You never lose data.</p>
      </div>
    ),
    disableBeacon: true,
  },
  {
    target: '[data-tour="csv-export"]',
    title: '9. Export Results',
    content: 'Download all test results as a CSV file for reporting.',
    disableBeacon: true,
  },
  {
    target: 'body',
    placement: 'center',
    title: 'You\'re Ready!',
    content: (
      <div>
        <p>The workflow is simple:</p>
        <ol style={{ marginTop: 8, paddingLeft: 16, fontSize: 14, lineHeight: 2 }}>
          <li>Click <b>START</b></li>
          <li>Trigger an input on the panel</li>
          <li>Click <b style={{ color: '#22c55e' }}>Pass</b> or <b style={{ color: '#ef4444' }}>Fail</b></li>
          <li>For outputs — click <b style={{ color: '#f59e0b' }}>FIRE</b>, verify, then mark result</li>
          <li>Repeat until done</li>
        </ol>
        <p style={{ marginTop: 10, fontSize: 13, color: '#22c55e' }}>Results sync to cloud automatically. Happy commissioning!</p>
      </div>
    ),
    disableBeacon: true,
  },
]

export function GuidedTour({ run, onFinish }: GuidedTourProps) {
  const { resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const handleCallback = (data: CallBackProps) => {
    const { status } = data
    if (status === STATUS.FINISHED || status === STATUS.SKIPPED) {
      onFinish()
    }
  }

  const isDark = !mounted || resolvedTheme === 'dark'

  const bg = isDark ? '#1e1e2e' : '#ffffff'
  const textColor = isDark ? '#e0e0e0' : '#333333'
  const titleColor = isDark ? '#ffffff' : '#111111'
  const contentColor = isDark ? '#d0d0d0' : '#444444'
  const backColor = isDark ? '#a0a0a0' : '#666666'
  const skipColor = isDark ? '#666' : '#999'

  if (!mounted) return null

  return (
    <Joyride
      steps={steps}
      run={run}
      continuous
      showSkipButton
      showProgress
      disableOverlayClose
      callback={handleCallback}
      styles={{
        options: {
          backgroundColor: bg,
          textColor: textColor,
          primaryColor: '#22c55e',
          arrowColor: bg,
          overlayColor: 'rgba(0, 0, 0, 0.7)',
          zIndex: 10000,
          width: 440,
        },
        tooltip: {
          borderRadius: 12,
          fontSize: 14,
          padding: 20,
        },
        tooltipTitle: {
          fontSize: 17,
          fontWeight: 700,
          color: titleColor,
        },
        tooltipContent: {
          color: contentColor,
          lineHeight: 1.6,
          padding: '8px 0',
        },
        buttonNext: {
          backgroundColor: '#22c55e',
          borderRadius: 6,
          fontSize: 14,
          fontWeight: 600,
          padding: '8px 20px',
        },
        buttonBack: {
          color: backColor,
          fontSize: 14,
        },
        buttonSkip: {
          color: skipColor,
          fontSize: 13,
        },
        spotlight: {
          borderRadius: 8,
        },
      }}
      locale={{
        back: 'Back',
        close: 'Close',
        last: 'Finish',
        next: 'Next',
        skip: 'Skip Tour',
      }}
    />
  )
}
