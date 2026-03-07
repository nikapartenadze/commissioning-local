"use client"

import { useState } from "react"
import { getApiBaseUrl } from "@/lib/api-config"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Settings, Wifi, CheckCircle, AlertCircle, Loader2 } from "lucide-react"

interface SetupWizardProps {
  onComplete: () => void
  isAdmin: boolean
}

export function SetupWizard({ onComplete, isAdmin }: SetupWizardProps) {
  const [step, setStep] = useState(1)
  const [config, setConfig] = useState({
    ip: "",
    path: "1,0",
    subsystemId: "",
    apiPassword: ""
  })
  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [error, setError] = useState("")

  const handleTestConnection = async () => {
    if (!config.ip) {
      setError("Please enter a PLC IP address")
      return
    }

    setIsTesting(true)
    setTestResult(null)
    setError("")

    try {
      // First save the config so backend can test it
      const saveResponse = await fetch(`${getApiBaseUrl()}/api/configuration/update-config-json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip: config.ip,
          path: config.path,
          subsystemId: config.subsystemId || "1",
          apiPassword: config.apiPassword,
          disableWatchdog: true // Start with watchdog disabled for setup
        })
      })

      if (!saveResponse.ok) {
        throw new Error("Failed to save configuration")
      }

      // Wait a moment for backend to reinitialize
      await new Promise(resolve => setTimeout(resolve, 2000))

      // Now test the connection
      const testResponse = await fetch(`${getApiBaseUrl()}/api/plc/test-connection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: config.ip, port: 44818 })
      })

      const result = await testResponse.json()
      setTestResult({
        success: result.success,
        message: result.success
          ? "PLC connection successful!"
          : "Could not connect to PLC. Check IP address and network."
      })

      if (result.success) {
        setStep(2)
      }
    } catch (err) {
      setTestResult({
        success: false,
        message: "Error testing connection. Make sure backend is running."
      })
    } finally {
      setIsTesting(false)
    }
  }

  const handleSaveAndFinish = async () => {
    if (!config.subsystemId) {
      setError("Please enter a Subsystem ID")
      return
    }

    setIsSaving(true)
    setError("")

    try {
      const response = await fetch(`${getApiBaseUrl()}/api/configuration/update-config-json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip: config.ip,
          path: config.path,
          subsystemId: config.subsystemId,
          apiPassword: config.apiPassword,
          disableWatchdog: false // Enable watchdog for production
        })
      })

      if (!response.ok) {
        throw new Error("Failed to save configuration")
      }

      // Wait for backend to reinitialize
      await new Promise(resolve => setTimeout(resolve, 2000))

      onComplete()
    } catch (err) {
      setError("Failed to save configuration. Please try again.")
    } finally {
      setIsSaving(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <AlertCircle className="w-16 h-16 mx-auto text-yellow-500 mb-4" />
            <CardTitle className="text-2xl">Setup Required</CardTitle>
            <CardDescription>
              This application needs to be configured by an administrator.
              Please contact your admin to set up the PLC connection.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted p-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center border-b">
          <Settings className="w-12 h-12 mx-auto text-primary mb-2" />
          <CardTitle className="text-2xl">Initial Setup</CardTitle>
          <CardDescription>
            Configure the PLC connection to get started
          </CardDescription>
          {/* Progress indicator */}
          <div className="flex justify-center gap-2 mt-4">
            <div className={`w-3 h-3 rounded-full ${step >= 1 ? "bg-primary" : "bg-muted"}`} />
            <div className={`w-3 h-3 rounded-full ${step >= 2 ? "bg-primary" : "bg-muted"}`} />
          </div>
        </CardHeader>

        <CardContent className="pt-6">
          {step === 1 && (
            <div className="space-y-4">
              <h3 className="font-semibold flex items-center gap-2">
                <Wifi className="w-5 h-5" />
                Step 1: PLC Connection
              </h3>

              <div className="space-y-2">
                <Label htmlFor="ip">PLC IP Address *</Label>
                <Input
                  id="ip"
                  placeholder="192.168.1.100"
                  value={config.ip}
                  onChange={(e) => setConfig({ ...config, ip: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="path">Communication Path</Label>
                <Input
                  id="path"
                  placeholder="1,0"
                  value={config.path}
                  onChange={(e) => setConfig({ ...config, path: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Ethernet/IP routing path (e.g., "1,0" for direct connection)
                </p>
              </div>

              {testResult && (
                <Alert variant={testResult.success ? "default" : "destructive"}>
                  {testResult.success ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  <AlertDescription>{testResult.message}</AlertDescription>
                </Alert>
              )}

              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h3 className="font-semibold flex items-center gap-2">
                <CheckCircle className="w-5 h-5 text-green-500" />
                Step 2: Project Settings
              </h3>

              <Alert>
                <CheckCircle className="h-4 w-4 text-green-500" />
                <AlertDescription>
                  PLC connected at {config.ip}
                </AlertDescription>
              </Alert>

              <div className="space-y-2">
                <Label htmlFor="subsystemId">Subsystem ID *</Label>
                <Input
                  id="subsystemId"
                  placeholder="1"
                  value={config.subsystemId}
                  onChange={(e) => setConfig({ ...config, subsystemId: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  The subsystem ID from the cloud project to test
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="apiPassword">Cloud API Password (optional)</Label>
                <Input
                  id="apiPassword"
                  type="text"
                  placeholder="For syncing with cloud"
                  value={config.apiPassword}
                  onChange={(e) => setConfig({ ...config, apiPassword: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Required for syncing test results to cloud
                </p>
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </CardContent>

        <CardFooter className="flex justify-between border-t pt-4">
          {step === 1 ? (
            <>
              <div /> {/* Spacer */}
              <Button onClick={handleTestConnection} disabled={isTesting || !config.ip}>
                {isTesting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Testing...
                  </>
                ) : (
                  "Test Connection"
                )}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button onClick={handleSaveAndFinish} disabled={isSaving || !config.subsystemId}>
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save & Start"
                )}
              </Button>
            </>
          )}
        </CardFooter>
      </Card>
    </div>
  )
}
