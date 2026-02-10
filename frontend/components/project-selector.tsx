"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { 
  ChevronDown, 
  ChevronRight, 
  Play, 
  Wifi, 
  WifiOff, 
  Settings,
  TestTube,
  Database,
  Users
} from "lucide-react"
import { cn } from "@/lib/utils"

interface Subsystem {
  id: number
  name: string
  ioCount: number
  isConnected: boolean
  lastTested?: string
  status: 'active' | 'inactive' | 'testing'
}

interface Project {
  id: number
  name: string
  description: string
  subsystemCount: number
  totalIos: number
  subsystems: Subsystem[]
  isExpanded: boolean
  remoteUrl: string
  apiPassword: string
}

interface ProjectSelectorProps {
  projects: Project[]
  onConnectToSubsystem: (projectId: number, subsystemId: number) => void
  onConfigureProject: (projectId: number) => void
  isLoading?: boolean
}

export function ProjectSelector({ 
  projects, 
  onConnectToSubsystem, 
  onConfigureProject,
  isLoading = false 
}: ProjectSelectorProps) {
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(new Set())

  const toggleProject = (projectId: number) => {
    const newExpanded = new Set(expandedProjects)
    if (newExpanded.has(projectId)) {
      newExpanded.delete(projectId)
    } else {
      newExpanded.add(projectId)
    }
    setExpandedProjects(newExpanded)
  }

  const getSubsystemStatusColor = (status: Subsystem['status']) => {
    switch (status) {
      case 'active': return 'bg-green-500'
      case 'testing': return 'bg-amber-500'
      case 'inactive': return 'bg-gray-400'
      default: return 'bg-gray-400'
    }
  }

  const getSubsystemStatusText = (status: Subsystem['status']) => {
    switch (status) {
      case 'active': return 'Active'
      case 'testing': return 'Testing'
      case 'inactive': return 'Inactive'
      default: return 'Unknown'
    }
  }

  return (
    <div className="space-y-4">
      {projects.map((project) => (
        <Card key={project.id} className="overflow-hidden">
          <CardHeader 
            className="cursor-pointer hover:bg-muted/50 transition-colors"
            onClick={() => toggleProject(project.id)}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                {expandedProjects.has(project.id) ? (
                  <ChevronDown className="h-5 w-5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                )}
                <div>
                  <CardTitle className="text-lg">{project.name}</CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    {project.description}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <Badge variant="secondary" className="text-xs">
                  {project.subsystemCount} subsystems
                </Badge>
                <Badge variant="outline" className="text-xs">
                  {project.totalIos} IOs
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    onConfigureProject(project.id)
                  }}
                  title="Configure Project"
                >
                  <Settings className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          
          {expandedProjects.has(project.id) && (
            <CardContent className="pt-0">
              <div className="space-y-3">
                {project.subsystems.map((subsystem) => (
                  <div
                    key={subsystem.id}
                    className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex items-center space-x-3">
                      <div className="flex items-center space-x-2">
                        <div className={cn(
                          "w-2 h-2 rounded-full",
                          getSubsystemStatusColor(subsystem.status)
                        )} />
                        <span className="font-medium">Subsystem {subsystem.id}</span>
                        <Badge variant="outline" className="text-xs">
                          {subsystem.name}
                        </Badge>
                      </div>
                      <div className="flex items-center space-x-4 text-sm text-muted-foreground">
                        <div className="flex items-center space-x-1">
                          <Database className="h-3 w-3" />
                          <span>{subsystem.ioCount} IOs</span>
                        </div>
                        {subsystem.lastTested && (
                          <div className="flex items-center space-x-1">
                            <TestTube className="h-3 w-3" />
                            <span>Last: {subsystem.lastTested}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    
                    <div className="flex items-center space-x-2">
                      <div className="flex items-center space-x-1">
                        {subsystem.isConnected ? (
                          <Wifi className="h-4 w-4 text-green-500" />
                        ) : (
                          <WifiOff className="h-4 w-4 text-red-500" />
                        )}
                        <span className="text-xs text-muted-foreground">
                          {subsystem.isConnected ? 'Connected' : 'Disconnected'}
                        </span>
                      </div>
                      
                      <Button
                        size="sm"
                        onClick={() => onConnectToSubsystem(project.id, subsystem.id)}
                        disabled={isLoading}
                        className="ml-2"
                      >
                        <Play className="h-4 w-4 mr-1" />
                        {isLoading ? 'Connecting...' : 'Test'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          )}
        </Card>
      ))}
    </div>
  )
}
