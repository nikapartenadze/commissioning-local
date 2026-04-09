import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

export async function GET(req: Request, res: Response) {
  try {
    const subsystemId = req.query.subsystemId as string | undefined

    if (!subsystemId) {
      return res.json({ success: true, rings: [] })
    }

    const rawRings = db.prepare('SELECT * FROM NetworkRings WHERE SubsystemId = ?').all(parseInt(subsystemId, 10)) as any[]

    const rings = rawRings.map(ring => {
      const rawNodes = db.prepare('SELECT * FROM NetworkNodes WHERE RingId = ? ORDER BY Position').all(ring.id) as any[]
      const nodes = rawNodes.map(node => {
        const rawPorts = db.prepare('SELECT * FROM NetworkPorts WHERE NodeId = ? ORDER BY PortNumber').all(node.id) as any[]
        const ports = rawPorts.map(port => ({
          id: port.id, nodeId: port.NodeId, portNumber: port.PortNumber, cableLabel: port.CableLabel,
          deviceName: port.DeviceName, deviceType: port.DeviceType, deviceIp: port.DeviceIp,
          statusTag: port.StatusTag, parentPortId: port.ParentPortId,
        }))
        return {
          id: node.id, ringId: node.RingId, name: node.Name, position: node.Position,
          ipAddress: node.IpAddress, cableIn: node.CableIn, cableOut: node.CableOut,
          statusTag: node.StatusTag, totalPorts: node.TotalPorts, ports,
        }
      })
      return {
        id: ring.id, subsystemId: ring.SubsystemId, name: ring.Name, mcmName: ring.McmName,
        mcmIp: ring.McmIp, mcmTag: ring.McmTag, nodes,
      }
    })

    return res.json({ success: true, rings })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}
