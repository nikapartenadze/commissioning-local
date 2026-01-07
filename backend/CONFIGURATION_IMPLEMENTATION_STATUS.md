# Dynamic Configuration Management - Implementation Status

## ✅ C# BACKEND - COMPLETE (100%)

### 1. Database Layer ✅
- ✅ `Models/SubsystemConfiguration.cs` - Complete entity model
- ✅ `Models/TagsContext.cs` - DbSet and entity configuration added
- ✅ Unique index on (ProjectName, SubsystemId)
- ✅ IsActive flag for tracking current configuration

### 2. API Controller ✅
**File:** `Controllers/ConfigurationController.cs`

All endpoints implemented:
- ✅ `GET /api/configuration` - List all configurations
- ✅ `GET /api/configuration/active` - Get active configuration
- ✅ `GET /api/configuration/{id}` - Get specific configuration
- ✅ `GET /api/configuration/project/{name}/subsystem/{id}` - Get by project/subsystem
- ✅ `POST /api/configuration` - Create new configuration
- ✅ `PUT /api/configuration/{id}` - Update configuration
- ✅ `DELETE /api/configuration/{id}` - Delete configuration (prevents deletion of active)
- ✅ `POST /api/configuration/{id}/activate` - **Switch to configuration at runtime (NO RESTART!)**
- ✅ `POST /api/configuration/import-from-config-json` - Import current config.json

### 3. Service Layer ✅
**Files:**
- ✅ `Services/Interfaces/IConfigurationService.cs` - Added `SwitchToConfigurationAsync`
- ✅ `Services/ConfigurationService.cs` - Implemented runtime config switching
- ✅ `Services/Interfaces/IPlcCommunicationService.cs` - Added `ReconnectAsync` and `RefreshTagListFromDatabaseAsync`
- ✅ `Services/PlcCommunicationService.cs` - Implemented PLC reconnection with new config

**Key Methods:**
```csharp
// Switches configuration WITHOUT restarting app
Task<bool> SwitchToConfigurationAsync(...)

// Reconnects PLC with new IP/Path
Task ReconnectAsync(string ip, string path)

// Refreshes tag list from database
Task RefreshTagListFromDatabaseAsync()
```

## ⏳ NEXT.JS FRONTEND - TODO

### 4. Next.js API Routes (Proxy to C#)
Need to create in `commissioning/app/api/configurations/`:

**`route.ts`** - List/Create
```typescript
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

**`[id]/route.ts`** - Get/Update/Delete
```typescript
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const response = await fetch(`${C_SHARP_BASE_URL}/api/configuration/${params.id}`);
  return Response.json(await response.json());
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json();
  const response = await fetch(`${C_SHARP_BASE_URL}/api/configuration/${params.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return new Response(null, { status: 204 });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const response = await fetch(`${C_SHARP_BASE_URL}/api/configuration/${params.id}`, {
    method: 'DELETE'
  });
  return new Response(null, { status: 204 });
}
```

**`[id]/activate/route.ts`** - Activate configuration
```typescript
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const response = await fetch(`${C_SHARP_BASE_URL}/api/configuration/${params.id}/activate`, {
    method: 'POST'
  });
  return Response.json(await response.json());
}
```

### 5. Next.js UI Components
Need to create/update:

**`components/subsystem-config-dialog.tsx`** - Configuration form
```typescript
interface SubsystemConfigDialogProps {
  projectName: string;
  subsystemId: number;
  onSave: () => void;
}

export function SubsystemConfigDialog({ projectName, subsystemId, onSave }: SubsystemConfigDialogProps) {
  // Form with fields: IP, Path, Remote URL, API Password
  // Submit → POST /api/configurations
}
```

**Update `components/project-list-enhanced.tsx`**
- Add "Configure" button (gear icon) next to each subsystem
- On "Connect" → Call `POST /api/configurations/{id}/activate`
- On "Configure" → Open `SubsystemConfigDialog`

**Update `app/commissioning/[id]/page.tsx`**
- On mount, load configuration from `GET /api/configurations/active`
- Connect to subsystem using loaded config

### 6. Database Seeding/Migration
Create hosted service or startup logic:

**`Services/ConfigurationSeedingService.cs`**
```csharp
public class ConfigurationSeedingService : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        using var context = await _contextFactory.CreateDbContextAsync();
        
        // Check if configurations table is empty
        var count = await context.SubsystemConfigurations.CountAsync();
        if (count == 0)
        {
            _logger.LogInformation("No configurations found. Importing from config.json...");
            
            // Import current config.json
            var httpClient = new HttpClient();
            await httpClient.PostAsync("http://localhost:5000/api/configuration/import-from-config-json", null);
        }
    }
}
```

## 🎯 HOW IT WORKS - COMPLETE FLOW

### First Run (Seeding)
```
1. App starts → ConfigurationSeedingService runs
2. Checks if SubsystemConfigurations table is empty
3. If empty → Calls /api/configuration/import-from-config-json
4. Current config.json imported as first configuration, marked Active
5. User can now add more configurations from UI
```

### Adding New Configuration (UI)
```
1. User opens main page, sees project card
2. Clicks "Configure" (gear icon) on a subsystem
3. Dialog opens with form (IP, Path, Remote URL, Password)
4. User fills form → Clicks Save
5. Frontend: POST /api/configurations
6. Backend: Saves to SubsystemConfigurations table
7. Now "Connect" button works for that subsystem!
```

### Switching Subsystems (NO RESTART!)
```
1. User clicks "Connect" on different project/subsystem
2. Frontend: POST /api/configurations/{id}/activate
3. Backend:
   a. Marks configuration as IsActive in database
   b. Calls ConfigurationService.SwitchToConfigurationAsync()
      - Updates in-memory config (IP, Path, SubsystemId, etc.)
      - Saves to config.json for persistence
   c. Calls PlcCommunicationService.ReconnectAsync()
      - Calls ReinitializePlcConnectionAsync()
      - Resets TagReaderService (disposes old connections)
      - Creates new tags with new IP/Path
      - Tests connectivity
      - Initializes tag reading
   d. Loads IOs for new subsystem from database
4. Frontend: Navigates to /commissioning/[subsystemId]
5. SignalR updates flow, testing works immediately
6. User can test WITHOUT restarting C# app! 🎉
```

## 💡 BENEFITS

- ✅ **No manual config.json editing** - Everything from UI
- ✅ **No app restarts** - Switch subsystems instantly
- ✅ **Store unlimited configurations** - Database backed
- ✅ **Easy switching** - One click between projects/subsystems
- ✅ **Field engineer friendly** - Simple UI, no technical knowledge needed
- ✅ **Pre-populate configs** - Give customers ready-to-use setup
- ✅ **Configurations persist** - Survives app restarts
- ✅ **Export/Import ready** - Can backup/restore configurations

## 🚀 PRE-POPULATION WORKFLOW

**For Customers with Multiple Subsystems:**

1. **Create master config.json** with all subsystems:
```json
{
  "configurations": [
    {
      "projectName": "Carlsbad",
      "subsystemId": 1,
      "subsystemName": "Main Process",
      "ip": "192.168.1.100",
      "path": "1,0",
      "remoteUrl": "https://cloud.example.com/carlsbad",
      "apiPassword": "password123"
    },
    {
      "projectName": "Chattanooga",
      "subsystemId": 2,
      "subsystemName": "Production Line A",
      "ip": "192.168.1.101",
      "path": "1,0",
      "remoteUrl": "https://cloud.example.com/chattanooga",
      "apiPassword": "password456"
    }
    // ... more subsystems
  ]
}
```

2. **On first run** - App imports all into database
3. **Field engineer** - Just clicks "Connect" on any project
4. **Switch anytime** - No restart, instant switching

## 📊 DATABASE SCHEMA

**SubsystemConfigurations Table:**
```sql
CREATE TABLE SubsystemConfigurations (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    ProjectName TEXT(100) NOT NULL,
    SubsystemId INTEGER NOT NULL,
    SubsystemName TEXT(100) NOT NULL,
    Ip TEXT(50) NOT NULL,
    Path TEXT(50) NOT NULL,
    RemoteUrl TEXT(200),
    ApiPassword TEXT(200),
    OrderMode INTEGER NOT NULL DEFAULT 0,
    DisableWatchdog INTEGER NOT NULL DEFAULT 1,
    ShowStateColumn INTEGER NOT NULL DEFAULT 1,
    ShowResultColumn INTEGER NOT NULL DEFAULT 1,
    ShowTimestampColumn INTEGER NOT NULL DEFAULT 1,
    ShowHistoryColumn INTEGER NOT NULL DEFAULT 1,
    IsActive INTEGER NOT NULL DEFAULT 0,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL,
    Description TEXT(500),
    UNIQUE(ProjectName, SubsystemId)
);

CREATE INDEX idx_subsystem_active ON SubsystemConfigurations(IsActive);
CREATE INDEX idx_subsystem_project ON SubsystemConfigurations(ProjectName, SubsystemId);
```

## ✅ TESTING CHECKLIST

### Backend Testing
- [ ] Create configuration via API
- [ ] Update configuration via API
- [ ] Delete configuration via API (ensure active can't be deleted)
- [ ] Activate configuration → verify PLC reconnects
- [ ] Import from config.json
- [ ] Switch between configurations without restart
- [ ] Verify state persistence across switches

### Frontend Testing
- [ ] Configure dialog opens and saves
- [ ] Connect button switches configuration
- [ ] Testing works immediately after switch
- [ ] SignalR updates flow correctly
- [ ] Navigation works (back to projects)
- [ ] Multiple subsystems can be configured
- [ ] Configuration persists on page refresh

### Integration Testing
- [ ] Configure → Save → Connect → Test → Pass/Fail → Back → Switch → Test again
- [ ] Verify no restarts needed
- [ ] Verify IOs load correctly for each subsystem
- [ ] Verify cloud sync works with switched subsystem
- [ ] Verify history is subsystem-specific

## 🔄 MIGRATION PATH

**For Existing Users:**
1. App starts with old config.json
2. First run imports config.json into database
3. Old config.json still works (backwards compatible)
4. Can add more configurations from UI
5. Gradually migrate all subsystems to database

**No Breaking Changes!**

