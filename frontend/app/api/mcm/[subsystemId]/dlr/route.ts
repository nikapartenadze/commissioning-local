import { Request, Response } from 'express'
import { getMcmNetworkSnapshots } from '@/lib/mcm-registry'
import { configService } from '@/lib/config'
import { db } from '@/lib/db-sqlite'
import { deriveAoiBase, decodeDlrAoi } from '@/lib/plc/network/dlr-aoi'
import { readDlrAoiForMcm } from '@/lib/plc/network/dlr-aoi-reader'

/**
 * GET /api/mcm/:subsystemId/dlr
 *
 * On-demand DLR ring verdict for one MCM, read from the PLC's own
 * `AOI_RACK_NETWORK_NODE` controller tags. Read-only, no polling, no writes —
 * the AOI already self-polls the CIP DLR object every 500 ms.
 *
 * ALWAYS RESPONDS 200. The Network page calls this; a 500 here would break a
 * page whose other panels are fine. Every failure is a 200 with
 * `{ ok: false, reason }` so the UI can render an honest "why" instead of an
 * error boundary. This is a hard requirement, not a style preference.
 *
 * The AOI base is resolved at RUNTIME from the network poller's discovered
 * device tags (the same @tags-browse discovery the poller uses — see
 * lib/plc/network/poller.ts), never from a config list. A site that renames or
 * re-slots its Ethernet module therefore needs no config edit.
 */
export async function GET(req: Request, res: Response) {
  const subsystemId = String(req.params.subsystemId)

  try {
    // MCM name: config is authoritative (it is what the connection runs as);
    // the Subsystems row is the fallback for a box whose config predates the
    // MCM entry. The name is the prefix of every AOI tag path.
    let mcmName = ''
    try {
      const cfg = await configService.getMcm(subsystemId)
      mcmName = cfg?.name?.trim() ?? ''
    } catch {
      /* fall through to the DB */
    }
    if (!mcmName) {
      try {
        const row = db
          .prepare('SELECT Name FROM Subsystems WHERE id = ?')
          .get(parseInt(subsystemId, 10) || 0) as { Name?: string } | undefined
        mcmName = row?.Name?.trim() ?? ''
      } catch {
        /* leave blank — handled below */
      }
    }

    // Runtime discovery: the poller's latest snapshots carry both the raw tag
    // name it browsed and the suffix-stripped device name. Feed both, so the
    // match works whichever form a site's naming produces.
    const snapshots = getMcmNetworkSnapshots(subsystemId) ?? []
    const deviceNames: string[] = []
    for (const s of snapshots) {
      if (s?.deviceName) deviceNames.push(s.deviceName)
      if (s?.tagName) deviceNames.push(s.tagName)
    }

    const base = mcmName ? deriveAoiBase(deviceNames, mcmName) : null
    if (!base) {
      return res.json({
        ok: false,
        reason:
          'No rack Ethernet module (SLOTn_EN2TR/EN4TR) found for this MCM — cannot locate the DLR AOI tags.',
      })
    }

    const read = await readDlrAoiForMcm(subsystemId, base)
    if (!read.ok || !read.reading) {
      return res.json({
        ok: false,
        base,
        reason: read.reason || 'Could not read the DLR AOI tags.',
      })
    }

    const reading = read.reading
    return res.json({
      ok: true,
      base,
      reading: {
        breakPresent: reading.breakPresent,
        communicationFaulted: reading.communicationFaulted,
        point1: reading.point1,
        point2: reading.point2,
      },
      verdict: decodeDlrAoi(reading),
    })
  } catch (error) {
    // Belt and braces: even an unexpected throw stays a 200. See the header.
    return res.json({
      ok: false,
      reason: error instanceof Error ? error.message : 'Internal error reading DLR status.',
    })
  }
}
