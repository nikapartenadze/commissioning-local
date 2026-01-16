"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { HelpCircle } from "lucide-react"
import { NetworkStatusBreadcrumbs } from "./network-status-breadcrumbs"
import { API_ENDPOINTS } from "@/lib/api-config"

interface DiagnosticStepsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tagType: string
  failureMode: string
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

  useEffect(() => {
    if (open && tagType && failureMode) {
      loadDiagnosticSteps()
    }
  }, [open, tagType, failureMode])

  const loadDiagnosticSteps = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(
        `${API_ENDPOINTS.diagnosticSteps}?tagType=${encodeURIComponent(tagType)}&failureMode=${encodeURIComponent(failureMode)}`
      )

      if (response.ok) {
        const data = await response.json()
        setSteps(data.steps)
      } else if (response.status === 404) {
        // Show placeholder/default troubleshooting steps
        setSteps(getDefaultTroubleshootingSteps(tagType, failureMode))
      } else {
        setError('Failed to load diagnostic steps.')
      }
    } catch (err) {
      console.error('Error loading diagnostic steps:', err)
      // Show placeholder on error too
      setSteps(getDefaultTroubleshootingSteps(tagType, failureMode))
    } finally {
      setLoading(false)
    }
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
            <HelpCircle className="w-5 h-5 text-blue-600" />
            Troubleshooting Guide
          </DialogTitle>
          <div className="flex flex-col gap-1 text-sm text-muted-foreground">
            {tagName && (
              <div>Tag: <Badge variant="outline" className="font-mono">{tagName}</Badge></div>
            )}
            <div>Device Type: <Badge variant="secondary">{tagType}</Badge></div>
            <div>Failure Mode: <Badge variant="destructive">{failureMode}</Badge></div>
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
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <div
                className="whitespace-pre-wrap"
                dangerouslySetInnerHTML={{ __html: formatMarkdown(steps) }}
              />
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

// Simple markdown formatter (basic support)
function formatMarkdown(text: string): string {
  return text
    // Headers
    .replace(/^### (.+)$/gm, '<h3 class="text-lg font-semibold mt-4 mb-2">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-xl font-bold mt-6 mb-3">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-2xl font-bold mt-8 mb-4">$1</h1>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Lists
    .replace(/^- (.+)$/gm, '<li class="ml-4">$1</li>')
    // Line breaks
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
}
