"use client"

import { useState, useEffect } from "react"
import ReactMarkdown from "react-markdown"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { HelpCircle, ChevronDown, Minus, Plus } from "lucide-react"
import { API_ENDPOINTS, authFetch } from "@/lib/api-config"

interface DiagnosticStepsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tagType: string
  failureMode?: string
  tagName?: string
}

const FONT_SIZES = [
  { label: 'S', class: 'prose-sm', size: 14 },
  { label: 'M', class: 'prose-base', size: 16 },
  { label: 'L', class: 'prose-lg', size: 18 },
  { label: 'XL', class: 'prose-xl', size: 20 },
]

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
  const [fontSizeIndex, setFontSizeIndex] = useState(1) // Default to 'M'

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
      setSteps(getGeneralOverview(tagType))
      setLoading(false)
    }
  }, [open, tagType, selectedFailureMode])

  const loadFailureModes = async () => {
    try {
      const response = await authFetch(
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
      const response = await authFetch(
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
    return `# ${tagType}

Select a failure mode below to see specific troubleshooting steps.

## General Inspection Checklist

- Check for visible damage or loose connections
- Verify 24V DC power at device terminals (21.6V – 26.4V)
- Ensure proper wiring per electrical drawings
- Check PLC input/output card LED indicators
- Verify tag name mapping is correct

## Available Failure Modes

${availableFailureModes.length > 0
  ? availableFailureModes.map(mode => `- **${mode}**`).join('\n')
  : '- No specific failure modes documented yet'
}`
  }

  const getDefaultTroubleshootingSteps = (tagType: string, failureMode: string) => {
    return `# ${tagType} — ${failureMode}

## Step 1: Visual Inspection
- Check for any visible damage to the device
- Verify all connections are secure and properly seated
- Look for signs of overheating or burn marks

## Step 2: Check Power Supply
- Verify 24V DC power at device terminals
- Use multimeter to measure voltage (expected: 21.6V – 26.4V)
- Check for loose power connections
- Verify fuses are intact

## Step 3: Verify Wiring
- Trace wiring from device to PLC input/output card
- Check wire numbers match electrical drawings
- Look for damaged, cut, or pinched cables

## Step 4: Test Signal Path
- Use multimeter to test signal continuity
- Verify signal reaches PLC input card
- Check PLC card LED indicators

## Step 5: Check PLC Configuration
- Verify I/O address mapping is correct
- Check if input/output is enabled in PLC program
- Review any fault codes in PLC diagnostics

## Step 6: Document and Escalate
- Record all findings in test comments
- Take photos of any issues found
- If unresolved, contact maintenance supervisor

---
*These are general troubleshooting steps. Refer to device-specific documentation for detailed procedures.*`
  }

  const currentFontSize = FONT_SIZES[fontSizeIndex]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader className="pb-3 border-b">
          <DialogTitle className="flex items-center gap-2 text-xl">
            <HelpCircle className="w-6 h-6 text-primary" />
            Troubleshooting Guide
          </DialogTitle>

          {/* Tag info + failure mode selector — scales with font size */}
          <div className="flex flex-wrap items-center gap-3 pt-2" style={{ fontSize: `${currentFontSize.size}px` }}>
            {tagName && (
              <Badge variant="outline" className="font-mono px-3 py-1" style={{ fontSize: `${currentFontSize.size}px` }}>{tagName}</Badge>
            )}
            <Badge variant="secondary" className="px-3 py-1" style={{ fontSize: `${currentFontSize.size}px` }}>{tagType}</Badge>

            {/* Failure mode dropdown */}
            <div className="relative ml-auto">
              <button
                onClick={() => setShowModeSelector(!showModeSelector)}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md border font-medium hover:bg-muted transition-colors"
                style={{ fontSize: `${currentFontSize.size}px` }}
              >
                {selectedFailureMode ? (
                  <span className="text-red-600 dark:text-red-400 font-semibold">{selectedFailureMode}</span>
                ) : (
                  <span className="text-muted-foreground">Select failure mode...</span>
                )}
                <ChevronDown className="w-5 h-5" />
              </button>
              {showModeSelector && (
                <div className="absolute top-full right-0 mt-1 z-50 min-w-[260px] max-w-[400px] bg-popover border rounded-md shadow-lg py-1">
                  <button
                    className="w-full text-left px-4 py-3 hover:bg-muted transition-colors"
                    style={{ fontSize: `${currentFontSize.size}px` }}
                    onClick={() => {
                      setSelectedFailureMode(undefined)
                      setShowModeSelector(false)
                    }}
                  >
                    General Overview
                  </button>
                  <div className="h-px bg-border my-1" />
                  {availableFailureModes.map((mode) => (
                    <button
                      key={mode}
                      className={`w-full text-left px-4 py-3 hover:bg-muted transition-colors ${
                        mode === selectedFailureMode ? 'bg-muted font-semibold' : ''
                      }`}
                      style={{ fontSize: `${currentFontSize.size}px` }}
                      onClick={() => {
                        setSelectedFailureMode(mode)
                        setShowModeSelector(false)
                      }}
                    >
                      {mode}
                      {mode === failureMode && (
                        <span className="ml-2 text-muted-foreground" style={{ fontSize: `${currentFontSize.size - 2}px` }}>(current)</span>
                      )}
                    </button>
                  ))}
                  {availableFailureModes.length === 0 && (
                    <div className="px-4 py-3 text-muted-foreground italic" style={{ fontSize: `${currentFontSize.size}px` }}>
                      No failure modes documented
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* Content area with markdown */}
        <div className="flex-1 overflow-y-auto py-4 px-1">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-muted-foreground">Loading troubleshooting steps...</div>
            </div>
          ) : error ? (
            <div className="p-4 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-lg">
              <p className="text-yellow-800 dark:text-yellow-200">{error}</p>
            </div>
          ) : (
            <div
              className={`${currentFontSize.class} max-w-none dark:prose-invert prose-headings:font-bold prose-headings:mt-6 prose-headings:mb-3 prose-h1:text-2xl prose-h2:text-xl prose-h2:border-b prose-h2:pb-2 prose-li:my-1 prose-p:my-3 prose-ul:my-2 prose-hr:my-6 prose-strong:text-primary`}
              style={{ fontSize: `${currentFontSize.size}px`, lineHeight: '1.7' }}
            >
              <ReactMarkdown>{steps}</ReactMarkdown>
            </div>
          )}
        </div>

        {/* Footer with font size controls */}
        <DialogFooter className="border-t pt-3 flex items-center justify-between sm:justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground uppercase tracking-wider">Text Size</span>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={fontSizeIndex === 0}
              onClick={() => setFontSizeIndex(i => Math.max(0, i - 1))}
            >
              <Minus className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium w-6 text-center">{currentFontSize.label}</span>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={fontSizeIndex === FONT_SIZES.length - 1}
              onClick={() => setFontSizeIndex(i => Math.min(FONT_SIZES.length - 1, i + 1))}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
