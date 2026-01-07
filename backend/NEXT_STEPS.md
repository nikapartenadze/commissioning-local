# Next Steps - Dynamic Configuration Implementation

## ✅ COMPLETED (C# Backend - 100%)

All C# backend work is **COMPLETE** in `IO-Checkout-Tool copy/`:
- ✅ Database model and migrations
- ✅ Full API controller with all endpoints
- ✅ Service layer implementation
- ✅ PLC reconnection logic

## 🚀 REMAINING WORK (Next.js Frontend)

### Step 1: Create Next.js API Routes (30 min)

Create these files in `commissioning/app/api/configurations/`:

**1. `route.ts`**
```typescript
const C_SHARP_BASE_URL = process.env.CSHARP_API_URL || 'http://localhost:5000';

export async function GET() {
  const response = await fetch(`${C_SHARP_BASE_URL}/api/configuration`);
  return Response.json(await response.json());
}

export async function POST(request: Request) {
  const body = await request.json();
  const response = await fetch(`${C_SHARP_BASE_URL}/api/configuration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return Response.json(await response.json());
}
```

**2. `[id]/route.ts`**
```typescript
const C_SHARP_BASE_URL = process.env.CSHARP_API_URL || 'http://localhost:5000';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const response = await fetch(`${C_SHARP_BASE_URL}/api/configuration/${params.id}`);
  return Response.json(await response.json());
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json();
  await fetch(`${C_SHARP_BASE_URL}/api/configuration/${params.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return new Response(null, { status: 204 });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  await fetch(`${C_SHARP_BASE_URL}/api/configuration/${params.id}`, {
    method: 'DELETE'
  });
  return new Response(null, { status: 204 });
}
```

**3. `[id]/activate/route.ts`**
```typescript
const C_SHARP_BASE_URL = process.env.CSHARP_API_URL || 'http://localhost:5000';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const response = await fetch(`${C_SHARP_BASE_URL}/api/configuration/${params.id}/activate`, {
    method: 'POST'
  });
  return Response.json(await response.json());
}
```

### Step 2: Create Configuration Dialog Component (1 hour)

**File:** `commissioning/components/subsystem-config-dialog.tsx`

```typescript
'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface SubsystemConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
  subsystemId: number
  subsystemName: string
  onSave: () => void
}

export function SubsystemConfigDialog({
  open,
  onOpenChange,
  projectName,
  subsystemId,
  subsystemName,
  onSave
}: SubsystemConfigDialogProps) {
  const [config, setConfig] = useState({
    ip: '',
    path: '1,0',
    remoteUrl: '',
    apiPassword: ''
  })
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      const response = await fetch('/api/configurations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName,
          subsystemId,
          subsystemName,
          ...config
        })
      })

      if (response.ok) {
        onSave()
        onOpenChange(false)
      } else {
        alert('Failed to save configuration')
      }
    } catch (error) {
      console.error('Error saving configuration:', error)
      alert('Error saving configuration')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Configure {projectName} - Subsystem {subsystemId}</DialogTitle>
        </DialogHeader>
        
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="ip">PLC IP Address *</Label>
            <Input
              id="ip"
              placeholder="192.168.1.100"
              value={config.ip}
              onChange={(e) => setConfig({ ...config, ip: e.target.value })}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="path">PLC Path *</Label>
            <Input
              id="path"
              placeholder="1,0"
              value={config.path}
              onChange={(e) => setConfig({ ...config, path: e.target.value })}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="remoteUrl">Cloud Remote URL (Optional)</Label>
            <Input
              id="remoteUrl"
              placeholder="https://cloud.example.com"
              value={config.remoteUrl}
              onChange={(e) => setConfig({ ...config, remoteUrl: e.target.value })}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="apiPassword">API Password (Optional)</Label>
            <Input
              id="apiPassword"
              type="password"
              placeholder="Enter API password"
              value={config.apiPassword}
              onChange={(e) => setConfig({ ...config, apiPassword: e.target.value })}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !config.ip}>
            {saving ? 'Saving...' : 'Save Configuration'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

### Step 3: Update Project List Component (30 min)

**Update:** `commissioning/components/project-list-enhanced.tsx`

Add these changes:

```typescript
import { SubsystemConfigDialog } from './subsystem-config-dialog'
import { Settings } from 'lucide-react'

// Add state
const [configDialogOpen, setConfigDialogOpen] = useState(false)
const [selectedSubsystem, setSelectedSubsystem] = useState<any>(null)

// Add handler
const handleConnect = async (configId: number) => {
  try {
    const response = await fetch(`/api/configurations/${configId}/activate`, {
      method: 'POST'
    })
    
    if (response.ok) {
      const data = await response.json()
      // Navigate to commissioning page
      router.push(`/commissioning/${data.configuration.subsystemId}`)
    } else {
      alert('Failed to activate configuration')
    }
  } catch (error) {
    console.error('Error activating configuration:', error)
    alert('Error activating configuration')
  }
}

// Add configure button next to each Connect button
<Button
  variant="ghost"
  size="icon"
  onClick={() => {
    setSelectedSubsystem({ projectName: project.name, subsystemId: subsystem.id })
    setConfigDialogOpen(true)
  }}
>
  <Settings className="h-4 w-4" />
</Button>

// Add dialog at end of component
<SubsystemConfigDialog
  open={configDialogOpen}
  onOpenChange={setConfigDialogOpen}
  projectName={selectedSubsystem?.projectName || ''}
  subsystemId={selectedSubsystem?.subsystemId || 0}
  subsystemName={`Subsystem ${selectedSubsystem?.subsystemId}`}
  onSave={() => {
    // Refresh configurations
    // Maybe show success toast
  }}
/>
```

### Step 4: Database Migration (5 min)

The EF Core migration will create the table automatically on first run. To trigger it:

**Option 1: Automatic (Recommended)**
- Just run the C# app
- EF Core will see the new DbSet and create the table

**Option 2: Manual Migration**
```bash
cd "IO-Checkout-Tool copy"
dotnet ef migrations add AddSubsystemConfigurations
dotnet ef database update
```

### Step 5: Test Complete Flow (30 min)

1. **Start C# App** (`IO-Checkout-Tool copy`)
   ```bash
   dotnet run
   ```

2. **Start Next.js App** (`commissioning`)
   ```bash
   npm run dev
   ```

3. **Test Sequence:**
   - Open main page
   - Click "Configure" on a project
   - Fill in IP, Path
   - Click Save
   - Click "Connect" on same project
   - Verify app switches without restart
   - Test some IOs
   - Click "Back to Projects"
   - Click "Connect" on different project
   - Verify instant switch, no restart!

## 🎯 EXPECTED RESULT

After completing these steps:

1. **Main Page:**
   - Each project card shows subsystems
   - Each subsystem has "Configure" (gear icon) and "Connect" buttons
   - Clicking Configure opens dialog to set IP, Path, etc.
   - Clicking Connect switches to that subsystem instantly

2. **Commissioning Page:**
   - Loads correct IOs for selected subsystem
   - Testing works immediately
   - SignalR updates flow correctly
   - Back button returns to main page

3. **No Restarts Needed:**
   - Switch between subsystems seamlessly
   - Configuration changes apply instantly
   - PLC reconnects automatically

## 📝 OPTIONAL ENHANCEMENTS (Later)

- [ ] Bulk import configurations from CSV/JSON
- [ ] Export configurations backup
- [ ] Edit existing configurations
- [ ] Configuration validation (test connection before save)
- [ ] Recent subsystems quick access
- [ ] Configuration templates for common setups

## 🔧 TROUBLESHOOTING

**If switching doesn't work:**
1. Check C# app logs for errors
2. Verify configuration was saved to database
3. Check PLC connectivity with new IP
4. Ensure SignalR connection is active

**If configurations don't persist:**
1. Check database.db file exists
2. Verify SubsystemConfigurations table created
3. Check EF Core migrations ran

**If UI doesn't update:**
1. Check Next.js API routes are returning data
2. Verify C# API is accessible
3. Check browser console for errors

