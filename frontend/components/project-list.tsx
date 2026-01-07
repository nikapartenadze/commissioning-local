"use client"

import Link from "next/link"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { SubsystemDialog } from "@/components/subsystem-dialog"
import { Eye, Settings, TestTube } from "lucide-react"

type ProjectWithSubsystems = {
  id: number
  name: string
  subsystemCount: number
  ioCount: number
  subsystemNames: (string | null)[]
  subsystems: Array<{ id: number; name: string | null }>
}

export function ProjectList({ projects }: { projects: ProjectWithSubsystems[] }) {
  const [selectedProject, setSelectedProject] = useState<ProjectWithSubsystems | null>(null)
  const [showSubsystemDialog, setShowSubsystemDialog] = useState(false)

  const handleViewSubsystems = (project: ProjectWithSubsystems) => {
    setSelectedProject(project)
    setShowSubsystemDialog(true)
  }

  if (projects.length === 0) {
    return (
      <Card className="p-8 text-center">
        <CardContent>
          <p className="text-muted-foreground">No projects found in the system.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
      {projects.map((project) => (
        <Card 
          key={project.id} 
          className="hover:shadow-lg transition-all duration-200 hover:-translate-y-1 flex flex-col"
        >
          <CardHeader className="pb-3">
            <CardTitle className="text-primary text-lg sm:text-xl">{project.name}</CardTitle>
            <CardDescription className="text-xs sm:text-sm">Project ID: {project.id}</CardDescription>
          </CardHeader>
          
          <CardContent className="flex-1 pb-3">
            <div className="flex gap-2 mb-3 flex-wrap">
              <Badge variant="secondary" className="text-xs">
                {project.subsystemCount} Subsystem{project.subsystemCount !== 1 ? 's' : ''}
              </Badge>
              <Badge variant="default" className="text-xs">
                {project.ioCount} IO{project.ioCount !== 1 ? 's' : ''}
              </Badge>
            </div>
            
            {project.subsystemNames.length > 0 && (
              <p className="text-xs sm:text-sm text-muted-foreground">
                Subsystems: {project.subsystemNames.join(', ')}
              </p>
            )}
          </CardContent>
          
          <CardFooter className="flex flex-col gap-2 pt-3">
                <div className="flex gap-2 w-full">
                  <Link href={`/project/${project.id}`} className="flex-1">
                    <Button variant="default" className="w-full" size="sm">
                      <Eye className="mr-2 h-4 w-4" />
                      Dashboard
                    </Button>
                  </Link>
                  
                  <Link href={`/commissioning/${project.id}`} className="flex-1">
                    <Button variant="secondary" className="w-full" size="sm">
                      <TestTube className="mr-2 h-4 w-4" />
                      Test
                    </Button>
                  </Link>
                </div>
            
            {project.subsystemCount > 0 && (
              <Button 
                variant="outline" 
                className="w-full" 
                size="sm"
                onClick={() => handleViewSubsystems(project)}
              >
                <Settings className="mr-2 h-4 w-4" />
                <span className="hidden sm:inline">View Subsystem IDs</span>
                <span className="sm:hidden">Subsystems</span>
              </Button>
            )}
          </CardFooter>
        </Card>
      ))}
    </div>

    {selectedProject && (
      <SubsystemDialog
        open={showSubsystemDialog}
        onOpenChange={setShowSubsystemDialog}
        projectName={selectedProject.name}
        subsystems={selectedProject.subsystems.map(s => ({
          id: s.id,
          name: s.name || `Subsystem ${s.id}`
        }))}
      />
    )}
  </>
  )
}

