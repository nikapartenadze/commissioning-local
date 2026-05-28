"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { toast } from "@/hooks/use-toast"

// Minimal shape the dialog needs. Callers may pass any object extending it —
// the IO grid passes IoItem; the EPC view passes an EPC-shaped object.
export interface FailCommentDialogIo {
  name: string
  description: string | null
  tagType?: string | null
}

interface FailCommentDialogProps<T extends FailCommentDialogIo> {
  open: boolean
  onOpenChange: (open: boolean) => void
  io: T | null
  /**
   * Submit handler. `failureMode` carries the BLOCKER (responsible party)
   * — Electrical | Controls | 3rd Party. `blockerDescription` carries the
   * specific reason picked from that party's options. Kept as separate args
   * so the existing test-endpoint contract didn't have to change.
   */
  onSubmit: (io: T, comment: string, failureMode?: string, blockerDescription?: string) => void
  onCancel: () => void
  /**
   * When true, the dialog presents as an "Unpass" action (a Pass → Fail
   * correction for an item marked passed on a temp install). Only the
   * heading and button label change — the data shape is identical.
   */
  unpassMode?: boolean
}

// ── Blocker / Blocker Description taxonomy ────────────────────────────────
//
// Controlled vocabulary the tester picks from. The local commissioning
// tool ONLY exposes Electrical, Controls, and 3rd Party — never Mechanical
// (that's the installation-tracker's responsibility, an electrical
// installer with mechanical context reassigns there).
//
// Keep these lists in sync with the cloud's display logic. Adding a new
// description to one of the existing parties is safe; adding a new party
// requires touching the failure-modes API + the cloud's party-responsible
// derivation.

type Blocker = 'Electrical' | 'Controls' | '3rd Party'

const BLOCKERS: Blocker[] = ['Electrical', 'Controls', '3rd Party']

const BLOCKER_DESCRIPTIONS: Record<Blocker, string[]> = {
  // The IO-check / "immediate upstream phase" lane. 'Temp install' is the
  // explicit unpass reason — an item that was marked installed but isn't.
  Electrical: [
    'Not installed',
    'Not powered',
    'Not aligned',
    'Wrong wiring',
    'Damaged',
    'Temp install',
    'Other',
  ],
  // Anything programming / drawing / tag-mapping related — where the
  // tester has context but it's not an installer issue.
  Controls: [
    'Not programmed',
    'Missing drawings',
    'Config error',
    'Wrong tag',
    'Other',
  ],
  // External vendor — VFD/PLC/etc. needing vendor action.
  '3rd Party': [
    'Vendor blocked',
    'Awaiting vendor',
    'Other',
  ],
}

export function FailCommentDialog<T extends FailCommentDialogIo>({
  open,
  onOpenChange,
  io,
  onSubmit,
  onCancel,
  unpassMode = false,
}: FailCommentDialogProps<T>) {
  const [comment, setComment] = useState("")
  const [blocker, setBlocker] = useState<Blocker | "">("")
  const [blockerDescription, setBlockerDescription] = useState<string>("")

  // Reset every time the dialog reopens for a new IO.
  useEffect(() => {
    if (open && io) {
      setComment("")
      setBlocker("")
      setBlockerDescription("")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, io])

  if (!io) return null

  // When Blocker changes, drop any stale Blocker Description that no longer
  // belongs to the new party. Keeps the cascade honest.
  const handleBlockerChange = (next: string) => {
    const b = next as Blocker | ""
    setBlocker(b)
    if (b === "" || !BLOCKER_DESCRIPTIONS[b].includes(blockerDescription)) {
      setBlockerDescription("")
    }
  }

  const descriptionOptions = blocker ? BLOCKER_DESCRIPTIONS[blocker] : []
  const otherRequiresComment = blockerDescription === 'Other'
  const otherMissingComment = otherRequiresComment && !comment.trim()

  const handleSubmit = () => {
    if (!blocker) {
      toast({ title: "Please select a blocker (responsible party)", variant: "destructive" })
      return
    }
    if (!blockerDescription) {
      toast({ title: "Please select a blocker description", variant: "destructive" })
      return
    }
    if (otherMissingComment) {
      toast({ title: "Comment is required when the reason is 'Other'", variant: "destructive" })
      return
    }

    onSubmit(io, comment, blocker, blockerDescription)
    setComment("")
    setBlocker("")
    setBlockerDescription("")
    onOpenChange(false)
  }

  const handleCancel = () => {
    setComment("")
    setBlocker("")
    setBlockerDescription("")
    onCancel()
    onOpenChange(false)
  }

  const title = unpassMode ? 'Unpass — record blocker' : 'Mark as Failed'
  const submitLabel = unpassMode ? 'Unpass' : 'Mark as Failed'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Tag:</span>
              <Badge variant="outline" className="font-mono">
                {io.name}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Description:</span>
              <span className="text-sm text-muted-foreground">
                {io.description || 'No description'}
              </span>
            </div>
            {io.tagType && (
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Device Type:</span>
                <Badge variant="secondary">{io.tagType}</Badge>
              </div>
            )}
            {unpassMode && (
              <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1 mt-1">
                <AlertCircle className="w-3 h-3" />
                This will reverse the Pass and record a blocker. The full history is preserved.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="blocker">
              Blocker (responsible party) <span className="text-destructive">*</span>
            </Label>
            <Select value={blocker} onValueChange={handleBlockerChange}>
              <SelectTrigger id="blocker">
                <SelectValue placeholder="Select responsible party..." />
              </SelectTrigger>
              <SelectContent>
                {BLOCKERS.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Mechanical isn&apos;t listed here — those are reassigned in the installation tracker.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="blockerDescription">
              Blocker description <span className="text-destructive">*</span>
            </Label>
            <Select
              value={blockerDescription}
              onValueChange={setBlockerDescription}
              disabled={!blocker}
            >
              <SelectTrigger id="blockerDescription">
                <SelectValue placeholder={blocker ? "Select a reason..." : "Pick a Blocker first"} />
              </SelectTrigger>
              <SelectContent>
                {descriptionOptions.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!blockerDescription && blocker && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                Required — pick the specific reason for the blocker
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="comment">
              {otherRequiresComment ? (
                <span className="text-destructive font-semibold">Comment required</span>
              ) : (
                <>Additional Comments {blockerDescription && <span className="text-muted-foreground text-xs">(optional)</span>}</>
              )}
            </Label>
            <Textarea
              id="comment"
              placeholder={
                otherRequiresComment
                  ? "Explain the specific issue..."
                  : "Optional — add any additional notes..."
              }
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={500}
              rows={4}
              className={cn(
                "resize-none",
                otherMissingComment && "border-destructive ring-1 ring-destructive",
              )}
            />
            <p className="text-xs text-muted-foreground text-right">{comment.length}/500</p>
          </div>
        </div>

        <DialogFooter className="flex gap-2">
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={!blocker || !blockerDescription || otherMissingComment}
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
