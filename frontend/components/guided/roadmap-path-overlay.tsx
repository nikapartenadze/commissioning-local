import { useEffect, useState } from 'react'
import type { RoadmapPath } from '@/lib/guided/roadmap-types'

interface Props {
  path: RoadmapPath | null
  currentStepIndex: number
  containerRef: React.RefObject<HTMLElement>
}

/**
 * Renders the roadmap's drawn segments as SVG arrows on top of the diagram.
 * The active segment (toStep === currentStep) gets an animated dashed stroke;
 * earlier segments fade to faint gray; later segments are hidden.
 */
export function RoadmapPathOverlay({ path, currentStepIndex, containerRef }: Props) {
  const [viewBox, setViewBox] = useState<string | null>(null)
  useEffect(() => {
    const svg = containerRef.current?.querySelector('svg') as SVGSVGElement | null
    if (!svg) return
    setViewBox(svg.getAttribute('viewBox'))
  }, [containerRef])

  if (!viewBox || !path || path.segments.length === 0) return null

  return (
    <svg className="gm-roadmap-path-overlay" viewBox={viewBox} preserveAspectRatio="xMidYMid meet"
         style={{ position: 'absolute', inset: 0, pointerEvents: 'none', width: '100%', height: '100%' }}>
      <defs>
        <marker id="gm-arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#2563eb" />
        </marker>
        <marker id="gm-arrow-faint" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" />
        </marker>
      </defs>
      {path.segments.map((seg, i) => {
        const isActive = seg.toStep === currentStepIndex + 1
        const isPast = seg.toStep != null && seg.toStep <= currentStepIndex
        const isFuture = seg.toStep != null && seg.toStep > currentStepIndex + 1
        if (isFuture) return null
        const d = seg.points.map((p, j) => `${j === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
        return (
          <path key={i} d={d} fill="none"
                stroke={isActive ? '#2563eb' : '#94a3b8'}
                strokeWidth={isActive ? 3 : 1.5}
                strokeDasharray={isActive ? '8 6' : undefined}
                markerEnd={`url(#gm-arrow-${isActive ? 'active' : 'faint'})`}
                style={{ opacity: isPast ? 0.55 : 1, animation: isActive ? 'gm-dash 1.2s linear infinite' : undefined }} />
        )
      })}
    </svg>
  )
}
