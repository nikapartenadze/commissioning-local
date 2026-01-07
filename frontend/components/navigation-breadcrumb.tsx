"use client"

import { Button } from "@/components/ui/button"
import { ChevronRight, Home, TestTube, Settings } from "lucide-react"
import Link from "next/link"

interface BreadcrumbItem {
  label: string
  href?: string
  icon?: React.ReactNode
}

interface NavigationBreadcrumbProps {
  items: BreadcrumbItem[]
  className?: string
}

export function NavigationBreadcrumb({ items, className = "" }: NavigationBreadcrumbProps) {
  return (
    <nav className={`flex items-center space-x-1 text-sm ${className}`}>
      {items.map((item, index) => (
        <div key={index} className="flex items-center">
          {index > 0 && (
            <ChevronRight className="h-4 w-4 text-muted-foreground mx-2" />
          )}
          
          {item.href ? (
            <Link href={item.href}>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto p-1 text-muted-foreground hover:text-foreground"
              >
                {item.icon && <span className="mr-1">{item.icon}</span>}
                {item.label}
              </Button>
            </Link>
          ) : (
            <span className="text-foreground font-medium">
              {item.icon && <span className="mr-1">{item.icon}</span>}
              {item.label}
            </span>
          )}
        </div>
      ))}
    </nav>
  )
}

// Predefined breadcrumb configurations
export const breadcrumbConfigs = {
  home: [
    { label: "Projects", icon: <Home className="h-4 w-4" /> }
  ],
  project: (projectName: string) => [
    { label: "Projects", href: "/", icon: <Home className="h-4 w-4" /> },
    { label: projectName, icon: <Settings className="h-4 w-4" /> }
  ],
  testing: (projectName: string, subsystemId: number) => [
    { label: "Projects", href: "/", icon: <Home className="h-4 w-4" /> },
    { label: projectName, href: "/", icon: <Settings className="h-4 w-4" /> },
    { label: `Subsystem ${subsystemId}` }
  ]
}
