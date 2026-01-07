// Authentication disabled for testing purposes
// "use client"

// import Link from "next/link"
// import { Button } from "@/components/ui/button"
// import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
// import { AlertCircle } from "lucide-react"

export default function AuthErrorPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20 flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center">
        <h1 className="text-2xl font-bold mb-4">Authentication Disabled</h1>
        <p className="text-muted-foreground">
          Authentication is disabled for testing purposes. 
          <br />
          <a href="/" className="text-primary hover:underline">Go to main application</a>
        </p>
      </div>
    </div>
  )
}

