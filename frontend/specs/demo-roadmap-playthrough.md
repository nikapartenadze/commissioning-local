# Roadmap Guided Mode — Demo Playthrough

End-to-end script for the demo of the roadmap-driven Guided Mode feature.
Both repos must be on branch `feat/roadmap-guided-mode`.

## Prerequisites

- `commissioning-cloud` at `../commissioning-cloud/` on `feat/roadmap-guided-mode`
- `commissioning-local/frontend/` on `feat/roadmap-guided-mode`
- The cloud Postgres has the new `roadmaps` table. Run `npx prisma db push` from
  `commissioning-cloud/` against your dev database (NOT production). This is the
  only step that touches the database — every other commit is code-only.
- At least one MCM diagram is already uploaded for the demo project via
  `/admin/diagrams`. (The roadmap editor will refuse to load the canvas without
  one.)
- The local field tool's `config.json` points at the cloud's `remoteUrl`
  (`http://localhost:3003` for local dev) and has a matching `apiPassword`
  (= the project's `Project.apiKey` in the cloud DB).

## Bringing up the dev servers

Terminal A (cloud):

```bash
cd commissioning-cloud
npm run dev
# expect: server on http://localhost:3003
```

Terminal B (local field tool):

```bash
cd commissioning-local/frontend
npm run dev
# expect: Express on :3010, broadcast on :3112, PLC WS on :3012, Vite on 5173/5174
```

## Authoring a roadmap (cloud side)

1. Browser → `http://localhost:3003/admin/roadmaps`. Sign in as an admin.
2. Click **New roadmap**. Pick a project, an MCM that has a diagram already
   uploaded (e.g. `MCM09`), and a name (e.g. `Demo walkdown`). Submit.
3. You land in the editor at `/admin/roadmaps/<id>`. The SVG diagram for that
   MCM loads in the main pane.
4. With **Add Steps** mode active (default), click ≥3 devices on the SVG. Each
   click adds a step to the right panel with a default instruction.
5. For at least one step, pick a **Specific IO** from the dropdown in the right
   panel. This flips that step to `kind: 'io'` and the playback will gate on
   that single IO's Pass/Fail.
6. Edit two or three instruction texts so they read like real walkdown
   directions (e.g. "Go to EPC1_2 and pull the cord").
7. Switch the mode toolbar (bottom-left of canvas) to **Draw Path**. Click
   along the floor to lay waypoints between consecutive devices. Double-click
   to finish a segment. Draw at least two segments.
8. Click **Save**, then **Publish**. The status badge should flip to
   "Published".

## Playing the roadmap (local field tool)

1. Browser → `http://localhost:5174/commissioning/<subsystemId>/guided`,
   where `<subsystemId>` is a subsystem whose `Name` field matches the MCM
   you authored on (e.g. `MCM09`).
2. Open the top-right **FlowModeChip** ("Flow: SCADA order ▾"). Click
   **Roadmap**. The dropdown now contains the picker. Click **Pull from
   cloud** to fetch your published roadmap.
3. The roadmap list populates. Pick **Demo walkdown**.
4. Playback begins:
   - The map pans + zooms to step 1's device.
   - Every other device on the SVG dims and becomes non-clickable.
   - A banner at the bottom shows `STEP 1 OF N` and the instruction text.
   - Pass / Fail / Skip / End buttons are visible on the banner.
   - If the step is `kind: 'io'`, the targeted IO name is shown.
   - The drawn path overlays the SVG with arrows; the leg ending at the
     current step is highlighted with an animated dashed stroke.
5. Click **Pass** (or **Fail**). The banner content swaps to step 2, the
   map pans, the lock state moves with the target.
6. Continue through all steps. At the end, the banner shows
   "Roadmap complete · X passed · Y failed · Z skipped". Click **Close** to
   end and return to free SCADA-order flow.

## Verifying zero regressions

- Switch the FlowModeChip back to "SCADA document order" → existing behavior
  works exactly as before.
- Navigate to `/commissioning/<subsystemId>` (manual grid) → unchanged.
- Visit `/admin/diagrams` on the cloud → unchanged.

## Known limitations (out of demo scope)

- Pass/Fail buttons on the banner only update React state, not the IO
  results in the database. The auto-advance currently watches the existing
  `Ios.Result` aggregates, which means a step only advances if you ALSO
  mark the relevant IO Pass/Fail via the existing IO drawer (or the local
  database has results pre-populated). For a clean demo, pre-mark relevant
  IOs as untested via the manual grid before starting playback.
- Real PLC tag-trigger auto-advance is not wired in this demo. The
  predecessor doc `frontend/specs/2026-05-15-guided-mode-status-and-phase2.md`
  tracks the four production gaps still in flight.
- Multi-MCM roadmaps are not supported. One MCM per roadmap.
