import { notFound } from "next/navigation"
import { Suspense } from "react"
import { ProjectDashboard } from "@/components/project-dashboard"
import { DataGridSkeleton } from "@/components/data-grid-skeleton"
import { getBackendUrl } from "@/lib/api-config"

export const dynamic = 'force-dynamic'
export const revalidate = 60 // Cache for 60 seconds

async function getProjectWithIos(projectId: number) {
  console.time(`Fetch project ${projectId} data`)
  
  try {
    // For now, we'll simulate different data for different projects
    // In a real implementation, you'd have project-specific API endpoints
    
    // Mock project data based on project ID
    const projectData = {
      1: { name: "Carlsbad", subsystemCount: 3, ioCount: 3408, subsystemNames: ["PS1", "PS2", "SSF"] },
      2: { name: "Chattanooga", subsystemCount: 1, ioCount: 703, subsystemNames: ["ADP"] },
      4: { name: "NorthPortland", subsystemCount: 1, ioCount: 392, subsystemNames: ["ULEX"] },
      5: { name: "MTN6", subsystemCount: 7, ioCount: 12618, subsystemNames: ["MCM01", "MCM07", "MCM02", "MCM03", "MCM04", "MCM05", "MCM06"] },
      6: { name: "Test", subsystemCount: 1, ioCount: 3, subsystemNames: ["Test"], subsystemId: 16 },
      7: { name: "GrandeVista", subsystemCount: 1, ioCount: 40, subsystemNames: ["NORTH"] },
      8: { name: "SAT9", subsystemCount: 5, ioCount: 3767, subsystemNames: ["MCM01", "MCM02", "MCM03", "MCM04", "MCM05"] },
      9: { name: "CNO8", subsystemCount: 5, ioCount: 3436, subsystemNames: ["MCM01", "MCM02", "MCM03", "MCM04", "MCM05"] }
    }
    
    const project = projectData[projectId as keyof typeof projectData]
    
    if (!project) {
      console.timeEnd(`Fetch project ${projectId} data`)
      return null
    }
    
    // For Test project (ID 6), fetch real data from C# backend
    if (projectId === 6) {
      const response = await fetch(`${getBackendUrl()}/api/ios`, {
        cache: 'no-store'
      })
      
      if (response.ok) {
        const ios = await response.json()
        
        // Transform IOs to match expected format
        const iosWithSubsystem = ios.map((io: any) => ({
          id: io.id,
          name: io.name,
          description: io.description,
          result: io.result,
          timestamp: io.timestamp,
          comments: io.comments,
          order: io.order,
          subsystemName: `Subsystem Test`,
          subsystemId: 16
        }))

        console.timeEnd(`Fetch project ${projectId} data`)

        return {
          project: {
            id: projectId,
            name: project.name
          },
          ios: iosWithSubsystem,
          subsystems: [{
            id: 16,
            name: "Test"
          }]
        }
      }
    }
    
    // For other projects, generate mock IO data based on project characteristics
    const mockIos = generateMockIosForProject(projectId, project)
    
    console.timeEnd(`Fetch project ${projectId} data`)

    return {
      project: {
        id: projectId,
        name: project.name
      },
      ios: mockIos,
      subsystems: project.subsystemNames.map((name, index) => ({
        id: projectId * 10 + index + 1,
        name: name
      }))
    }
  } catch (error) {
    console.error('Failed to fetch data from C# backend:', error)
  }
  
  console.timeEnd(`Fetch project ${projectId} data`)
  return null
}

// Generate mock IO data for projects (except Test)
function generateMockIosForProject(projectId: number, project: any) {
  const ios = []
  const ioCount = project.ioCount // Use the actual IO count from project data
  
  for (let i = 1; i <= ioCount; i++) {
    const isInput = Math.random() > 0.3 // 70% inputs, 30% outputs
    const ioType = isInput ? 'I' : 'O'
    const tagName = `${project.name.toUpperCase()}_${ioType}_${i.toString().padStart(4, '0')}`
    
    ios.push({
      id: projectId * 10000 + i,
      name: tagName,
      description: `${isInput ? 'Input' : 'Output'} point ${i} for ${project.name}`,
      result: null, // No testing data - just IO data
      timestamp: null, // No testing timestamps
      comments: null, // No testing comments
      order: i,
      subsystemName: project.subsystemNames[Math.floor(Math.random() * project.subsystemNames.length)],
      subsystemId: projectId * 10 + Math.floor(Math.random() * project.subsystemNames.length) + 1
    })
  }
  
  return ios
}

export default async function ProjectPage({ params }: { params: { id: string } }) {
  const projectId = parseInt(params.id)
  
  if (isNaN(projectId)) {
    notFound()
  }

  const data = await getProjectWithIos(projectId)

  if (!data) {
    notFound()
  }

  return (
    <Suspense fallback={<DataGridSkeleton />}>
      <ProjectDashboard 
        project={data.project}
        ios={data.ios}
        subsystems={data.subsystems}
      />
    </Suspense>
  )
}

