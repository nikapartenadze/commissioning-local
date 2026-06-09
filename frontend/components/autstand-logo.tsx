"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * Theme-aware autStand wordmark.
 *
 * The shipped `logo_autstand.svg` has white letterforms designed for the dark
 * theme — they vanish on the light background. `logo_autstand_light.svg` is the
 * same artwork with those white strokes recolored to the light-theme foreground
 * slate. We render BOTH and let CSS pick: the light variant shows by default,
 * the dark variant shows under the `.dark` root class. This is driven purely by
 * the theme class (next-themes, `attribute="class"`), so it swaps live on toggle
 * with no JS state and no flash-of-wrong-logo.
 */
export function AutstandLogo({ className }: { className?: string }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo_autstand_light.svg"
        alt="Autstand"
        className={cn("block dark:hidden", className)}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo_autstand.svg"
        alt="Autstand"
        className={cn("hidden dark:block", className)}
      />
    </>
  )
}
