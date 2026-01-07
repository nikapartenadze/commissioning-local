"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuTrigger,
  DropdownMenuSeparator 
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"
import { 
  ChevronDown, 
  TestTube, 
  Wifi, 
  WifiOff, 
  ArrowRightLeft,
  Settings
} from "lucide-react"

interface Subsystem {
  id: number
  name: string
  projectName: string
  isConnected: boolean
  ioCount: number
}

interface SubsystemSwitcherProps {
  currentSubsystem: Subsystem
  availableSubsystems: Subsystem[]
  onSwitchSubsystem: (subsystemId: number) => void
  onConfigureProject: (projectName: string) => void
  isLoading?: boolean
}

export function SubsystemSwitcher({
  currentSubsystem,
  availableSubsystems,
  onSwitchSubsystem,
  onConfigureProject,
  isLoading = false
}: SubsystemSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false)

  const handleSwitch = (subsystemId: number) => {
    onSwitchSubsystem(subsystemId)
    setIsOpen(false)
  }

  const handleConfigure = (projectName: string) => {
    onConfigureProject(projectName)
    setIsOpen(false)
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button 
          variant="outline" 
          className="min-w-[200px] justify-between"
          disabled={isLoading}
        >
          <div className="flex items-center space-x-2">
            <TestTube className="h-4 w-4" />
            <span className="truncate">
              {currentSubsystem.projectName} - Subsystem {currentSubsystem.id}
            </span>
            {currentSubsystem.isConnected ? (
              <Wifi className="h-3 w-3 text-green-500" />
            ) : (
              <WifiOff className="h-3 w-3 text-red-500" />
            )}
          </div>
          <ChevronDown className="h-4 w-4 ml-2" />
        </Button>
      </DropdownMenuTrigger>
      
      <DropdownMenuContent className="w-80" align="end" side="top">
        <div className="px-2 py-1.5 text-sm font-semibold text-muted-foreground">
          Current Subsystem
        </div>
        <DropdownMenuItem disabled className="cursor-default">
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center space-x-2">
              <TestTube className="h-4 w-4" />
              <span>Subsystem {currentSubsystem.id}</span>
              <Badge variant="outline" className="text-xs">
                {currentSubsystem.name}
              </Badge>
            </div>
            <div className="flex items-center space-x-1">
              {currentSubsystem.isConnected ? (
                <Wifi className="h-3 w-3 text-green-500" />
              ) : (
                <WifiOff className="h-3 w-3 text-red-500" />
              )}
              <span className="text-xs text-muted-foreground">
                {currentSubsystem.ioCount} IOs
              </span>
            </div>
          </div>
        </DropdownMenuItem>
        
        <DropdownMenuSeparator />
        
        <div className="px-2 py-1.5 text-sm font-semibold text-muted-foreground">
          Switch to Other Subsystems
        </div>
        
        {availableSubsystems
          .filter(sub => sub.id !== currentSubsystem.id)
          .map((subsystem) => (
            <DropdownMenuItem
              key={subsystem.id}
              onClick={() => handleSwitch(subsystem.id)}
              className="cursor-pointer"
            >
              <div className="flex items-center justify-between w-full">
                <div className="flex items-center space-x-2">
                  <ArrowRightLeft className="h-4 w-4" />
                  <span>Subsystem {subsystem.id}</span>
                  <Badge variant="outline" className="text-xs">
                    {subsystem.name}
                  </Badge>
                </div>
                <div className="flex items-center space-x-1">
                  {subsystem.isConnected ? (
                    <Wifi className="h-3 w-3 text-green-500" />
                  ) : (
                    <WifiOff className="h-3 w-3 text-red-500" />
                  )}
                  <span className="text-xs text-muted-foreground">
                    {subsystem.ioCount} IOs
                  </span>
                </div>
              </div>
            </DropdownMenuItem>
          ))}
        
        <DropdownMenuSeparator />
        
        <DropdownMenuItem
          onClick={() => handleConfigure(currentSubsystem.projectName)}
          className="cursor-pointer"
        >
          <Settings className="h-4 w-4 mr-2" />
          Configure Project Settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
