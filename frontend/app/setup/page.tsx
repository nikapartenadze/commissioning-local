"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CloudDownload, Loader2, CheckCircle2, AlertCircle } from "lucide-react"

export default function SetupPage() {
  const router = useRouter()
  const [remoteUrl, setRemoteUrl] = useState("")
  const [subsystemId, setSubsystemId] = useState("")
  const [apiPassword, setApiPassword] = useState("")
  const [plcIp, setPlcIp] = useState("")
  const [plcPath, setPlcPath] = useState("1,0")

  const [isPulling, setIsPulling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handlePullIOs = async () => {
    setIsPulling(true)
    setError(null)

    try {
      // Save config first
      const configRes = await fetch("/api/configuration", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteUrl,
          subsystemId,
          apiPassword,
          ip: plcIp,
          path: plcPath,
        }),
      })

      if (!configRes.ok) {
        throw new Error("Failed to save configuration")
      }

      // Pull IOs from cloud
      const pullRes = await fetch("/api/cloud/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteUrl,
          subsystemId,
          apiPassword,
        }),
      })

      const pullData = await pullRes.json()

      if (!pullRes.ok || !pullData.success) {
        throw new Error(pullData.message || "Failed to pull IOs from cloud")
      }

      setSuccess(true)

      // Redirect to commissioning page after 1.5 seconds
      setTimeout(() => {
        router.push(`/commissioning/${subsystemId}`)
      }, 1500)

    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setIsPulling(false)
    }
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/20">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="text-center">
              <CheckCircle2 className="h-16 w-16 text-green-500 mx-auto mb-4" />
              <h2 className="text-xl font-semibold mb-2">Setup Complete!</h2>
              <p className="text-muted-foreground">Redirecting to commissioning page...</p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/20 p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>PLC Configuration</CardTitle>
          <CardDescription>
            Configure your cloud connection and PLC settings to get started.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Cloud Settings */}
          <div className="space-y-4">
            <h3 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">
              Cloud Connection
            </h3>

            <div className="space-y-2">
              <Label htmlFor="remoteUrl">Remote URL</Label>
              <Input
                id="remoteUrl"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                placeholder="https://commissioning.example.com"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="subsystemId">Subsystem ID</Label>
              <Input
                id="subsystemId"
                value={subsystemId}
                onChange={(e) => setSubsystemId(e.target.value)}
                placeholder="16"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="apiPassword">API Password</Label>
              <Input
                id="apiPassword"
                type="password"
                value={apiPassword}
                onChange={(e) => setApiPassword(e.target.value)}
                placeholder="Enter API password"
              />
            </div>
          </div>

          {/* PLC Settings */}
          <div className="space-y-4">
            <h3 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">
              PLC Connection
            </h3>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="plcIp">PLC IP Address</Label>
                <Input
                  id="plcIp"
                  value={plcIp}
                  onChange={(e) => setPlcIp(e.target.value)}
                  placeholder="192.168.1.100"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="plcPath">Path</Label>
                <Input
                  id="plcPath"
                  value={plcPath}
                  onChange={(e) => setPlcPath(e.target.value)}
                  placeholder="1,0"
                />
              </div>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-destructive text-sm">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          <Button
            onClick={handlePullIOs}
            disabled={isPulling || !subsystemId}
            className="w-full"
          >
            {isPulling ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Pulling IOs...
              </>
            ) : (
              <>
                <CloudDownload className="mr-2 h-4 w-4" />
                Pull IOs & Start
              </>
            )}
          </Button>

          <p className="text-xs text-muted-foreground text-center">
            This will fetch IO definitions from the cloud and save your configuration.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
