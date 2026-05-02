import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import type { ReactZoomPanPinchContentRef } from 'react-zoom-pan-pinch'
import type { Device, DeviceState } from '@/lib/guided/types'
import './guided-mode.css'

interface Props {
  /** Raw SVG markup loaded from /api/maps/subsystem/:id */
  svgMarkup: string
  /** Devices in SVG order with computed state. */
  devices: Device[]
  /**
   * The device the operator is focused on RIGHT NOW (orange glow).
   * Equals selectedDevice when one is chosen, else falls back to the
   * algorithm's recommendation. There is no separate "selected" highlight
   * — keeping a single source of focus on the map prevents
   * blue-ring-on-amber-fill visual clashes and matches operator intent:
   * the glowing device is the one whose IOs the panel is showing.
   */
  activeDevice: Device | null
  /** Called when an interactive device is clicked. */
  onDeviceClick: (deviceName: string) => void
}

export interface GuidedTestingMapHandle {
  centerOnDevice: (deviceName: string) => void
}

const STATE_FILL: Record<DeviceState, { fill: string; stroke: string }> = {
  passed:      { fill: '#4ade80', stroke: '#166534' },
  failed:      { fill: '#f87171', stroke: '#991b1b' },
  in_progress: { fill: '#fcd34d', stroke: '#92400e' },
  skipped:     { fill: '#cbd5e1', stroke: '#64748b' },
  untested:    { fill: '#e2e8f0', stroke: '#475569' },
  no_ios:      { fill: '#f1f5f9', stroke: '#cbd5e1' },
}

/**
 * Renders the SCADA SVG inside a pan/zoom canvas. State colors are
 * applied directly as fill/stroke attributes on each device's <rect>
 * because the SVG ships with explicit `fill="#ffffff"` attributes that
 * tie author-CSS specificity (especially with :where()). Setting the
 * attribute removes the ambiguity entirely.
 *
 * The current-target glow is left to CSS — drop-shadow filters work
 * predictably and we want the pulsing animation.
 */
export const GuidedTestingMap = forwardRef<GuidedTestingMapHandle, Props>(function GuidedTestingMap(
  { svgMarkup, devices, activeDevice, onDeviceClick },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const transformRef = useRef<ReactZoomPanPinchContentRef | null>(null)
  const hasAutoCenteredRef = useRef(false)

  useImperativeHandle(
    ref,
    () => ({
      centerOnDevice(deviceName: string) {
        const root = containerRef.current
        const transform = transformRef.current
        if (!root || !transform) return
        const g = root.querySelector(`svg g[id="${CSS.escape(deviceName)}"]`)
        if (!g || !(g instanceof SVGGraphicsElement)) return
        // 1.6× zoom, 400ms ease-out is comfortable on tablet
        transform.zoomToElement(g as unknown as HTMLElement, 1.6, 400)
      },
    }),
    [],
  )

  // Apply state fill+stroke directly as SVG attributes (defeats inline fill="#fff").
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const stateByName = new Map(devices.map(d => [d.deviceName, d.state]))
    const groups = root.querySelectorAll<SVGGElement>('svg g[id]')
    groups.forEach(g => {
      const id = g.getAttribute('id')
      if (!id) return
      const state = stateByName.get(id) ?? 'no_ios'
      g.setAttribute('data-status', state)
      const colors = STATE_FILL[state]
      const shapes = g.querySelectorAll<SVGElement>(':scope > rect, :scope > path')
      shapes.forEach(shape => {
        shape.setAttribute('fill', colors.fill)
        shape.setAttribute('stroke', colors.stroke)
        shape.setAttribute('stroke-width', '1.5')
        if (state === 'skipped') {
          shape.setAttribute('stroke-dasharray', '4 3')
        } else {
          shape.removeAttribute('stroke-dasharray')
        }
        if (state === 'no_ios') {
          shape.setAttribute('opacity', '0.55')
        } else {
          shape.removeAttribute('opacity')
        }
      })
    })
  }, [svgMarkup, devices])

  // Mark the active device with data-current="true" — the single source of
  // focus highlight on the map.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    root.querySelectorAll('svg g[data-current]').forEach(g => g.removeAttribute('data-current'))
    if (activeDevice) {
      const g = root.querySelector(`svg g[id="${CSS.escape(activeDevice.deviceName)}"]`)
      g?.setAttribute('data-current', 'true')
    }
  }, [activeDevice])

  // Auto-center on the active device the first time we have both an SVG and a target.
  // Subsequent target changes leave the user's pan/zoom alone — they can hit "Recenter".
  useEffect(() => {
    if (hasAutoCenteredRef.current) return
    if (!svgMarkup || !activeDevice) return
    const root = containerRef.current
    const transform = transformRef.current
    if (!root || !transform) return
    const t = window.setTimeout(() => {
      const g = root.querySelector(`svg g[id="${CSS.escape(activeDevice.deviceName)}"]`)
      if (g instanceof SVGGraphicsElement) {
        transform.zoomToElement(g as unknown as HTMLElement, 1.6, 600)
        hasAutoCenteredRef.current = true
      }
    }, 120)
    return () => window.clearTimeout(t)
  }, [svgMarkup, activeDevice])

  // Click delegation — find the device <g> closest to the click target.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    function handleClick(e: Event) {
      const target = e.target as Element
      const group = target.closest('g[data-status]') as SVGGElement | null
      if (!group) return
      if (group.getAttribute('data-status') === 'no_ios') return
      const id = group.getAttribute('id')
      if (id) onDeviceClick(id)
    }
    root.addEventListener('click', handleClick)
    return () => root.removeEventListener('click', handleClick)
  }, [onDeviceClick])

  return (
    <TransformWrapper
      ref={transformRef}
      minScale={0.15}
      maxScale={8}
      initialScale={0.5}
      centerOnInit
      limitToBounds={false}
      doubleClick={{ disabled: false, mode: 'zoomIn', step: 0.7 }}
      wheel={{ step: 0.18, smoothStep: 0.005 }}
      panning={{ velocityDisabled: false, allowLeftClickPan: true }}
      pinch={{ step: 6 }}
    >
      <TransformComponent wrapperStyle={{ width: '100%', height: '100%' }}>
        <div
          ref={containerRef}
          className="guided-svg"
          /* Trusted source: bundled file we ship with the app. */
          dangerouslySetInnerHTML={{ __html: svgMarkup }}
        />
      </TransformComponent>
    </TransformWrapper>
  )
})
