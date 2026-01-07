"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { 
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { 
  Eye, 
  Settings, 
  Play, 
  Wifi, 
  Copy,
  Info,
  Loader2
} from "lucide-react"
import { SubsystemConfigDialog } from "./subsystem-config-dialog"

interface Subsystem {
  id: number
  name: string
  ip: string
  path: string
  isConnected: boolean
}

interface Project {
  id: number
  name: string
  subsystemCount: number
  ioCount: number
  subsystemNames: string[]
  subsystems: Subsystem[]
}

interface ProjectListEnhancedProps {
  projects: Project[]
  onConnectToSubsystem: (projectId: number, subsystemId: number) => void
  onConfigureSubsystem: (projectId: number, subsystemId: number) => void
}

export function ProjectListEnhanced({ 
  projects, 
  onConnectToSubsystem,
  onConfigureSubsystem 
}: ProjectListEnhancedProps) {
  const router = useRouter()
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [configDialogOpen, setConfigDialogOpen] = useState(false)
  const [selectedSubsystem, setSelectedSubsystem] = useState<{
    projectName: string
    subsystemId: number
    subsystemName: string
  } | null>(null)
  const [connecting, setConnecting] = useState<number | null>(null)

  const handleViewDashboard = (projectId: number) => {
    router.push(`/project/${projectId}`)
  }

  const handleConnectToSubsystem = async (project: Project, subsystem: Subsystem) => {
    setConnecting(subsystem.id)
    try {
      // For now, just navigate directly if it's the Test project (ID 6)
      if (project.id === 6) {
        router.push(`/commissioning/${subsystem.id}`)
      } else {
        // For other projects, show alert that they need configuration
        alert('Please configure this subsystem first by clicking the gear icon')
      }
    } catch (error) {
      console.error('Error connecting:', error)
      alert('Failed to connect to subsystem')
    } finally {
      setConnecting(null)
    }
  }

  const handleConfigureSubsystem = (project: Project, subsystem: Subsystem) => {
    setSelectedSubsystem({
      projectName: project.name,
      subsystemId: subsystem.id,
      subsystemName: subsystem.name
    })
    setConfigDialogOpen(true)
  }

  const handleConfigSaved = () => {
    // Refresh or show success message
    console.log('Configuration saved successfully')
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {projects.map((project) => (
        <Card key={project.id} className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg text-primary">
              {project.name}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Project ID: {project.id}
            </p>
          </CardHeader>
          
          <CardContent className="space-y-4">
            {/* Summary Badges */}
            <div className="flex gap-2">
              <Badge variant="secondary" className="text-xs">
                {project.subsystemCount} {project.subsystemCount === 1 ? 'Subsystem' : 'Subsystems'}
              </Badge>
              <Badge variant="default" className="text-xs bg-blue-600">
                {project.ioCount} IOs
              </Badge>
            </div>

            {/* Subsystems List */}
            <div className="text-sm text-muted-foreground">
              <span className="font-medium">Subsystems:</span> {project.subsystemNames.join(', ')}
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2">
              <Button 
                onClick={() => handleViewDashboard(project.id)}
                className="flex-1 bg-blue-600 hover:bg-blue-700"
              >
                <Eye className="h-4 w-4 mr-2" />
                View Dashboard
              </Button>
              
              <Dialog>
                <DialogTrigger asChild>
                  <Button 
                    variant="outline" 
                    className="flex-1"
                    onClick={() => setSelectedProject(project)}
                  >
                    <Settings className="h-4 w-4 mr-2" />
                    Connect to Subsystem
                  </Button>
                </DialogTrigger>
                
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                      <Settings className="h-5 w-5" />
                      Subsystems for {project.name}
                    </DialogTitle>
                  </DialogHeader>
                  
                  <div className="space-y-4">
                    {/* Configuration Information */}
                    <div className="flex items-start gap-3 p-3 bg-muted rounded-lg">
                      <Info className="h-5 w-5 text-blue-500 mt-0.5" />
                      <div>
                        <h4 className="font-semibold text-sm">Configuration Information</h4>
                        <p className="text-xs text-muted-foreground mt-1">
                          Use these subsystem IDs when configuring local IO Checkout Tool applications.
                        </p>
                      </div>
                    </div>

                    {/* Subsystems List */}
                    <div className="space-y-3">
                      {project.subsystems.length > 0 ? (
                        project.subsystems.map((subsystem) => (
                          <div key={subsystem.id} className="flex items-center justify-between p-3 border rounded-lg">
                            <div className="flex-1">
                              <div className="font-bold text-blue-600 text-lg">
                                {subsystem.name}
                              </div>
                              <div className="text-sm text-muted-foreground">
                                Subsystem ID: {subsystem.id}
                              </div>
                              <div className="text-xs text-muted-foreground mt-1">
                                IP: {subsystem.ip} | Path: {subsystem.path}
                              </div>
                            </div>
                            
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleConfigureSubsystem(project, subsystem)}
                                title="Configure Connection"
                              >
                                <Settings className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => handleConnectToSubsystem(project, subsystem)}
                                className="bg-blue-600 hover:bg-blue-700"
                                disabled={connecting === subsystem.id}
                              >
                                {connecting === subsystem.id ? (
                                  <>
                                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                    Connecting...
                                  </>
                                ) : (
                                  <>
                                    <Play className="h-4 w-4 mr-1" />
                                    Connect
                                  </>
                                )}
                              </Button>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-8 text-muted-foreground">
                          <div className="mb-2">
                            <Settings className="h-8 w-8 mx-auto mb-2 opacity-50" />
                          </div>
                          <p className="text-sm font-medium">No Subsystem Data Available</p>
                          <p className="text-xs mt-1">
                            This project's subsystem configuration is not yet set up.
                          </p>
                          <p className="text-xs mt-1">
                            Contact your administrator to configure subsystem connections.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </CardContent>
        </Card>
      ))}
      
      {/* Configuration Dialog */}
      {selectedSubsystem && (
        <SubsystemConfigDialog
          open={configDialogOpen}
          onOpenChange={setConfigDialogOpen}
          projectName={selectedSubsystem.projectName}
          subsystemId={selectedSubsystem.subsystemId}
          subsystemName={selectedSubsystem.subsystemName}
          onSave={handleConfigSaved}
        />
      )}
    </div>
  )
}
