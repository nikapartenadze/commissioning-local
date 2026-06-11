"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { toast } from "@/hooks/use-toast"
import { BLOCKER_PARTIES, BLOCKER_VOCAB, type BlockerParty } from "@/lib/blockers"
import { FAILURE_REASON_GROUPS } from "@/lib/failure-reasons"

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
   * Submit handler.
   *   - `failureMode` is the chosen Failure Reason and is set on every Fail.
   *     Stored on the IO row (Io.failure_mode) and synced to cloud.
   *   - `blockerResponsibleParty` + `blockerDescription` are sent ONLY in
   *     unpass mode. They are the install-tracker's two columns on the
   *     shared `Devices` row (Devices.BlockerResponsibleParty /
   *     BlockerDescription) — a regular Fail does NOT touch them.
   */
  onSubmit: (
    io: T,
    comment: string,
    failureMode?: string,
    blockerResponsibleParty?: string,
    blockerDescription?: string,
  ) => void
  onCancel: () => void
  /**
   * When true, this is a Pass → Fail correction (Raul's "Unpass a temp
   * install" case). The dialog additionally asks for the two Blocker
   * fields, which propagate to the shared Devices row. When false, only
   * the Failure Reason is collected.
   */
  unpassMode?: boolean
}

// ── Vocabularies ──────────────────────────────────────────────────────────

// Failure-reason list shown on every Fail. The local commissioning tool's
// scope is the IO-check phase, so the reasons are Electrical- and
// Controls-flavored — Mechanical reasons are intentionally absent (those
// belong in the installation-tracker, where the electrical installer with
// the mechanical context reassigns to Mechanical). Picking one of these
// writes ONLY to Io.failure_mode; it does NOT auto-populate the Blocker
// (responsible-party) columns on Devices.
// Failure reasons live in lib/failure-reasons.ts, grouped by responsible party
// (Electrical / Mechanical / Controls / 3rd Party / Other) and rendered with
// headers below. Each reason derives Party Responsible via getPartyResponsible.

// Blocker assignment vocabulary — only shown in unpass mode. These map directly
// to the two install-tracker columns on Devices. The list now INCLUDES Mechanical
// (re-added per Kevin 2026-06-03) and is the shared cascade vocabulary, hand-synced
// with commissioning-cloud/lib/blockers.ts and installation-tracker.
const BLOCKER_DESCRIPTIONS = BLOCKER_VOCAB

export function FailCommentDialog<T extends FailCommentDialogIo>({
  open,
  onOpenChange,
  io,
  onSubmit,
  onCancel,
  unpassMode = false,
}: FailCommentDialogProps<T>) {
  const [comment, setComment] = useState("")
  const [failureMode, setFailureMode] = useState<string>("")
  const [blockerParty, setBlockerParty] = useState<BlockerParty | "">("")
  const [blockerDescription, setBlockerDescription] = useState<string>("")

  // Reset every time the dialog reopens for a new IO.
  useEffect(() => {
    if (open && io) {
      setComment("")
      setFailureMode("")
      setBlockerParty("")
      setBlockerDescription("")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, io])

  if (!io) return null

  // When Blocker Party changes, drop any stale Blocker Description that no
  // longer belongs to the new party.
  const handleBlockerPartyChange = (next: string) => {
    const p = next as BlockerParty | ""
    setBlockerParty(p)
    if (p === "" || !BLOCKER_DESCRIPTIONS[p].includes(blockerDescription)) {
      setBlockerDescription("")
    }
  }

  const descriptionOptions = blockerParty ? BLOCKER_DESCRIPTIONS[blockerParty] : []
  const isOther = failureMode === 'Other'
  const otherMissingComment = isOther && !comment.trim()

  const handleSubmit = () => {
    if (!failureMode) {
      toast({ title: "Please select a failure reason", variant: "destructive" })
      return
    }
    if (otherMissingComment) {
      toast({ title: "Comment is required when the reason is 'Other'", variant: "destructive" })
      return
    }
    if (unpassMode) {
      if (!blockerParty) {
        toast({ title: "Pick a Blocker (responsible party) for the unpass", variant: "destructive" })
        return
      }
      if (!blockerDescription) {
        toast({ title: "Pick a Blocker Description for the unpass", variant: "destructive" })
        return
      }
    }

    // Regular Fail: only failureMode goes through. Unpass: also pass the
    // Blocker fields — the page/sync route forwards them to the shared
    // Devices row.
    if (unpassMode) {
      onSubmit(io, comment, failureMode, blockerParty || undefined, blockerDescription || undefined)
    } else {
      onSubmit(io, comment, failureMode)
    }
    setComment("")
    setFailureMode("")
    setBlockerParty("")
    setBlockerDescription("")
    onOpenChange(false)
  }

  const handleCancel = () => {
    setComment("")
    setFailureMode("")
    setBlockerParty("")
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
              <Badge variant="outline" className="font-mono">{io.name}</Badge>
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
                You&apos;re reversing a Pass and assigning a Blocker. The Blocker fields write to the shared device row that the installation tracker also uses.
              </p>
            )}
          </div>

          {/* Failure Reason — always present. This is what lands on
              Io.failure_mode. It does NOT write to the Blocker columns on
              Devices. */}
          <div className="space-y-2">
            <Label htmlFor="failureMode">
              Failure Reason <span className="text-destructive">*</span>
            </Label>
            <Select value={failureMode} onValueChange={setFailureMode}>
              <SelectTrigger id="failureMode">
                <SelectValue placeholder="Select a failure reason..." />
              </SelectTrigger>
              <SelectContent>
                {FAILURE_REASON_GROUPS.map((g) => (
                  <SelectGroup key={g.party}>
                    <SelectLabel>{g.party}</SelectLabel>
                    {g.reasons.map((r) => (
                      <SelectItem key={r} value={r}>{r}</SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            {!unpassMode && (
              <p className="text-[11px] text-muted-foreground">
                The Blocker (responsible party) column is left alone on a regular Fail — assign one explicitly via Unpass when warranted.
              </p>
            )}
          </div>

          {/* Blocker fields — only in unpass mode. These go to the shared
              Devices row (the same two columns the installation tracker
              owns). */}
          {unpassMode && (
            <>
              <div className="space-y-2">
                <Label htmlFor="blockerParty">
                  Blocker (responsible party) <span className="text-destructive">*</span>
                </Label>
                <Select value={blockerParty} onValueChange={handleBlockerPartyChange}>
                  <SelectTrigger id="blockerParty">
                    <SelectValue placeholder="Select responsible party..." />
                  </SelectTrigger>
                  <SelectContent>
                    {BLOCKER_PARTIES.map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="blockerDescription">
                  Blocker Description <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={blockerDescription}
                  onValueChange={setBlockerDescription}
                  disabled={!blockerParty}
                >
                  <SelectTrigger id="blockerDescription">
                    <SelectValue placeholder={blockerParty ? "Select a blocker..." : "Pick a party first"} />
                  </SelectTrigger>
                  <SelectContent>
                    {descriptionOptions.map((d) => (
                      <SelectItem key={d} value={d}>{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="comment">
              {isOther ? (
                <span className="text-destructive font-semibold">Comment required</span>
              ) : (
                <>Additional Comments <span className="text-muted-foreground text-xs">(optional)</span></>
              )}
            </Label>
            <Textarea
              id="comment"
              placeholder={isOther ? "Explain the specific issue..." : "Optional — add any additional notes..."}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={500}
              rows={4}
              className={cn("resize-none", otherMissingComment && "border-destructive ring-1 ring-destructive")}
            />
            <p className="text-xs text-muted-foreground text-right">{comment.length}/500</p>
          </div>
        </div>

        <DialogFooter className="flex gap-2">
          <Button variant="outline" onClick={handleCancel}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={
              !failureMode
              || otherMissingComment
              || (unpassMode && (!blockerParty || !blockerDescription))
            }
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
