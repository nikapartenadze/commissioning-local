import { NextRequest, NextResponse } from 'next/server'
import { Socket } from 'net'

export async function POST(request: NextRequest) {
  try {
    const { ip, port = 44818 } = await request.json()
    
    console.log(`🔍 Testing Ethernet/IP connection to ${ip}:${port}`)
    
    // Test actual Ethernet/IP connection to PLC
    const result = await testEthernetIpConnection(ip, port)
    
    if (result.success) {
      return NextResponse.json({ 
        success: true, 
        message: `✅ PLC Ethernet/IP connection successful to ${ip}:${port}`,
        connected: true,
        details: result.details
      })
    } else {
      return NextResponse.json({ 
        success: false, 
        message: `❌ PLC Ethernet/IP connection failed to ${ip}:${port}`,
        connected: false,
        error: result.error
      })
    }
  } catch (error) {
    console.error('Ethernet/IP connection test failed:', error)
    return NextResponse.json(
      { success: false, error: 'Ethernet/IP connection test failed', connected: false },
      { status: 500 }
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
    }, 10000) // 10 second timeout for Ethernet/IP
    
    socket.connect(port, ip, () => {
      if (!isResolved) {
        isResolved = true
        clearTimeout(timeout)
        
        // Send Ethernet/IP List Identity Request
        const listIdentityRequest = Buffer.from([
          0x63, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
        ])
        
        socket.write(listIdentityRequest)
        
        // Wait for response
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
            
            // Check if we got a valid Ethernet/IP response
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
