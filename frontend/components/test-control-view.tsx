"use client"

import { useState, useEffect } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Play, Square, AlertTriangle, CheckCircle } from "lucide-react"
import { cn } from "@/lib/utils"

interface IoItem {
  id: number
  name: string
  description: string | null
  result: string | null
  timestamp: string | null
  comments: string | null
  state: string | null
  subsystemName: string
}

interface TestControlViewProps {
  currentIo: IoItem | null
  isTesting: boolean
  isOrderMode: boolean
  onToggleTesting: () => void
  onFireOutput: (io: IoItem) => void
  onMarkFailed: (io: IoItem) => void
  onMarkPassed: (io: IoItem) => void
}

export function TestControlView({
  currentIo,
  isTesting,
  isOrderMode,
  onToggleTesting,
  onFireOutput,
  onMarkFailed,
  onMarkPassed
}: TestControlViewProps) {
  const [isFiring, setIsFiring] = useState(false)
  const [showPassAnimation, setShowPassAnimation] = useState(false)

  // Show pass animation when test is marked as passed
  useEffect(() => {
    if (currentIo?.result === 'Passed') {
      setShowPassAnimation(true)
      setTimeout(() => setShowPassAnimation(false), 2000)
    }
  }, [currentIo?.result])

  const handleFireDown = () => {
    if (currentIo && isTesting) {
      setIsFiring(true)
      onFireOutput(currentIo)
    }
  }

  const handleFireUp = () => {
    setIsFiring(false)
  }

  const handleMarkFailed = () => {
    if (currentIo && isTesting) {
      onMarkFailed(currentIo)
    }
  }

  const handleMarkPassed = () => {
    if (currentIo && isTesting) {
      onMarkPassed(currentIo)
      setShowPassAnimation(true)
      setTimeout(() => setShowPassAnimation(false), 2000)
    }
  }

  if (!isOrderMode) {
    return null // Only show in order mode
  }

  return (
    <Card className="p-6 mb-4">
      <div className="space-y-4">
        {/* Current Test Info */}
        <div>
          <h3 className="font-semibold text-xl mb-3">Current Test</h3>
          <div className="space-y-2">
            <div className="text-base">
              <span className="font-medium">Tag:</span>{" "}
              <span className="font-mono text-primary">
                {currentIo?.name || "No active test"}
              </span>
            </div>
            <div className="text-base text-muted-foreground">
              {currentIo?.description || "Click on any IO in the table to select it for testing"}
            </div>
            {currentIo && (
              <Badge 
                variant={currentIo.result === 'Passed' ? 'default' : 
                        currentIo.result === 'Failed' ? 'destructive' : 'secondary'}
                className="text-sm px-3 py-1"
              >
                {currentIo.result || 'Not Tested'}
              </Badge>
            )}
          </div>
        </div>

        {/* Test Controls */}
        {currentIo && (
          <div className="space-y-3">
            {/* Fire Button - Only for outputs */}
            {currentIo.name?.includes(':O.') && (
              <div>
                <Button
                  size="lg"
                  className={cn(
                    "w-full h-12 text-lg font-bold",
                    isFiring 
                      ? "bg-green-600 hover:bg-green-700" 
                      : "bg-blue-600 hover:bg-blue-700",
                    !isTesting && "opacity-50 cursor-not-allowed"
                  )}
                  disabled={!isTesting}
                  onMouseDown={handleFireDown}
                  onMouseUp={handleFireUp}
                  onMouseLeave={handleFireUp}
                  title="Fire Output (hold to keep firing)"
                >
                  FIRE OUTPUT
                </Button>
              </div>
            )}

            {/* Test Result Buttons */}
            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="outline"
                size="lg"
                className="h-12 text-lg font-semibold border-green-500 text-green-600 hover:bg-green-50"
                disabled={!isTesting}
                onClick={handleMarkPassed}
                title="Mark as passed"
              >
                PASS
              </Button>
              
              <Button
                variant="outline"
                size="lg"
                className="h-12 text-lg font-semibold border-red-500 text-red-600 hover:bg-red-50"
                disabled={!isTesting}
                onClick={handleMarkFailed}
                title="Mark as failed"
              >
                FAIL
              </Button>
            </div>

            {/* Testing Toggle */}
            <Button
              size="lg"
              variant={isTesting ? "destructive" : "default"}
              className="w-full h-12 text-lg font-semibold"
              onClick={onToggleTesting}
              title={isTesting ? "Stop Testing" : "Start Testing"}
            >
              {isTesting ? (
                <>
                  <Square className="w-5 h-5 mr-2" />
                  Stop Testing
                </>
              ) : (
                <>
                  <Play className="w-5 h-5 mr-2" />
                  Start Testing
                </>
              )}
            </Button>
          </div>
        )}
      </div>

      {/* Pass Animation */}
      {showPassAnimation && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="animate-pulse">
            <CheckCircle className="w-24 h-24 text-green-500" />
          </div>
        </div>
      )}
    </Card>
  )
}
