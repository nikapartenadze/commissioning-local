import { useEffect, useRef } from 'react'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import type { Device } from '@/lib/guided/types'
import './guided-mode.css'

interface Props {
  /** Raw SVG markup loaded from /api/maps/subsystem/:id */
  svgMarkup: string
  /** Devices in SVG order with computed state. */
  devices: Device[]
  /** Device whose pulsing-blue outline is the recommended next, or null. */
  currentTarget: Device | null
  /** Called when an interactive device is clicked. */
  onDeviceClick: (deviceName: string) => void
}

/**
 * Renders the SCADA SVG full-screen with pan/zoom, then walks the live DOM
 * to set `data-status` (and `data-current` on the current target) on each
 * <g> matching a known device. Click delegation is on the container; we
 * inspect `event.target.closest('g[data-status]')` to find which device.
 */
export function GuidedTestingMap({ svgMarkup, devices, currentTarget, onDeviceClick }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  // After the SVG is in the DOM, stamp data-status on each <g> from the device list.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const stateByName = new Map(devices.map(d => [d.deviceName, d.state]))

    const groups = root.querySelectorAll<SVGGElement>('svg g[id]')
    groups.forEach(g => {
      const id = g.getAttribute('id')
      if (!id) return
      const state = stateByName.get(id)
      if (state) {
        g.setAttribute('data-status', state)
      } else {
        g.setAttribute('data-status', 'no_ios')
      }
    })
  }, [svgMarkup, devices])

  // Mark current target with data-current="true"
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    root.querySelectorAll('svg g[data-current]').forEach(g => g.removeAttribute('data-current'))
    if (currentTarget) {
      const g = root.querySelector(`svg g[id="${CSS.escape(currentTarget.deviceName)}"]`)
      g?.setAttribute('data-current', 'true')
    }
  }, [currentTarget])

  // Click delegation
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    function handleClick(e: Event) {
      const target = e.target as Element
      const group = target.closest('g[data-status]') as SVGGElement | null
      if (!group) return
      const status = group.getAttribute('data-status')
      if (status === 'no_ios') return
      const id = group.getAttribute('id')
      if (id) onDeviceClick(id)
    }
    root.addEventListener('click', handleClick)
    return () => root.removeEventListener('click', handleClick)
  }, [onDeviceClick])

  return (
    <div className="w-full h-full bg-slate-50 overflow-hidden">
      <TransformWrapper
        minScale={0.3}
        maxScale={4}
        initialScale={0.6}
        centerOnInit
        doubleClick={{ disabled: true }}
        wheel={{ step: 0.1 }}
      >
        <TransformComponent
          wrapperStyle={{ width: '100%', height: '100%' }}
          contentStyle={{ width: '100%', height: '100%' }}
        >
          <div
            ref={containerRef}
            className="guided-svg"
            // Trusted source: bundled file we ship; SVG content is from our own SCADA exports.
            dangerouslySetInnerHTML={{ __html: svgMarkup }}
          />
        </TransformComponent>
      </TransformWrapper>
    </div>
  )
}
