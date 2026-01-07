import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatTimestamp(timestamp: string | null | undefined): string {
  if (!timestamp) return "Never"
  
  try {
    const date = new Date(timestamp)
    return date.toLocaleString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    })
  } catch {
    return timestamp
  }
}

export function getResultColor(result: string | null | undefined): string {
  if (result === "Passed") return "text-green-600 dark:text-green-400"
  if (result === "Failed") return "text-red-600 dark:text-red-400"
  return "text-muted-foreground"
}

export function getResultBadgeVariant(result: string | null | undefined): "default" | "success" | "destructive" | "secondary" {
  if (result === "Passed") return "success"
  if (result === "Failed") return "destructive"
  return "secondary"
}

export function isValidTestableItem(io: { description?: string | null }): boolean {
  const desc = io.description || ""
  return (!desc.includes("SPARE") && desc !== "Input" && desc !== "Output")
}

