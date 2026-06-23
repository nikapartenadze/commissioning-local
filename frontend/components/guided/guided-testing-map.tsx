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
  /** When non-null and non-empty, every device id NOT in this set gets
   *  data-roadmap-locked="true". CSS dims and disables pointer events on
   *  locked devices. Used by roadmap-driven flow mode. */
  lockedDevices?: Set<string> | null
  /** Devices currently flagged as faulted by the PLC tag reader
   *  (<deviceName>:I.ConnectionFaulted = TRUE). Stamps data-faulted="true"
   *  on the SVG element so CSS can grey/hatch the shape. */
  faultedDevices?: Set<string>
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
  { svgMarkup, devices, activeDevice, onDeviceClick, lockedDevices, faultedDevices },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const transformRef = useRef<ReactZoomPanPinchContentRef | null>(null)
  const hasAutoCenteredRef = useRef(false)

  /**
   * Selectors used everywhere we iterate device elements. Both <g> groups
   * (composite devices like VFD/FIOM) and flat <path> elements (photoeyes,
   * beacons, pushbuttons, EPCs in the Inkscape export) carry device ids.
   */
  const DEVICE_SELECTOR = 'svg g[id], svg path[id]'
  const STATUS_SELECTOR = 'svg g[data-status], svg path[data-status]'

  function findDeviceElement(root: HTMLElement, deviceName: string): Element | null {
    return root.querySelector(`svg [id="${CSS.escape(deviceName)}"]`)
  }

  useImperativeHandle(
    ref,
    () => ({
      centerOnDevice(deviceName: string) {
        const root = containerRef.current
        const transform = transformRef.current
        if (!root || !transform) return
        const el = findDeviceElement(root, deviceName)
        if (!el || !(el instanceof SVGGraphicsElement)) return
        // 1.6× zoom, 400ms ease-out is comfortable on tablet
        transform.zoomToElement(el as unknown as HTMLElement, 1.6, 400)
      },
    }),
    [],
  )

  // Apply state fill+stroke directly as SVG attributes (defeats inline fill="#fff").
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const stateByName = new Map(devices.map(d => [d.deviceName, d.state]))
    const els = root.querySelectorAll<SVGElement>(DEVICE_SELECTOR)
    els.forEach(el => {
      const id = el.getAttribute('id')
      if (!id) return
      const state = stateByName.get(id) ?? 'no_ios'
      el.setAttribute('data-status', state)
      const colors = STATE_FILL[state]
      // Recolor EVERY descendant shape of a device group, not just direct
      // children: the engineered SCADA export nests a device's icon shapes
      // inside sub-<g> elements (and uses <polyline>/<line> for conveyor
      // runs), so the old ":scope > shape" selector painted nothing on the
      // real layout. Scope each shape to its OWNING device via
      // closest('[id]') so a (rare) nested identified device isn't repainted
      // by its parent. A bare <path>/<polyline> device colors itself.
      const SHAPE_SEL = 'rect, path, polygon, circle, ellipse, polyline, line'
      const shapes: SVGElement[] = el.tagName.toLowerCase() === 'g'
        ? Array.from(el.querySelectorAll<SVGElement>(SHAPE_SEL)).filter(
            shape => shape.closest('[id]') === el,
          )
        : [el]
      shapes.forEach(shape => {
        // Stash the source fill on the first pass so state transitions can
        // honor it forever — without this we'd overwrite "none" to a real
        // color and lose the signal that this shape is an open line.
        if (!shape.hasAttribute('data-orig-fill')) {
          shape.setAttribute('data-orig-fill', shape.getAttribute('fill') ?? '')
        }
        // Conveyor polylines, EPC cables and other open paths are authored
        // with fill="none" deliberately. Filling them closes the curve into a
        // blob — keep them unfilled and only restroke. Closed shapes
        // (rect/circle/ellipse/polygon, filled paths) take the state fill.
        const keepNoFill = shape.getAttribute('data-orig-fill') === 'none'
        shape.setAttribute('fill', keepNoFill ? 'none' : colors.fill)
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

  // Stamp data-faulted on every device the PLC tag reader has flagged as
  // ConnectionFaulted. CSS turns those into a hatched grey shape so the
  // operator can see at a glance which devices are unreachable.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    root.querySelectorAll('svg [data-faulted]').forEach(el => el.removeAttribute('data-faulted'))
    if (!faultedDevices || faultedDevices.size === 0) return
    root.querySelectorAll<SVGElement>('svg g[id], svg path[id]').forEach(el => {
      const id = el.getAttribute('id')
      if (id && faultedDevices.has(id)) {
        el.setAttribute('data-faulted', 'true')
      }
    })
  }, [faultedDevices, svgMarkup, devices])

  // Mark the active device with data-current="true" — the single source of
  // focus highlight on the map.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    root.querySelectorAll('svg [data-current]').forEach(el => el.removeAttribute('data-current'))
    if (activeDevice) {
      const el = findDeviceElement(root, activeDevice.deviceName)
      el?.setAttribute('data-current', 'true')
    }
  }, [activeDevice])

  // Stamp data-roadmap-locked on every device outside the allow-set so CSS can
  // dim and disable pointer events on non-target devices during roadmap playback.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const svgRoot = root.querySelector('svg')
    if (!svgRoot) return

    // Clear stale locks across both <g> and <path> device elements
    svgRoot.querySelectorAll<SVGElement>('g[id], path[id]').forEach(el => {
      el.removeAttribute('data-roadmap-locked')
    })

    if (!lockedDevices || lockedDevices.size === 0) return

    // Stamp lock on every device that's not in the allow-set
    svgRoot.querySelectorAll<SVGElement>('g[id], path[id]').forEach(el => {
      const id = el.getAttribute('id')
      if (!id) return
      if (!lockedDevices.has(id)) {
        el.setAttribute('data-roadmap-locked', 'true')
      }
    })
  }, [lockedDevices, svgMarkup])

  // Auto-center on the active device the first time we have both an SVG and a target.
  useEffect(() => {
    if (hasAutoCenteredRef.current) return
    if (!svgMarkup || !activeDevice) return
    const root = containerRef.current
    const transform = transformRef.current
    if (!root || !transform) return
    const t = window.setTimeout(() => {
      const el = findDeviceElement(root, activeDevice.deviceName)
      if (el instanceof SVGGraphicsElement) {
        transform.zoomToElement(el as unknown as HTMLElement, 1.6, 600)
        hasAutoCenteredRef.current = true
      }
    }, 120)
    return () => window.clearTimeout(t)
  }, [svgMarkup, activeDevice])

  // Click delegation — find the closest device element to the click target.
  // <g> devices contain children, so we use closest(); <path> devices ARE
  // the leaf, so closest() returns them directly. no_ios devices are also
  // clickable: the panel surfaces a "No IOs configured" state so the
  // operator gets feedback instead of a silent no-op (the visual map
  // shows photoeyes that don't have their own DB rows yet).
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    function handleClick(e: Event) {
      const target = e.target as Element
      const el = target.closest(STATUS_SELECTOR)
      if (!el) return
      const id = el.getAttribute('id')
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
