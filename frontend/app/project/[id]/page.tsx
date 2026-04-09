"use client"

import { useParams, Navigate } from "react-router-dom"
import { Suspense, useState, useEffect } from "react"
import { ProjectDashboard } from "@/components/project-dashboard"
import { DataGridSkeleton } from "@/components/data-grid-skeleton"

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

function getProjectWithIos(projectId: number) {
  // Mock project data based on project ID
  const projectData: Record<number, any> = {
    1: { name: "Carlsbad", subsystemCount: 3, ioCount: 3408, subsystemNames: ["PS1", "PS2", "SSF"] },
    2: { name: "Chattanooga", subsystemCount: 1, ioCount: 703, subsystemNames: ["ADP"] },
    4: { name: "NorthPortland", subsystemCount: 1, ioCount: 392, subsystemNames: ["ULEX"] },
    5: { name: "MTN6", subsystemCount: 7, ioCount: 12618, subsystemNames: ["MCM01", "MCM07", "MCM02", "MCM03", "MCM04", "MCM05", "MCM06"] },
    6: { name: "Test", subsystemCount: 1, ioCount: 3, subsystemNames: ["Test"], subsystemId: 16 },
    7: { name: "GrandeVista", subsystemCount: 1, ioCount: 40, subsystemNames: ["NORTH"] },
    8: { name: "SAT9", subsystemCount: 5, ioCount: 3767, subsystemNames: ["MCM01", "MCM02", "MCM03", "MCM04", "MCM05"] },
    9: { name: "CNO8", subsystemCount: 5, ioCount: 3436, subsystemNames: ["MCM01", "MCM02", "MCM03", "MCM04", "MCM05"] }
  }

  const project = projectData[projectId]

  if (!project) {
    return null
  }

  const mockIos = generateMockIosForProject(projectId, project)

  return {
    project: {
      id: projectId,
      name: project.name
    },
    ios: mockIos,
    subsystems: project.subsystemNames.map((name: string, index: number) => ({
      id: projectId * 10 + index + 1,
      name: name
    }))
  }
}

export default function ProjectPage() {
  const params = useParams()
  const projectId = parseInt(params.id as string)

  if (isNaN(projectId)) {
    return <Navigate to="/" replace />
  }

  const data = getProjectWithIos(projectId)

  if (!data) {
    return <Navigate to="/" replace />
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
