import type { Roadmap } from '@/lib/guided/roadmap-types'

interface Props {
  roadmaps: Roadmap[]
  selectedRoadmapId: number | null
  onSelect: (id: number) => void
  onPull: () => void
  isPulling: boolean
}

export function RoadmapPicker({ roadmaps, selectedRoadmapId, onSelect, onPull, isPulling }: Props) {
  return (
    <div className="gm-roadmap-picker">
      <select value={selectedRoadmapId ?? ''} onChange={e => onSelect(parseInt(e.target.value, 10))}
              className="gm-roadmap-picker__select">
        <option value="" disabled>{roadmaps.length === 0 ? 'No roadmaps cached' : 'Pick a roadmap…'}</option>
        {roadmaps.map(r => <option key={r.id} value={r.id}>{r.name} ({r.stepsJson.length} steps)</option>)}
      </select>
      <button className="gm-roadmap-picker__pull" onClick={onPull} disabled={isPulling}>
        {isPulling ? 'Pulling…' : 'Pull from cloud'}
      </button>
    </div>
  )
}
