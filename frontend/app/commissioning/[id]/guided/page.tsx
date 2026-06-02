import { useParams, useSearchParams } from 'react-router-dom'
import { GuidedModePage } from '@/components/guided/guided-mode-page'
import { GuidedTaskRunner } from '@/components/guided/tasks/guided-task-runner'

/**
 * Guided Mode. By default this is the Task-Pool flow rendered on the live SVG
 * map (the Guided Mode spec). `?classic=1` falls back to the original
 * device-walk guided view, and "Exit" always returns to the full
 * commissioning tool — so no existing functionality is lost.
 */
export default function Page() {
  const params = useParams()
  const [search] = useSearchParams()
  const raw = (params.id as string) ?? ''
  const subsystemId = raw === '_' ? 0 : parseInt(raw, 10)

  if (search.get('classic') === '1') {
    return <GuidedModePage />
  }
  if (!subsystemId || Number.isNaN(subsystemId)) {
    // No subsystem to drive a task pool — fall back to the classic view,
    // which renders its own "invalid subsystem" handling.
    return <GuidedModePage />
  }
  return <GuidedTaskRunner subsystemId={subsystemId} />
}
