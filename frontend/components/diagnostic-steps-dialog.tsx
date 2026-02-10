"use client"

import { useState, useEffect } from "react"
import ReactMarkdown from "react-markdown"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { HelpCircle, ChevronDown } from "lucide-react"
import { NetworkStatusBreadcrumbs } from "./network-status-breadcrumbs"
import { API_ENDPOINTS } from "@/lib/api-config"

interface DiagnosticStepsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tagType: string
  failureMode?: string
  tagName?: string
}

export function DiagnosticStepsDialog({
  open,
  onOpenChange,
  tagType,
  failureMode,
  tagName
}: DiagnosticStepsDialogProps) {
  const [steps, setSteps] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [availableFailureModes, setAvailableFailureModes] = useState<string[]>([])
  const [selectedFailureMode, setSelectedFailureMode] = useState<string | undefined>(failureMode)
  const [showModeSelector, setShowModeSelector] = useState(false)

  // Reset selected mode when dialog opens with new props
  useEffect(() => {
    if (open) {
      setSelectedFailureMode(failureMode)
      setShowModeSelector(false)
    }
  }, [open, failureMode])

  // Load available failure modes for this tag type
  useEffect(() => {
    if (open && tagType) {
      loadFailureModes()
    }
  }, [open, tagType])

  // Load diagnostic steps when a failure mode is selected
  useEffect(() => {
    if (open && tagType && selectedFailureMode) {
      loadDiagnosticSteps(selectedFailureMode)
    } else if (open && tagType && !selectedFailureMode) {
      // No failure mode - show general overview
      setSteps(getGeneralOverview(tagType))
      setLoading(false)
    }
  }, [open, tagType, selectedFailureMode])

  const loadFailureModes = async () => {
    try {
      const response = await fetch(
        `${API_ENDPOINTS.diagnosticFailureModes}?tagType=${encodeURIComponent(tagType)}`
      )
      if (response.ok) {
        const data = await response.json()
        setAvailableFailureModes(data)
      }
    } catch (err) {
      console.error('Error loading failure modes:', err)
    }
  }

  const loadDiagnosticSteps = async (mode: string) => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(
        `${API_ENDPOINTS.diagnosticSteps}?tagType=${encodeURIComponent(tagType)}&failureMode=${encodeURIComponent(mode)}`
      )

      if (response.ok) {
        const data = await response.json()
        setSteps(data.steps)
      } else if (response.status === 404) {
        setSteps(getDefaultTroubleshootingSteps(tagType, mode))
      } else {
        setError('Failed to load diagnostic steps.')
      }
    } catch (err) {
      console.error('Error loading diagnostic steps:', err)
      setSteps(getDefaultTroubleshootingSteps(tagType, mode))
    } finally {
      setLoading(false)
    }
  }

  const getGeneralOverview = (tagType: string) => {
    return `# Device Overview: ${tagType}

## About This Device Type

This is a **${tagType}** device. Select a failure mode below to see specific troubleshooting steps.

### General Inspection Checklist

- Check for visible damage or loose connections
- Verify 24V DC power at device terminals (21.6V - 26.4V)
- Ensure proper wiring per electrical drawings
- Check PLC input/output card LED indicators
- Verify tag name mapping is correct

### Available Failure Modes

${availableFailureModes.length > 0
  ? availableFailureModes.map(mode => `- **${mode}** - Click to view troubleshooting steps`).join('\n')
  : '- No specific failure modes documented yet\n- Use the general steps above for troubleshooting'
}

---
**Tip:** Select a specific failure mode from the dropdown above to see detailed step-by-step troubleshooting instructions.`
  }

  const getDefaultTroubleshootingSteps = (tagType: string, failureMode: string) => {
    return `# Troubleshooting Guide: ${tagType}

## Failure Mode: ${failureMode}

### Step 1: Visual Inspection
- Check for any visible damage to the device
- Verify all connections are secure and properly seated
- Look for signs of overheating or burn marks
- Ensure the device is properly mounted

### Step 2: Check Power Supply
- Verify 24V DC power at device terminals
- Use multimeter to measure voltage (expected: 21.6V - 26.4V)
- Check for loose power connections
- Verify fuses are intact

### Step 3: Verify Wiring
- Trace wiring from device to PLC input/output card
- Check wire numbers match electrical drawings
- Look for damaged, cut, or pinched cables
- Verify proper shielding on signal cables

### Step 4: Test Signal Path
- Use multimeter to test signal continuity
- Verify signal reaches PLC input card
- Check PLC card LED indicators
- Test with known good device if available

### Step 5: Check PLC Configuration
- Verify I/O address mapping is correct
- Check if input/output is enabled in PLC program
- Review any fault codes in PLC diagnostics
- Ensure proper scaling and signal type settings

### Step 6: Document and Escalate
- Record all findings in test comments
- Take photos of any issues found
- If unresolved, contact maintenance supervisor
- Reference device part number for replacement

---
**Note:** These are general troubleshooting steps. Refer to device-specific documentation for detailed procedures.`
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HelpCircle className="w-5 h-5 text-primary" />
            Troubleshooting Guide
          </DialogTitle>
          <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            {tagName && (
              <div>Tag: <Badge variant="outline" className="font-mono">{tagName}</Badge></div>
            )}
            <div>Device Type: <Badge variant="secondary">{tagType}</Badge></div>
            <div className="flex items-center gap-2">
              <span>Failure Mode:</span>
              {/* Failure mode selector dropdown */}
              <div className="relative">
                <button
                  onClick={() => setShowModeSelector(!showModeSelector)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-medium hover:bg-muted transition-colors"
                >
                  {selectedFailureMode ? (
                    <Badge variant="destructive" className="text-xs">{selectedFailureMode}</Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs">General Overview</Badge>
                  )}
                  <ChevronDown className="w-3 h-3" />
                </button>
                {showModeSelector && (
                  <div className="absolute top-full left-0 mt-1 z-50 min-w-[200px] max-w-[300px] bg-popover border rounded-md shadow-md py-1">
                    <button
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                      onClick={() => {
                        setSelectedFailureMode(undefined)
                        setShowModeSelector(false)
                      }}
                    >
                      General Overview
                    </button>
                    {availableFailureModes.map((mode) => (
                      <button
                        key={mode}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                        onClick={() => {
                          setSelectedFailureMode(mode)
                          setShowModeSelector(false)
                        }}
                      >
                        {mode}
                        {mode === failureMode && " (current)"}
                      </button>
                    ))}
                    {availableFailureModes.length === 0 && (
                      <div className="px-3 py-1.5 text-xs text-muted-foreground italic">
                        No failure modes documented
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Live Network Status Breadcrumbs */}
        <NetworkStatusBreadcrumbs tagName={tagName} className="mt-2" />

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-sm text-muted-foreground">Loading troubleshooting steps...</div>
            </div>
          ) : error ? (
            <div className="p-4 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-lg">
              <p className="text-sm text-yellow-800 dark:text-yellow-200">{error}</p>
            </div>
          ) : (
            <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:mt-4 prose-headings:mb-2 prose-li:my-0.5 prose-p:my-2 prose-hr:my-4">
              <ReactMarkdown>{steps}</ReactMarkdown>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
