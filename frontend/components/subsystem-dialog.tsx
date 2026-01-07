"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Copy, Info } from "lucide-react"
import { toast } from "@/hooks/use-toast"

type Subsystem = {
  id: number
  name: string
}

interface SubsystemDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
  subsystems: Subsystem[]
}

export function SubsystemDialog({ open, onOpenChange, projectName, subsystems }: SubsystemDialogProps) {
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    toast({
      title: "Copied!",
      description: `Subsystem ID ${text} copied to clipboard`,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Subsystems for {projectName}</DialogTitle>
        </DialogHeader>

        <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded-lg p-4 mb-4">
          <div className="flex gap-2">
            <Info className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="font-semibold text-blue-900 dark:text-blue-100 mb-1">
                Configuration Information
              </h4>
              <p className="text-sm text-blue-800 dark:text-blue-200">
                Use these subsystem IDs when configuring local IO Checkout Tool applications.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          {subsystems.map((subsystem) => (
            <Card key={subsystem.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-primary mb-1">
                      {subsystem.name || `Subsystem ${subsystem.id}`}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Subsystem ID: <span className="font-mono text-foreground">{subsystem.id}</span>
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(subsystem.id.toString())}
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    COPY ID
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

