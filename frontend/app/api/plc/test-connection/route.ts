import { Request, Response } from 'express'
import { Socket } from 'net'

export async function POST(req: Request, res: Response) {
  try {
    const { ip, port = 44818 } = req.body

    console.log(`Testing Ethernet/IP connection to ${ip}:${port}`)

    const result = await testEthernetIpConnection(ip, port)

    if (result.success) {
      return res.json({
        success: true,
        message: `PLC Ethernet/IP connection successful to ${ip}:${port}`,
        connected: true,
        details: result.details
      })
    } else {
      return res.json({
        success: false,
        message: `PLC Ethernet/IP connection failed to ${ip}:${port}`,
        connected: false,
        error: result.error
      })
    }
  } catch (error) {
    console.error('Ethernet/IP connection test failed:', error)
    return res.status(500).json(
      { success: false, error: 'Ethernet/IP connection test failed', connected: false }
    )
  }
}

function testEthernetIpConnection(ip: string, port: number): Promise<{success: boolean, error?: string, details?: string}> {
  return new Promise((resolve) => {
    const socket = new Socket()
    let isResolved = false

    const timeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true
        socket.destroy()
        resolve({ success: false, error: 'Connection timeout after 10 seconds' })
      }
    }, 10000)

    socket.connect(port, ip, () => {
      if (!isResolved) {
        isResolved = true
        clearTimeout(timeout)

        const listIdentityRequest = Buffer.from([
          0x63, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
        ])

        socket.write(listIdentityRequest)

        const responseTimeout = setTimeout(() => {
          if (!isResolved) {
            isResolved = true
            socket.destroy()
            resolve({ success: false, error: 'No Ethernet/IP response received' })
          }
        }, 3000)

        socket.once('data', (data) => {
          if (!isResolved) {
            isResolved = true
            clearTimeout(responseTimeout)
            socket.destroy()

            if (data.length > 0) {
              resolve({
                success: true,
                details: `Ethernet/IP device responded (${data.length} bytes)`
              })
            } else {
              resolve({ success: false, error: 'Empty response from device' })
            }
          }
        })
      }
    })

    socket.on('error', (err) => {
      if (!isResolved) {
        isResolved = true
        clearTimeout(timeout)
        socket.destroy()
        resolve({ success: false, error: `Connection error: ${err.message}` })
      }
    })
  })
}
