import { Link, useParams } from 'react-router-dom'
import { GuidedTaskRunner } from '@/components/guided/tasks/guided-task-runner'

/**
 * Guided Mode — the Task-Pool flow rendered on the live SVG map. This is the
 * single guided view (the old `?classic=1` device-walk fallback was removed
 * 2026-07-13; its dark cockpit canvas now lives in the runner itself).
 */
export default function Page() {
  const params = useParams()
  const raw = (params.id as string) ?? ''
  const subsystemId = raw === '_' ? 0 : parseInt(raw, 10)

  if (!subsystemId || Number.isNaN(subsystemId)) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div>Guided mode needs a subsystem — open it from a commissioning page.</div>
        <Link to="/">Back to the tool</Link>
      </div>
    )
  }
  return <GuidedTaskRunner subsystemId={subsystemId} />
}
