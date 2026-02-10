# IO Checkout Tool - Project Overview

## What This Application Does

The **IO Checkout Tool** is an industrial commissioning application designed for factories and manufacturing facilities that use **Programmable Logic Controllers (PLCs)**. It streamlines the process of testing and validating Input/Output (I/O) points during system commissioning, installation, and maintenance phases.

### The Problem It Solves

During factory commissioning, technicians need to verify that hundreds or thousands of I/O points (sensors, switches, valves, motors, etc.) are correctly wired and functioning. Traditionally, this involves:
- Manually checking each point with paper checklists
- Recording results by hand
- Consolidating data from multiple technicians
- Generating reports manually
- No real-time visibility into testing progress

This is time-consuming, error-prone, and difficult to track across large projects.

### The Solution

The IO Checkout Tool provides a **digital, real-time commissioning workflow** that:
1. **Connects directly to PLCs** via Ethernet/IP protocol
2. **Reads live I/O states** from the PLC in real-time
3. **Guides technicians** through systematic testing
4. **Records test results** (Pass/Fail) with timestamps and comments
5. **Syncs data to cloud** for remote monitoring and reporting
6. **Generates documentation** automatically

---

## How It Works

### System Architecture

The application consists of **two main components**:

#### 1. **C# Backend** (.NET 9.0 / Blazor Server)
- **PLC Communication**: Uses `libplctag` library to communicate with Allen-Bradley/Rockwell PLCs via Ethernet/IP protocol
- **Local Database**: SQLite database stores user accounts, test history, I/O definitions, and configurations
- **SignalR Hub**: Provides real-time bidirectional communication between backend and frontend
- **Cloud Sync Service**: Uploads test results to remote PostgreSQL database (Azure)
- **Configuration Management**: Supports multiple PLC configurations for different subsystems

#### 2. **Next.js Frontend** (React/TypeScript)
- **Modern Web UI**: Responsive interface optimized for tablets and desktops
- **Project Dashboard**: Overview of all projects and subsystems
- **Testing Interface**: Interactive I/O testing with real-time state updates
- **User Management**: PIN-based authentication (6-digit codes)
- **Data Export**: CSV export capabilities for reporting

### Communication Flow

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Factory PLC   │◄────────┤  C# Backend     │◄────────┤  Next.js        │
│  (Ethernet/IP)  │ libplctag│  - PLC Service  │ SignalR │  Frontend       │
│                 │         │  - Database     │         │  - User UI      │
│  I/O Points:    │         │  - SignalR Hub  │         │  - Dashboard    │
│  - Sensors      │         │  - Cloud Sync   │         │  - Testing      │
│  - Valves       │         └─────────────────┘         └─────────────────┘
│  - Motors       │                   │
│  - Switches     │                   │ HTTPS
└─────────────────┘                   ▼
                              ┌─────────────────┐
                              │  Azure Cloud    │
                              │  PostgreSQL DB  │
                              │  - Remote Data  │
                              │  - Reporting    │
                              └─────────────────┘
```

---

## Core Features

### 1. **Real-Time PLC Communication**

The application connects to industrial PLCs using the **Ethernet/IP protocol** (standard for Allen-Bradley/Rockwell Automation PLCs):

- **Direct Tag Reading**: Reads PLC tag values in real-time (e.g., `Program:MainProgram.DI_Sensor_01`)
- **Output Testing**: Can write to output tags to test actuators (e.g., fire a valve, turn on a motor)
- **Live State Monitoring**: Displays current state of each I/O point (ON/OFF, 0/1, etc.)
- **Connection Health**: Monitors PLC connectivity and alerts on disconnection
- **Automatic Reconnection**: Attempts to reconnect if PLC connection is lost

**Configuration Example:**
```json
{
  "ip": "192.168.1.100",           // PLC IP address
  "path": "1,0",                   // Communication path (slot/port)
  "subsystemId": 1,                // Unique identifier for this subsystem
  "remoteUrl": "https://cloud.example.com",  // Cloud sync endpoint
  "orderMode": 0                   // 0=any order, 1=sequential testing
}
```

### 2. **Guided Testing Workflow**

The application provides a structured testing process:

#### Step 1: Select Project & Subsystem
- Technician logs in with 6-digit PIN
- Selects project from dashboard (e.g., "Carlsbad Factory", "Chattanooga Line A")
- Chooses subsystem to test (e.g., "Main Process", "Packaging Line")

#### Step 2: Start Testing Mode
- Click "Start Testing" to enable the testing interface
- Application connects to PLC and begins reading I/O states
- Real-time state values appear in the grid

#### Step 3: Test Each I/O Point

**For INPUT Points** (sensors, switches):
1. Application shows current state (e.g., "OFF" or "0")
2. Technician physically activates the input (press button, trigger sensor, etc.)
3. Application detects state change in real-time
4. Technician clicks **"Pass"** if it worked correctly
5. Or clicks **"Fail"** and adds comment explaining the issue

**For OUTPUT Points** (valves, motors, lights):
1. Technician clicks **"Fire Output"** button
2. Application writes to PLC tag to activate the output
3. Technician verifies physical device activated (valve opened, motor started, etc.)
4. Clicks **"Pass"** or **"Fail"** with comments

#### Step 4: Record Results
- Each test result is saved with:
  - **Result**: "Passed" or "Failed"
  - **Timestamp**: Exact date/time of test
  - **Technician**: Who performed the test
  - **Comments**: Notes about failures or issues
  - **Version**: For tracking changes over time

#### Step 5: Sync to Cloud
- Results automatically sync to remote database
- Enables remote monitoring by project managers
- Creates centralized record for documentation

### 3. **Multi-Configuration Support**

**Key Innovation**: Switch between different PLC configurations **without restarting the application**.

Traditional approach:
- Edit config file manually
- Restart application
- Wait for reconnection
- Repeat for each subsystem

**New approach** (implemented in this tool):
- Store multiple configurations in database
- Click "Connect" button on any subsystem
- Application instantly switches PLC connection
- No restart required!

**Use Case Example:**
A factory has 5 production lines, each with its own PLC:
- Line A: PLC at 192.168.1.100
- Line B: PLC at 192.168.1.101
- Line C: PLC at 192.168.1.102
- etc.

Technician can test all 5 lines in sequence without restarting the app or editing config files.

### 4. **User Management**

- **PIN-Based Authentication**: Simple 6-digit PINs (no complex passwords)
- **Role-Based Access**: Admin users can create/manage other users
- **Session Management**: Auto-logout after 8 hours for security
- **Audit Trail**: All test results track which user performed the test

**Default Admin Account:**
- PIN: `852963`
- Can create new users, reset PINs, deactivate accounts

### 5. **Data Management & Reporting**

#### Filtering & Search
- **Search Bar**: Find I/O points by name or description
- **Result Filters**: Show only Passed, Failed, or Not Tested points
- **Date Range**: Filter by test date
- **Subsystem Filters**: Filter by specific subsystems

#### Export Capabilities
- **CSV Export**: Download filtered results for Excel/reporting
- **Includes**: All I/O details, test results, timestamps, comments
- **Use Cases**: 
  - Generate commissioning reports for customers
  - Track punch list items (failed tests)
  - Document system state at project handover

#### Test History
- View complete history for each I/O point
- See all previous test results with timestamps
- Track changes over time (re-tests, fixes)
- Identify recurring issues

### 6. **Cloud Synchronization**

**Optional Feature**: Sync data to remote Azure PostgreSQL database

**Benefits:**
- **Remote Monitoring**: Project managers can view progress from office
- **Multi-Site Coordination**: Track multiple factories simultaneously
- **Centralized Reporting**: All project data in one place
- **Historical Data**: Long-term storage beyond local database
- **Backup**: Cloud serves as backup of test results

**How It Works:**
1. Local app performs tests and stores in SQLite
2. Background service uploads results to cloud API
3. Cloud database stores all data centrally
4. Web dashboard shows real-time progress across all sites
5. Offline operation: If cloud unavailable, data queued for later sync

---

## Technical Implementation

### Backend Technologies

- **.NET 9.0**: Modern C# framework
- **Blazor Server**: For some UI components (legacy)
- **Entity Framework Core**: ORM for database access
- **SQLite**: Local database (portable, no server needed)
- **libplctag**: Open-source library for PLC communication (Ethernet/IP)
- **SignalR**: Real-time WebSocket communication
- **MudBlazor**: UI component library

### Frontend Technologies

- **Next.js 14**: React framework with App Router
- **TypeScript**: Type-safe JavaScript
- **Tailwind CSS**: Utility-first CSS framework
- **Shadcn/ui**: Component library
- **React Query**: Data fetching and caching
- **Zustand**: State management

### Database Schema

**Key Tables:**

1. **Users**
   - Id, Name, PIN (hashed), IsAdmin, IsActive
   - Stores user accounts and authentication

2. **Ios** (Input/Output points)
   - Id, SubsystemId, Name, Description, State, Result, Timestamp, Comments
   - Stores I/O definitions and current test results

3. **TestHistories**
   - Id, IoId, Result, Timestamp, UserId, Comments
   - Stores historical test records

4. **SubsystemConfigurations**
   - Id, ProjectName, SubsystemId, IP, Path, RemoteUrl, IsActive
   - Stores PLC connection configurations

5. **PendingSyncs**
   - Id, EntityType, EntityId, Operation, Payload
   - Queue for cloud synchronization

### PLC Communication Details

**Protocol**: Ethernet/IP (EtherNet/Industrial Protocol)
- Industry-standard protocol for industrial automation
- Used by Allen-Bradley, Rockwell Automation PLCs
- TCP/IP based, runs over standard Ethernet networks

**Tag Reading Process:**
1. Application creates tag object with PLC IP, path, and tag name
2. Establishes connection to PLC
3. Reads tag value at configured interval (e.g., every 500ms)
4. Detects value changes and notifies UI via SignalR
5. UI updates in real-time

**Tag Writing Process (for outputs):**
1. User clicks "Fire Output" button
2. Frontend sends request to backend API
3. Backend writes value to PLC tag (e.g., set to TRUE)
4. Holds for configured duration (e.g., 2 seconds)
5. Resets value (e.g., set to FALSE)
6. Technician observes physical device activation

---

## Typical Use Cases

### Use Case 1: New Factory Commissioning

**Scenario**: A new bottling plant is being commissioned with 2,000 I/O points across 8 subsystems.

**Workflow:**
1. **Setup Phase**:
   - Administrator pre-configures 8 subsystem connections in database
   - Imports I/O point list from PLC export (CSV)
   - Creates user accounts for 4 commissioning technicians

2. **Testing Phase**:
   - Each technician takes a tablet with the application
   - Logs in with their PIN
   - Selects their assigned subsystem
   - Works through I/O points systematically
   - Marks Pass/Fail with comments for issues

3. **Monitoring Phase**:
   - Project manager monitors progress remotely via cloud dashboard
   - Sees real-time completion percentage for each subsystem
   - Reviews failed points and assigns rework

4. **Documentation Phase**:
   - Export complete test results to CSV
   - Generate commissioning report for customer
   - Archive data for warranty/support purposes

### Use Case 2: Maintenance & Troubleshooting

**Scenario**: A production line experiences intermittent sensor failures.

**Workflow:**
1. Maintenance technician logs in
2. Selects the affected subsystem
3. Filters to show only "Failed" I/O points
4. Re-tests each failed point
5. Documents fixes in comments
6. Marks as "Passed" once repaired
7. Historical data shows when issues first appeared

### Use Case 3: System Upgrades

**Scenario**: PLC program updated with new I/O points added.

**Workflow:**
1. Import updated I/O list from PLC
2. Application identifies new points (not previously tested)
3. Filter to show "Not Tested" points
4. Test only the new additions
5. Verify existing points still work correctly
6. Document system state after upgrade

---

## Deployment Options

### Option 1: Portable Distribution (Recommended for Field Use)

**Package Contents:**
- `backend/`: Compiled C# application with all dependencies
- `frontend/`: Built Next.js application
- `nodejs/`: Portable Node.js runtime (no installation needed)
- `START.bat`: Launches both backend and frontend
- `STOP.bat`: Gracefully shuts down both services

**Advantages:**
- No installation required
- Works offline (except cloud sync)
- Can run from USB drive
- Easy to deploy to multiple tablets/laptops
- No admin rights needed

**Typical Setup:**
1. Copy folder to technician's tablet
2. Double-click `START.bat`
3. Open browser to `http://localhost:3002`
4. Start testing

### Option 2: Development Setup

**For Developers:**
- C# backend runs in Visual Studio or via `dotnet run`
- Next.js frontend runs via `npm run dev`
- Hot reload enabled for both
- Suitable for feature development and debugging

### Option 3: Docker Deployment

**For Server Hosting:**
- Dockerfile provided for Next.js frontend
- Docker Compose configuration for production
- Can deploy to cloud (Azure, AWS, etc.)
- Suitable for centralized hosting with multiple clients

---

## Key Benefits

### For Technicians
- ✅ **Simple Interface**: Easy to use on tablets in the field
- ✅ **Real-Time Feedback**: See I/O states change instantly
- ✅ **Guided Workflow**: Clear Pass/Fail buttons, no confusion
- ✅ **Offline Capable**: Works without internet (local database)
- ✅ **Fast Testing**: Much quicker than paper checklists

### For Project Managers
- ✅ **Remote Visibility**: Monitor progress from anywhere
- ✅ **Real-Time Status**: See completion percentage live
- ✅ **Issue Tracking**: Identify problems immediately
- ✅ **Resource Planning**: Know which areas need attention
- ✅ **Documentation**: Automatic report generation

### For Companies
- ✅ **Faster Commissioning**: Reduce project timelines
- ✅ **Better Quality**: Fewer missed tests, complete documentation
- ✅ **Cost Savings**: Less rework, fewer callbacks
- ✅ **Standardization**: Consistent process across all projects
- ✅ **Knowledge Retention**: Historical data for future reference
- ✅ **Customer Satisfaction**: Professional documentation and faster handover

---

## Security & Reliability

### Security Features
- **PIN Authentication**: Simple but effective access control
- **Role-Based Access**: Admins vs. regular users
- **Session Timeouts**: Automatic logout after inactivity
- **Password Hashing**: PINs stored securely (bcrypt)
- **HTTPS Support**: Encrypted communication (in cloud deployment)

### Reliability Features
- **Automatic Reconnection**: Recovers from PLC disconnections
- **Network Monitoring**: Tests connectivity before operations
- **Data Persistence**: All results saved immediately
- **Offline Queue**: Syncs to cloud when connection restored
- **Error Handling**: Graceful degradation on failures
- **Logging**: Comprehensive logs for troubleshooting

---

## Future Enhancements

### Planned Features
- 📱 **Mobile App**: Native iOS/Android apps for better tablet experience
- 📊 **Advanced Analytics**: Dashboards showing trends, common failures
- 🔔 **Notifications**: Alert managers when critical tests fail
- 📸 **Photo Attachments**: Add photos to failed test comments
- 🗺️ **Floor Plans**: Visual representation of I/O locations
- 🔄 **Bulk Operations**: Test multiple similar points simultaneously
- 📝 **Custom Checklists**: Define test procedures per I/O type
- 🌐 **Multi-Language**: Support for non-English speaking technicians

---

## Support & Documentation

### For End Users
- **User Guide**: Step-by-step instructions for testing workflow
- **Configuration Help**: `config-help.txt` explains all settings
- **Video Tutorials**: Planned for common tasks

### For Administrators
- **Setup Guide**: How to configure new projects
- **User Management**: Creating accounts, resetting PINs
- **Cloud Sync Setup**: Connecting to remote database

### For Developers
- **README.md**: Development setup instructions
- **API Documentation**: Endpoint reference (planned)
- **Architecture Docs**: System design and component interaction
- **Contribution Guide**: How to add features or fix bugs

---

## Conclusion

The **IO Checkout Tool** transforms industrial commissioning from a manual, paper-based process into a modern, digital workflow. By connecting directly to PLCs and providing real-time feedback, it enables faster, more accurate testing while automatically generating the documentation required for project handover.

Whether commissioning a new factory, maintaining existing equipment, or troubleshooting issues, this tool provides the visibility and control needed to ensure all I/O points are functioning correctly before production begins.

---

## Quick Reference

**Default Admin PIN**: `852963`

**Default Ports**:
- Backend: `http://localhost:5000`
- Frontend: `http://localhost:3002`

**Key Files**:
- Configuration: `backend/config.json`
- Database: `backend/database.db`
- Logs: `backend/logs/`

**Common Commands**:
```bash
# Start development environment
start-dev.bat

# Build portable distribution
REBUILD-DISTRIBUTION.bat

# Access application
http://localhost:3002
```

**Support Contact**: [Your support contact information here]

---

*Document Version: 1.0*  
*Last Updated: January 2026*  
*Project: IO Checkout Tool - Industrial Commissioning Application*

