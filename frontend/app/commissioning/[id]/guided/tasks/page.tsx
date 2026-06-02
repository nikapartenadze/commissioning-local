import { useParams } from 'react-router-dom'
import { GuidedTaskRunner } from '@/components/guided/tasks/guided-task-runner'

/**
 * Guided-Mode Task Pool runner page. Route: /commissioning/:id/guided/tasks
 * Delivers prioritised commissioning tasks one Step at a time.
 */
export default function Page() {
  const params = useParams()
  const raw = (params.id as string) ?? ''
  const subsystemId = raw === '_' ? 0 : parseInt(raw, 10)

  if (!subsystemId || Number.isNaN(subsystemId)) {
    return (
      <div className="gt-root gt-center">
        <div className="gt-empty">No subsystem configured for guided tasks.</div>
      </div>
    )
  }
  return <GuidedTaskRunner subsystemId={subsystemId} />
}
