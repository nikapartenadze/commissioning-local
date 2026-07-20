<#
.SYNOPSIS
  Field DLR ring check. Read-only. Zero dependencies.

.DESCRIPTION
  Speaks EtherNet/IP + CIP directly over a TCP socket (port 44818) using only
  .NET sockets — no Node, no plctag.dll, no PowerShell modules, no install.
  Copy this one file to any site laptop and run it.

  For each gateway IP it:
    1. Scans the chassis backplane for modules (Identity object 0x01)
    2. Flags ring-capable Ethernet modules (EN2TR / EN4TR / dual-port)
    3. Reads the DLR object (0x47) — topology, network status, fault count,
       ring participants, and the two nodes bracketing any break
    4. Reads the Ethernet Link object (0xF6) per port — speed / duplex / link,
       which is the termination-quality check
    5. Cross-checks every supervisor: they must AGREE on the ring state

  ONLY Get_Attribute_Single (0x0E) requests are sent. Nothing is written to any
  device. Safe to run on a live production ring.

.PARAMETER Gateway
  One or more controller/module IPs. Every device in the DLR ring can be given;
  the script cross-checks that their ring verdicts agree.

.PARAMETER MaxSlot
  Highest backplane slot to scan (default 16).

.PARAMETER OutFile
  Optional path to also write a plain-text report for sharing.

.EXAMPLE
  .\Check-DlrRing.ps1 -Gateway 192.168.20.40

.EXAMPLE
  .\Check-DlrRing.ps1 -Gateway 192.168.1.10,192.168.1.11,192.168.1.12 -OutFile ring.txt
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string[]] $Gateway,
  [int] $MaxSlot = 16,
  [int] $TimeoutMs = 3000,
  [string] $OutFile
)

$ErrorActionPreference = 'Stop'
$script:Report = New-Object System.Collections.Generic.List[string]

function Say {
  param([string] $Text, [string] $Colour = 'Gray')
  Write-Host $Text -ForegroundColor $Colour
  $script:Report.Add($Text)
}

# ── EtherNet/IP transport ────────────────────────────────────────────────────

function Connect-Eip {
  param([string] $Ip, [int] $TimeoutMs)
  $client = New-Object System.Net.Sockets.TcpClient
  $async = $client.BeginConnect($Ip, 44818, $null, $null)
  if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) {
    try { $client.Close() } catch {}
    return $null
  }
  try { $client.EndConnect($async) } catch { try { $client.Close() } catch {}; return $null }
  $client.ReceiveTimeout = $TimeoutMs
  $client.SendTimeout = $TimeoutMs

  $stream = $client.GetStream()

  # RegisterSession: command 0x0065, 4 bytes of data (protocol version 1, flags 0)
  $req = New-Object byte[] 28
  $req[0] = 0x65; $req[1] = 0x00          # command
  $req[2] = 0x04; $req[3] = 0x00          # length
  $req[24] = 0x01                          # protocol version = 1
  $stream.Write($req, 0, $req.Length)

  $hdr = Read-Exact -Stream $stream -Count 24
  if ($null -eq $hdr) { try { $client.Close() } catch {}; return $null }
  $len = [BitConverter]::ToUInt16($hdr, 2)
  if ($len -gt 0) { [void](Read-Exact -Stream $stream -Count $len) }

  $session = [BitConverter]::ToUInt32($hdr, 4)
  return [pscustomobject]@{ Client = $client; Stream = $stream; Session = $session }
}

function Read-Exact {
  param($Stream, [int] $Count)
  $buf = New-Object byte[] $Count
  $got = 0
  while ($got -lt $Count) {
    try { $n = $Stream.Read($buf, $got, $Count - $got) } catch { return $null }
    if ($n -le 0) { return $null }
    $got += $n
  }
  return $buf
}

function Close-Eip {
  param($Conn)
  if ($null -eq $Conn) { return }
  try { $Conn.Client.Close() } catch {}
}

<#
  Send one CIP Get_Attribute_Single, routed across the backplane to a slot.
  Returns @{ Ok; Status; Data } — Status is the CIP general status (0 = success).
#>
function Invoke-CipGet {
  param($Conn, [int] $Port, [int] $Slot, [int] $Class, [int] $Instance, [int] $Attribute)

  # Embedded message: Get_Attribute_Single with a class/instance/attribute EPATH
  $embedded = [byte[]] @(0x0E, 0x03, 0x20, $Class, 0x24, $Instance, 0x30, $Attribute)

  # Unconnected Send (0x52) to the Connection Manager (class 6, instance 1)
  $cip = New-Object System.Collections.Generic.List[byte]
  $cip.Add(0x52); $cip.Add(0x02); $cip.Add(0x20); $cip.Add(0x06); $cip.Add(0x24); $cip.Add(0x01)
  $cip.Add(0x05)                                  # priority / tick time
  $cip.Add(0xF4)                                  # timeout ticks
  $cip.Add([byte]($embedded.Length -band 0xFF))   # embedded size (LE, 2 bytes)
  $cip.Add([byte](($embedded.Length -shr 8) -band 0xFF))
  $cip.AddRange($embedded)
  if ($embedded.Length % 2 -ne 0) { $cip.Add(0x00) }   # pad to even
  $cip.Add(0x01)                                  # route path size, in 16-bit words
  $cip.Add(0x00)                                  # reserved
  $cip.Add([byte]$Port)                           # backplane port (normally 1)
  $cip.Add([byte]$Slot)

  # SendRRData wrapper
  $data = New-Object System.Collections.Generic.List[byte]
  $data.AddRange([byte[]] @(0,0,0,0))             # interface handle
  $data.AddRange([byte[]] @(0x05, 0x00))          # timeout
  $data.AddRange([byte[]] @(0x02, 0x00))          # item count
  $data.AddRange([byte[]] @(0x00, 0x00, 0x00, 0x00))          # null address item
  $data.AddRange([byte[]] @(0xB2, 0x00))                      # unconnected data item
  $data.Add([byte]($cip.Count -band 0xFF)); $data.Add([byte](($cip.Count -shr 8) -band 0xFF))
  $data.AddRange($cip)

  $hdr = New-Object byte[] 24
  $hdr[0] = 0x6F; $hdr[1] = 0x00                                        # SendRRData
  $hdr[2] = [byte]($data.Count -band 0xFF); $hdr[3] = [byte](($data.Count -shr 8) -band 0xFF)
  [Array]::Copy([BitConverter]::GetBytes([uint32]$Conn.Session), 0, $hdr, 4, 4)

  $packet = New-Object byte[] ($hdr.Length + $data.Count)
  [Array]::Copy($hdr, 0, $packet, 0, $hdr.Length)
  [Array]::Copy($data.ToArray(), 0, $packet, $hdr.Length, $data.Count)

  try { $Conn.Stream.Write($packet, 0, $packet.Length) }
  catch { return @{ Ok = $false; Status = -1; Data = @(); Err = 'send failed' } }

  $rhdr = Read-Exact -Stream $Conn.Stream -Count 24
  if ($null -eq $rhdr) { return @{ Ok = $false; Status = -1; Data = @(); Err = 'no reply' } }
  $rlen = [BitConverter]::ToUInt16($rhdr, 2)
  if ($rlen -le 0) { return @{ Ok = $false; Status = -1; Data = @(); Err = 'empty reply' } }
  $body = Read-Exact -Stream $Conn.Stream -Count $rlen
  if ($null -eq $body) { return @{ Ok = $false; Status = -1; Data = @(); Err = 'short reply' } }

  # body: interface(4) timeout(2) itemcount(2) nulladdr(4) datahdr(4) then CIP reply
  $off = 4 + 2 + 2 + 4
  if ($body.Length -lt $off + 4) { return @{ Ok = $false; Status = -1; Data = @(); Err = 'truncated' } }
  $itemLen = [BitConverter]::ToUInt16($body, $off + 2)
  $cipOff = $off + 4
  if ($body.Length -lt $cipOff + 4) { return @{ Ok = $false; Status = -1; Data = @(); Err = 'truncated cip' } }

  $status = $body[$cipOff + 2]
  $extWords = $body[$cipOff + 3]
  $payloadOff = $cipOff + 4 + (2 * $extWords)
  $payloadLen = $cipOff + $itemLen - $payloadOff
  $payload = @()
  if ($payloadLen -gt 0 -and ($payloadOff + $payloadLen) -le $body.Length) {
    $payload = $body[$payloadOff..($payloadOff + $payloadLen - 1)]
  }
  return @{ Ok = $true; Status = $status; Data = $payload }
}

# ── decoding helpers ─────────────────────────────────────────────────────────

function Get-U16 { param($B) if ($B.Count -ge 2) { return [int]$B[0] -bor ([int]$B[1] -shl 8) } return $null }
function Get-U32 {
  param($B)
  if ($B.Count -ge 4) { return ([uint32]$B[0]) -bor ([uint32]$B[1] -shl 8) -bor ([uint32]$B[2] -shl 16) -bor ([uint32]$B[3] -shl 24) }
  return $null
}
function Get-ShortString {
  param($B)
  if ($B.Count -lt 1) { return '' }
  $n = [int]$B[0]
  if ($n -le 0 -or $B.Count -lt (1 + $n)) { return '' }
  return -join ($B[1..$n] | ForEach-Object { [char]$_ })
}
function Get-NodeIp {
  param($B)
  if ($B.Count -lt 4) { return $null }
  if (($B[0] -bor $B[1] -bor $B[2] -bor $B[3]) -eq 0) { return $null }
  return "$($B[0]).$($B[1]).$($B[2]).$($B[3])"
}

$NETWORK_STATUS = @('Normal', 'Ring Fault', 'Unexpected Loop Detected',
                    'Partial Network Fault', 'Rapid Fault/Restore Cycle')

# ── main ─────────────────────────────────────────────────────────────────────

Say ""
Say "=============================================================" 'Cyan'
Say " DLR RING CHECK - read-only (Get_Attribute_Single only)"      'Cyan'
Say " $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  host $env:COMPUTERNAME" 'Cyan'
Say "=============================================================" 'Cyan'

$supervisors = New-Object System.Collections.Generic.List[object]

foreach ($gw in $Gateway) {
  Say ""
  Say "### Gateway $gw" 'White'

  $conn = Connect-Eip -Ip $gw -TimeoutMs $TimeoutMs
  if ($null -eq $conn) {
    Say "    UNREACHABLE - no EtherNet/IP session on port 44818" 'Red'
    continue
  }

  try {
    Say "    session established"
    Say ""
    Say "    SLOT  MODULE                             SERIAL      PORTS  RING?"
    Say "    ---------------------------------------------------------------------"

    for ($slot = 0; $slot -le $MaxSlot; $slot++) {
      $nameR = Invoke-CipGet -Conn $conn -Port 1 -Slot $slot -Class 0x01 -Instance 1 -Attribute 7
      if (-not $nameR.Ok -or $nameR.Status -ne 0) { continue }
      $name = Get-ShortString $nameR.Data
      if ([string]::IsNullOrWhiteSpace($name)) { continue }

      $serR = Invoke-CipGet -Conn $conn -Port 1 -Slot $slot -Class 0x01 -Instance 1 -Attribute 6
      $serial = '?'
      if ($serR.Ok -and $serR.Status -eq 0) {
        $s = Get-U32 $serR.Data
        if ($null -ne $s) { $serial = '0x' + $s.ToString('x8') }
      }

      # Count Ethernet Link instances = physical ports. 2+ means ring-capable.
      $ports = 0
      for ($inst = 1; $inst -le 4; $inst++) {
        $p = Invoke-CipGet -Conn $conn -Port 1 -Slot $slot -Class 0xF6 -Instance $inst -Attribute 1
        if ($p.Ok -and $p.Status -eq 0) { $ports++ } else { break }
      }

      # DLR object present?
      $dlrProbe = Invoke-CipGet -Conn $conn -Port 1 -Slot $slot -Class 0x47 -Instance 1 -Attribute 1
      $hasDlr = ($dlrProbe.Ok -and $dlrProbe.Status -eq 0 -and $dlrProbe.Data.Count -ge 1)

      $ringCol = 'no'
      $colour = 'Gray'
      if ($hasDlr) { $ringCol = 'YES'; $colour = 'Green' }
      elseif ($ports -ge 2) { $ringCol = 'dual-port, no DLR'; $colour = 'Yellow' }

      $line = "    {0,-5} {1,-34} {2,-11} {3,-6} {4}" -f $slot, $name.Substring(0, [Math]::Min(34, $name.Length)), $serial, $ports, $ringCol
      Say $line $colour

      if ($hasDlr) {
        $supervisors.Add([pscustomobject]@{ Gateway = $gw; Slot = $slot; Name = $name; Conn = $conn })
      }
    }

    # ── DLR detail for each supervisor found on this gateway ────────────────
    foreach ($sup in ($supervisors | Where-Object { $_.Gateway -eq $gw })) {
      Say ""
      Say "    --- DLR object: slot $($sup.Slot) ($($sup.Name)) ---" 'White'

      $a1 = Invoke-CipGet -Conn $conn -Port 1 -Slot $sup.Slot -Class 0x47 -Instance 1 -Attribute 1
      $a2 = Invoke-CipGet -Conn $conn -Port 1 -Slot $sup.Slot -Class 0x47 -Instance 1 -Attribute 2
      $a3 = Invoke-CipGet -Conn $conn -Port 1 -Slot $sup.Slot -Class 0x47 -Instance 1 -Attribute 3
      $a5 = Invoke-CipGet -Conn $conn -Port 1 -Slot $sup.Slot -Class 0x47 -Instance 1 -Attribute 5
      $a8 = Invoke-CipGet -Conn $conn -Port 1 -Slot $sup.Slot -Class 0x47 -Instance 1 -Attribute 8
      $a6 = Invoke-CipGet -Conn $conn -Port 1 -Slot $sup.Slot -Class 0x47 -Instance 1 -Attribute 6
      $a7 = Invoke-CipGet -Conn $conn -Port 1 -Slot $sup.Slot -Class 0x47 -Instance 1 -Attribute 7
      # Attr 9 = ring participants LIST, Attr 10 = active supervisor address.
      # Supervisor-only attributes: a normal ring node answers 0x14 (not supported).
      $a9  = Invoke-CipGet -Conn $conn -Port 1 -Slot $sup.Slot -Class 0x47 -Instance 1 -Attribute 9
      $a10 = Invoke-CipGet -Conn $conn -Port 1 -Slot $sup.Slot -Class 0x47 -Instance 1 -Attribute 10

      $topology = $null; if ($a1.Ok -and $a1.Status -eq 0 -and $a1.Data.Count -ge 1) { $topology = [int]$a1.Data[0] }
      $netStat  = $null; if ($a2.Ok -and $a2.Status -eq 0 -and $a2.Data.Count -ge 1) { $netStat  = [int]$a2.Data[0] }
      $supStat  = $null; if ($a3.Ok -and $a3.Status -eq 0 -and $a3.Data.Count -ge 1) { $supStat  = [int]$a3.Data[0] }
      $faults   = $null; if ($a5.Ok -and $a5.Status -eq 0) { $faults = Get-U16 $a5.Data }
      $parts    = $null; if ($a8.Ok -and $a8.Status -eq 0) { $parts  = Get-U16 $a8.Data }
      $node1    = $null; if ($a6.Ok -and $a6.Status -eq 0) { $node1  = Get-NodeIp $a6.Data }
      $node2    = $null; if ($a7.Ok -and $a7.Status -eq 0) { $node2  = Get-NodeIp $a7.Data }
      $activeSup = $null; if ($a10.Ok -and $a10.Status -eq 0) { $activeSup = Get-NodeIp $a10.Data }

      # Participants list: repeating 10-byte records of 4-byte IP + 6-byte MAC.
      $members = New-Object System.Collections.Generic.List[string]
      if ($a9.Ok -and $a9.Status -eq 0 -and $a9.Data.Count -ge 10) {
        $d = $a9.Data
        $recs = [Math]::Floor($d.Count / 10)
        for ($r = 0; $r -lt $recs; $r++) {
          $o = $r * 10
          $ip = Get-NodeIp $d[$o..($o + 3)]
          $mac = (($d[($o + 4)..($o + 9)] | ForEach-Object { $_.ToString('x2') }) -join ':')
          if ($ip) { $members.Add("$ip  ($mac)") }
        }
      }

      $topoText = 'unread'
      if ($topology -eq 1) { $topoText = 'Ring' } elseif ($topology -eq 0) { $topoText = 'Linear' }
      $statText = 'unread'
      if ($null -ne $netStat) {
        if ($netStat -lt $NETWORK_STATUS.Count) { $statText = $NETWORK_STATUS[$netStat] } else { $statText = "Status $netStat" }
      }

      $supText = 'unread'
      if ($null -ne $supStat) {
        $SUP_STATUS = @('Backup Supervisor', 'ACTIVE Supervisor', 'Normal Ring Node',
                        'Non-DLR Topology', 'Cannot Support Parameters')
        if ($supStat -lt $SUP_STATUS.Count) { $supText = $SUP_STATUS[$supStat] } else { $supText = "Status $supStat" }
      }

      Say "      topology         : $topoText"
      Say "      network status   : $statText"
      Say "      this node's role : $supText"
      Say "      active supervisor: $(if ($null -eq $activeSup) { 'unread' } else { $activeSup })"
      Say "      fault count      : $(if ($null -eq $faults) { 'unread' } else { $faults })"
      Say "      ring participants: $(if ($null -eq $parts) { 'unread' } else { $parts })"
      Say "      last active node1: $(if ($null -eq $node1) { '-' } else { $node1 })"
      Say "      last active node2: $(if ($null -eq $node2) { '-' } else { $node2 })"

      if ($members.Count -gt 0) {
        Say ""
        Say "      RING MEMBERS (every node actually in the ring):" 'Cyan'
        $idx = 1
        foreach ($m in $members) { Say ("        {0,2}. {1}" -f $idx, $m); $idx++ }
        Say "      << compare this list against your subsystem list - any PLC"
        Say "         missing here is NOT in the ring."
      } elseif ($supStat -eq 2) {
        Say ""
        Say "      (member list not available - this node is a normal ring node,"
        Say "       not the supervisor. Point the script at the ACTIVE supervisor"
        Say "       above to enumerate ring members.)"
      }

      $verdict = 'UNKNOWN'; $vcol = 'Yellow'
      if ($topology -ne 1) {
        $verdict = "UNKNOWN - linear topology, not a DLR ring"
      } elseif ($netStat -eq 0) {
        $verdict = "HEALTHY - ring closed (Normal)"; $vcol = 'Green'
      } else {
        $verdict = "DEGRADED - $statText"; $vcol = 'Red'
        if ($node1 -and $node2) { $verdict += "  [break between $node1 and $node2]" }
      }
      Say "      => VERDICT       : $verdict" $vcol

      $sup | Add-Member -NotePropertyName Verdict -NotePropertyValue $verdict -Force
      $sup | Add-Member -NotePropertyName Participants -NotePropertyValue $parts -Force
      $sup | Add-Member -NotePropertyName Faults -NotePropertyValue $faults -Force

      # Per-port termination quality on the supervisor
      Say ""
      Say "      port terminations (Ethernet Link 0xF6):"
      for ($inst = 1; $inst -le 4; $inst++) {
        $sp = Invoke-CipGet -Conn $conn -Port 1 -Slot $sup.Slot -Class 0xF6 -Instance $inst -Attribute 1
        if (-not $sp.Ok -or $sp.Status -ne 0) { break }
        $fl = Invoke-CipGet -Conn $conn -Port 1 -Slot $sup.Slot -Class 0xF6 -Instance $inst -Attribute 2
        $speed = Get-U32 $sp.Data
        $flags = 0; if ($fl.Ok -and $fl.Status -eq 0) { $f = Get-U32 $fl.Data; if ($null -ne $f) { $flags = $f } }
        $up = ($flags -band 1) -eq 1
        $full = ($flags -band 2) -eq 2

        $issues = @()
        if ($up -and -not $full) { $issues += 'HALF-DUPLEX' }
        if ($up -and $null -ne $speed -and $speed -gt 0 -and $speed -lt 100) { $issues += "LOW SPEED ($speed Mbps)" }

        $pcol = 'Gray'; $suffix = ''
        if ($issues.Count -gt 0) { $pcol = 'Red'; $suffix = "  << $($issues -join ', ')" }
        $linkTxt = 'DOWN'; if ($up) { $linkTxt = 'up' }
        $dupTxt = 'half'; if ($full) { $dupTxt = 'full' }
        Say ("        port {0}: link {1,-4}  {2,5} Mbps  {3}-duplex{4}" -f $inst, $linkTxt, $speed, $dupTxt, $suffix) $pcol
      }
    }
  }
  finally { Close-Eip -Conn $conn }
}

# ── cross-check: every supervisor must agree ────────────────────────────────

Say ""
Say "=============================================================" 'Cyan'
Say " SUMMARY"                                                      'Cyan'
Say "=============================================================" 'Cyan'

if ($supervisors.Count -eq 0) {
  Say ""
  Say " NO DLR SUPERVISOR FOUND on any gateway." 'Yellow'
  Say ""
  Say " This means no reachable module has a DLR object (class 0x47)."
  Say " Most common cause: the Ethernet module is a single-port variant."
  Say "   1756-EN2T  = single port -> cannot be a ring node, no DLR object"
  Say "   1756-EN2TR = dual port   -> ring capable, has DLR object"
  Say "   1756-EN4TR = dual port   -> ring capable, has DLR object"
  Say " Check the PORTS column above: a ring node must show 2 or more."
} else {
  Say ""
  foreach ($s in $supervisors) {
    Say ("  {0}  slot {1,-3} {2,-28} {3}" -f $s.Gateway, $s.Slot, $s.Name, $s.Verdict)
  }

  $distinct = @($supervisors | ForEach-Object { $_.Verdict } | Sort-Object -Unique)
  $partSet  = @($supervisors | Where-Object { $null -ne $_.Participants } | ForEach-Object { $_.Participants } | Sort-Object -Unique)

  Say ""
  if ($distinct.Count -gt 1) {
    Say " *** SUPERVISORS DISAGREE ***" 'Red'
    Say " Different supervisors report different ring states. Investigate before"
    Say " trusting any single reading - this usually means a partial fault."
  } elseif ($partSet.Count -gt 1) {
    Say " *** PARTICIPANT COUNT MISMATCH ***" 'Red'
    Say " Supervisors disagree on how many nodes are in the ring: $($partSet -join ', ')"
  } elseif ($distinct[0] -like 'HEALTHY*') {
    Say " RING HEALTHY - all supervisors agree, ring closed." 'Green'
    if ($partSet.Count -eq 1) { Say " Ring participants: $($partSet[0])  << confirm this matches the drawing" 'Green' }
  } else {
    Say " RING NOT HEALTHY - $($distinct[0])" 'Red'
  }
}

Say ""
Say " NOTE: this verifies RING HEALTH (closed/open) and TERMINATION quality."
Say " It does NOT verify which switch port each cable lands on - that needs"
Say " SNMP/LLDP against the managed switches (the MTN6 exact-port check)."
Say ""

if ($OutFile) {
  $script:Report -join "`r`n" | Out-File -FilePath $OutFile -Encoding utf8
  Write-Host "Report written to $OutFile" -ForegroundColor Cyan
}
