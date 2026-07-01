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
import {
  VFD_BLOCKER_PARTIES,
  VFD_BLOCKER_VOCAB,
  buildVfdBlockerDescription,
  type VfdBlockerParty,
} from "@/lib/blockers"

interface VfdBumpFailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  deviceName: string
  /** description is FINAL (Other already folded in via buildVfdBlockerDescription) */
  onSubmit: (party: VfdBlockerParty, description: string) => void
  onCancel: () => void
  /**
   * Optional dialog title. Defaults to the original bump-specific copy. The
   * reworked Test Run step reuses this same blocker dialog to record an
   * electrical/controls fault that stops the drive from running, so it passes a
   * fault-specific title. The underlying blocker payload is identical.
   */
  title?: string
}

// 'Other' is stored/matched as 'Other' but shown with a please-specify hint.
const OTHER_LABEL = "Other — please specify"

export function VfdBumpFailDialog({
  open,
  onOpenChange,
  deviceName,
  onSubmit,
  onCancel,
  title = "Bump didn't work — record blocker",
}: VfdBumpFailDialogProps) {
  const [party, setParty] = useState<VfdBlockerParty | "">("")
  const [description, setDescription] = useState<string>("")
  const [comment, setComment] = useState("")

  // Reset every time the dialog reopens.
  useEffect(() => {
    if (open) {
      setParty("")
      setDescription("")
      setComment("")
    }
  }, [open])

  // When party changes, drop any stale description that no longer belongs.
  const handlePartyChange = (next: string) => {
    const p = next as VfdBlockerParty | ""
    setParty(p)
    if (p === "" || !VFD_BLOCKER_VOCAB[p].includes(description)) {
      setDescription("")
    }
    setComment("")
  }

  const descriptionOptions = party ? VFD_BLOCKER_VOCAB[party] : []
  const isOther = description === "Other"
  const otherMissingComment = isOther && !comment.trim()
  const isValid = !!party && !!description && !otherMissingComment

  const handleSubmit = () => {
    if (!party) {
      toast({ title: "Pick the responsible party", variant: "destructive" })
      return
    }
    if (!description) {
      toast({ title: "Pick what went wrong", variant: "destructive" })
      return
    }
    if (otherMissingComment) {
      toast({ title: "Comment is required when the reason is 'Other'", variant: "destructive" })
      return
    }

    const finalDescription = buildVfdBlockerDescription(description, comment)
    onSubmit(party, finalDescription)

    setParty("")
    setDescription("")
    setComment("")
    onOpenChange(false)
  }

  const handleCancel = () => {
    setParty("")
    setDescription("")
    setComment("")
    onCancel()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">VFD:</span>
              <Badge variant="outline" className="font-mono">{deviceName}</Badge>
            </div>
            <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1 mt-1">
              <AlertCircle className="w-3 h-3 shrink-0" />
              This blocker writes to the shared device row that the installation tracker also uses, routing it to the responsible vendor.
            </p>
          </div>

          {/* Responsible party */}
          <div className="space-y-2">
            <Label htmlFor="vfdBlockerParty">
              Responsible party <span className="text-destructive">*</span>
            </Label>
            <Select value={party} onValueChange={handlePartyChange}>
              <SelectTrigger id="vfdBlockerParty">
                <SelectValue placeholder="Select responsible party..." />
              </SelectTrigger>
              <SelectContent>
                {VFD_BLOCKER_PARTIES.map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Description cascades from party */}
          <div className="space-y-2">
            <Label htmlFor="vfdBlockerDescription">
              What went wrong <span className="text-destructive">*</span>
            </Label>
            <Select
              value={description}
              onValueChange={setDescription}
              disabled={!party}
            >
              <SelectTrigger id="vfdBlockerDescription">
                <SelectValue placeholder={party ? "Select a blocker..." : "Pick a party first"} />
              </SelectTrigger>
              <SelectContent>
                {descriptionOptions.map((d) => (
                  <SelectItem key={d} value={d}>{d === "Other" ? OTHER_LABEL : d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Comment — only when Other is selected, then required */}
          {isOther && (
            <div className="space-y-2">
              <Label htmlFor="vfdBlockerComment">
                <span className="text-destructive font-semibold">Comment required</span>
              </Label>
              <Textarea
                id="vfdBlockerComment"
                placeholder="Explain the specific issue..."
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={500}
                rows={4}
                className={cn("resize-none", otherMissingComment && "border-destructive ring-1 ring-destructive")}
              />
              <p className="text-xs text-muted-foreground text-right">{comment.length}/500</p>
            </div>
          )}
        </div>

        <DialogFooter className="flex gap-2">
          <Button variant="outline" onClick={handleCancel}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={!isValid}
          >
            Record blocker
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
