// Small, self-contained presentational cells for the IO grid. Extracted
// verbatim from enhanced-io-data-grid.tsx. Neither reads the grid's state,
// handlers, or refs — CopyButton owns only its own local "copied" flag, and
// getStateDisplay is a pure state→indicator mapper.

import { useState } from "react"
import { Copy, Check } from "lucide-react"
import { cn } from "@/lib/utils"

// Small copy button with check feedback
export function CopyButton({ text, title }: { text: string; title: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button
      className={cn(
        "ml-1 shrink-0 transition-opacity",
        copied ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        copied ? "text-green-400" : "text-muted-foreground hover:text-foreground"
      )}
      onClick={handleCopy}
      title={copied ? "Copied!" : title}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

// Live PLC state → colored status dot. Pure: depends only on its argument.
export function getStateDisplay(state: string | null) {
  if (!state || state === 'UNKNOWN') {
    return <div className="w-6 h-6 min-w-[24px] rounded-full bg-gray-300 dark:bg-gray-600" />
  }

  if (state === 'TRUE' || state === 'ON' || state === 'HIGH' || state === 'ACTIVE' || state === '1') {
    return <div className="w-6 h-6 min-w-[24px] rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
  }
  if (state === 'FALSE' || state === 'OFF' || state === 'LOW' || state === 'INACTIVE' || state === '0') {
    return <div className="w-6 h-6 min-w-[24px] rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]" />
  }

  return <div className="w-6 h-6 min-w-[24px] rounded-full bg-gray-300 dark:bg-gray-600" />
}
