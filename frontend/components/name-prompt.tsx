"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface NamePromptProps {
  onNameSet: (name: string) => void
}

export function NamePrompt({ onNameSet }: NamePromptProps) {
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const [previousName] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('tester-name-previous')
    }
    return null
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError("Please enter your name")
      return
    }
    localStorage.setItem("tester-name", trimmed)
    localStorage.removeItem("tester-name-previous")
    onNameSet(trimmed)
  }

  return (
    <div className="fixed inset-0 z-[9999] bg-background/80 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-card border rounded-lg shadow-lg p-8 w-full max-w-md mx-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo_autstand.svg" alt="Autstand" className="h-8 mx-auto mb-4" />
        <h2 className="text-2xl font-bold text-center mb-2">Who is testing?</h2>
        <p className="text-muted-foreground text-center mb-6">
          Enter your name to continue. This will be recorded with all test results.
        </p>
        {previousName && (
          <p className="text-sm text-muted-foreground text-center mb-4">
            Current: <span className="font-medium text-foreground">{previousName}</span>
          </p>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Input
              autoFocus
              placeholder="Enter your name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (error) setError("")
              }}
              className={error ? "border-destructive" : ""}
            />
            {error && (
              <p className="text-sm text-destructive mt-1">{error}</p>
            )}
          </div>
          <Button type="submit" className="w-full" size="lg">
            Continue
          </Button>
        </form>
      </div>
    </div>
  )
}
