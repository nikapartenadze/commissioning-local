"use client"

/**
 * Hidden page that renders actual app components with sample data
 * for Playwright to screenshot. Not linked from anywhere.
 */
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AlertCircle, Zap, RotateCcw, Circle, CheckCircle2, XCircle, Eye } from "lucide-react"

export default function ScreenshotPage() {
  return (
    <div className="p-8 space-y-12 max-w-xl mx-auto bg-background min-h-screen">
      {/* Pass/Fail Dialog */}
      <div id="pass-fail-dialog">
        <div className="bg-card border rounded-xl shadow-lg p-6 space-y-4">
          <div>
            <h3 className="text-lg font-semibold">Input value changed</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Tag:</span>
              <Badge variant="outline" className="font-mono">UL26_19_FIOM1_X0.PIN4_DI</Badge>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Description:</span>
              <span className="text-sm text-muted-foreground">Photoeye Sensor Input</span>
            </div>
            <div className="p-3 bg-muted rounded-lg">
              <div className="text-sm font-medium text-center">
                Input value changed to{' '}
                <Badge variant="default" className="text-sm font-bold mx-1">True</Badge>
                {' '}pass or not?
              </div>
            </div>
          </div>
          <div className="flex justify-between items-center gap-2">
            <Button variant="outline" size="sm" className="text-red-600 border-red-300">Stop Testing</Button>
            <div className="flex gap-2">
              <Button variant="outline">Cancel</Button>
              <Button variant="destructive">Fail</Button>
              <Button>Pass</Button>
            </div>
          </div>
        </div>
      </div>

      {/* Fail Comment Dialog */}
      <div id="fail-dialog">
        <div className="bg-card border rounded-xl shadow-lg p-6 space-y-4">
          <h3 className="text-lg font-semibold">Mark as Failed</h3>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Tag:</span>
              <Badge variant="outline" className="font-mono">UL26_19_FIOM1_X1.PIN4_DO</Badge>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Description:</span>
              <span className="text-sm text-muted-foreground">Motor Run Output</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Device Type:</span>
              <Badge variant="secondary">FIOM</Badge>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Why did it fail? <span className="text-destructive">*</span></Label>
            <Select defaultValue="No response">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="No response">No response</SelectItem>
                <SelectItem value="Intermittent">Intermittent</SelectItem>
                <SelectItem value="Damaged">Damaged</SelectItem>
                <SelectItem value="Wrong wiring">Wrong wiring</SelectItem>
                <SelectItem value="Other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Additional Comments <span className="text-muted-foreground text-xs">(optional)</span></Label>
            <Textarea placeholder="Add any additional notes..." defaultValue="Wire disconnected at terminal block 3" rows={3} className="resize-none" />
            <p className="text-xs text-muted-foreground text-right">36/500</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline">Cancel</Button>
            <Button variant="destructive">Confirm Failure</Button>
          </div>
        </div>
      </div>

      {/* Fire Output */}
      <div id="fire-output">
        <div className="bg-card border rounded-xl shadow-lg p-4">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <p className="font-mono text-sm font-medium">NCP1_1_VFD:O.Run</p>
              <p className="text-xs text-muted-foreground">Motor Run Command</p>
            </div>
            <Button className="bg-amber-500 hover:bg-amber-600 text-black font-bold gap-1">
              <Zap className="w-4 h-4" /> FIRE
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-3 border-t pt-2">Hold button to keep output ON. Release to turn OFF.</p>
        </div>
      </div>
      {/* IO Grid with mixed results */}
      <div id="io-grid-results">
        <div className="bg-card border rounded-xl shadow-lg overflow-hidden">
          <div className="px-4 py-2 border-b bg-muted/50">
            <span className="text-sm font-semibold">I/O Points — MCM09</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">IO Name</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2">Result</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {/* Passed rows */}
              <tr className="border-b bg-green-50 dark:bg-green-950/30">
                <td className="px-3 py-2 font-mono text-xs">UL26_19_FIOM1_X0.PIN4_DI</td>
                <td className="px-3 py-2"><Circle className="w-3 h-3 fill-green-500 text-green-500" /></td>
                <td className="px-3 py-2"><Badge className="bg-green-600 text-white text-xs">Passed</Badge></td>
                <td className="px-3 py-2 text-right"><Button variant="ghost" size="icon" className="h-7 w-7"><Eye className="w-3.5 h-3.5" /></Button></td>
              </tr>
              <tr className="border-b bg-green-50 dark:bg-green-950/30">
                <td className="px-3 py-2 font-mono text-xs">UL26_19_FIOM1_X1.PIN3_DI</td>
                <td className="px-3 py-2"><Circle className="w-3 h-3 fill-green-500 text-green-500" /></td>
                <td className="px-3 py-2"><Badge className="bg-green-600 text-white text-xs">Passed</Badge></td>
                <td className="px-3 py-2 text-right"><Button variant="ghost" size="icon" className="h-7 w-7"><Eye className="w-3.5 h-3.5" /></Button></td>
              </tr>
              {/* Failed row */}
              <tr className="border-b bg-red-50 dark:bg-red-950/30">
                <td className="px-3 py-2 font-mono text-xs">UL26_19_FIOM1_X2.PIN4_DI</td>
                <td className="px-3 py-2"><Circle className="w-3 h-3 fill-red-500 text-red-500" /></td>
                <td className="px-3 py-2"><Badge variant="destructive" className="text-xs">Failed</Badge></td>
                <td className="px-3 py-2 text-right flex justify-end gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7"><RotateCcw className="w-3.5 h-3.5" /></Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7"><Eye className="w-3.5 h-3.5" /></Button>
                </td>
              </tr>
              {/* Not tested rows */}
              <tr className="border-b">
                <td className="px-3 py-2 font-mono text-xs">UL26_19_FIOM1_X3.PIN3_DI</td>
                <td className="px-3 py-2"><Circle className="w-3 h-3 fill-gray-300 text-gray-300" /></td>
                <td className="px-3 py-2"><Badge variant="outline" className="text-xs text-muted-foreground">Not Tested</Badge></td>
                <td className="px-3 py-2 text-right"><Button variant="ghost" size="icon" className="h-7 w-7"><Eye className="w-3.5 h-3.5" /></Button></td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-mono text-xs">UL26_19_FIOM1_X4.PIN4_DI</td>
                <td className="px-3 py-2"><Circle className="w-3 h-3 fill-gray-300 text-gray-300" /></td>
                <td className="px-3 py-2"><Badge variant="outline" className="text-xs text-muted-foreground">Not Tested</Badge></td>
                <td className="px-3 py-2 text-right"><Button variant="ghost" size="icon" className="h-7 w-7"><Eye className="w-3.5 h-3.5" /></Button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Comment Section */}
      <div id="comment-section">
        <div className="bg-card border rounded-xl shadow-lg p-5 space-y-3">
          <div className="space-y-1">
            <p className="font-mono text-sm font-medium">UL26_19_FIOM1_X2.PIN4_DI</p>
            <p className="text-xs text-muted-foreground">Photoeye Sensor — Lane 3 Divert Confirm</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Comments</Label>
            <Textarea
              rows={3}
              className="resize-none text-sm"
              defaultValue="Wire loose at terminal TB-3, tightened and retested"
              readOnly
            />
            <div className="flex justify-between items-center">
              <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Saved</span>
              <span className="text-xs text-muted-foreground">47/500</span>
            </div>
          </div>
        </div>
      </div>

      {/* Reset Action */}
      <div id="reset-action">
        <div className="bg-card border rounded-xl shadow-lg overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              <tr className="bg-red-50 dark:bg-red-950/30">
                <td className="px-3 py-3 font-mono text-xs">UL26_19_FIOM1_X2.PIN4_DI</td>
                <td className="px-3 py-3"><Badge variant="destructive" className="text-xs">Failed</Badge></td>
                <td className="px-3 py-3 text-right">
                  <Button variant="outline" size="icon" className="h-8 w-8 border-amber-400 bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/40 dark:hover:bg-amber-900/40">
                    <RotateCcw className="w-4 h-4 text-amber-600" />
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Network Topology View */}
      <div id="network-view">
        <div className="bg-card border rounded-xl shadow-lg p-6 space-y-4">
          <div className="text-sm font-semibold">Network Topology — Ring 1</div>
          <div className="flex items-center justify-center gap-0">
            {/* MCM */}
            <div className="border-2 border-green-500 rounded-lg px-4 py-3 text-center bg-green-50 dark:bg-green-950/30">
              <div className="flex items-center gap-1.5 justify-center">
                <Circle className="w-2.5 h-2.5 fill-green-500 text-green-500" />
                <span className="text-xs font-bold">MCM09</span>
              </div>
              <span className="text-[10px] text-muted-foreground">Controller</span>
            </div>
            {/* Dashed line */}
            <div className="w-10 border-t-2 border-dashed border-green-400" />
            {/* DPM1 */}
            <div className="border-2 border-green-500 rounded-lg px-4 py-3 text-center bg-green-50 dark:bg-green-950/30">
              <div className="flex items-center gap-1.5 justify-center">
                <Circle className="w-2.5 h-2.5 fill-green-500 text-green-500" />
                <span className="text-xs font-bold">DPM1</span>
              </div>
              <span className="text-[10px] text-muted-foreground">I/O Module</span>
            </div>
            {/* Dashed line */}
            <div className="w-10 border-t-2 border-dashed border-red-400" />
            {/* DPM2 - faulted */}
            <div className="border-2 border-red-500 rounded-lg px-4 py-3 text-center bg-red-50 dark:bg-red-950/30">
              <div className="flex items-center gap-1.5 justify-center">
                <Circle className="w-2.5 h-2.5 fill-red-500 text-red-500" />
                <span className="text-xs font-bold">DPM2</span>
              </div>
              <span className="text-[10px] text-muted-foreground">I/O Module</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground text-center">Click a DPM to see connected devices</p>
        </div>
      </div>
    </div>
  )
}
