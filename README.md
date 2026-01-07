# IO Checkout Tool

A comprehensive commissioning application for testing and managing industrial I/O (Input/Output) points. This system consists of a C# backend for PLC communication and a Next.js frontend for user interface and data management.

## What This Application Does

The IO Checkout Tool is designed for industrial commissioning processes where technicians need to:

- **Test I/O Points**: Verify that inputs and outputs are working correctly
- **Track Test Results**: Record pass/fail status for each I/O point
- **Manage Projects**: Organize I/O points by subsystems and projects
- **Generate Reports**: Export test results for documentation
- **User Management**: Control access with PIN-based authentication
- **Real-time Monitoring**: See live status updates from PLC systems

## Quick Start

### For End Users

1. **Start the Application**
   ```bash
   # Run the batch file to start both backend and frontend
   start-dev.bat
   ```

2. **Access the Application**
   - Open your browser to `http://localhost:3000`
   - Login with your PIN (default admin PIN: `852963`)

3. **Basic Workflow**
   - Select a project from the dashboard
   - Choose a subsystem to test
   - Mark I/O points as Passed or Failed
   - Add comments for failed tests
   - Export results when complete

### For Administrators

1. **User Management**
   - Login as admin (PIN: `852963`)
   - Click the user menu → "Admin Panel"
   - Create new users with 6-digit PINs
   - Reset PINs or deactivate users as needed

2. **Project Configuration**
   - Configure PLC connections for each subsystem
   - Set up cloud sync for remote data storage
   - Manage project settings and API keys

## Application Components

### Backend (C#)
- **PLC Communication**: Connects to industrial PLCs via Ethernet/IP
- **Local Database**: SQLite database for user management and test history
- **SignalR Hub**: Real-time communication with frontend
- **Cloud Sync**: Uploads test results to remote database

### Frontend (Next.js)
- **User Interface**: Modern web interface for tablets and desktops
- **Project Dashboard**: Overview of all projects and subsystems
- **Testing Interface**: Intuitive I/O point testing workflow
- **Data Management**: Filtering, searching, and exporting capabilities

## User Guide

### Login Process

1. **PIN Login**: Enter your 6-digit PIN on the login screen
2. **Auto-logout**: Sessions expire after 8 hours for security
3. **Admin Access**: Admin users can access user management features

### Testing I/O Points

1. **Select Project**: Choose from available projects on the dashboard
2. **Choose Subsystem**: Pick the subsystem you want to test
3. **Start Testing**: Click "Start Testing" to begin the test session
4. **Mark Results**:
   - **Passed**: I/O point is working correctly
   - **Failed**: I/O point has issues (add comments explaining why)
   - **Clear**: Remove previous test results
5. **Fire Outputs**: For output points, use the "Fire Output" button to test

### Filtering and Search

- **Search Bar**: Type keywords to find specific I/O points
- **Result Filters**: Show only Passed, Failed, or Not Tested points
- **Subsystem Filters**: Filter by specific subsystems
- **Date Range**: Filter by test date
- **Export**: Download filtered results as CSV

### Mobile/Tablet Usage

The interface is optimized for tablet use:
- **Responsive Design**: Works on various screen sizes
- **Touch-Friendly**: Large buttons and touch targets
- **Collapsible Sidebar**: More screen space for data on smaller devices
- **Mobile Filters**: Drawer-style filters for mobile devices

## Development Setup

### Prerequisites

- **.NET 8.0 SDK**: For C# backend development
- **Node.js 18+**: For frontend development


### Project Structure

```
IO Checkout Local/
├── IO-Checkout-Tool copy/          # C# Backend
│   ├── Controllers/                # API endpoints
│   ├── Models/                     # Data models
│   ├── Services/                   # Business logic
│   ├── Repositories/               # Data access
│   └── database.db                 # SQLite database
├── commissioning-tool-frontend/    # Next.js Frontend
│   ├── app/                        # Next.js app router
│   ├── components/                 # React components
│   ├── lib/                        # Utilities
│   └── types/                      # TypeScript types
└── start-dev.bat                   # Development startup script
```

### Backend Development (C#)

1. **Open in Visual Studio**
   ```bash
   # Open the solution file
   IO-Checkout-Tool copy/IO Checkout Tool.sln
   ```

2. **Install Dependencies**
   ```bash
   # Restore NuGet packages
   dotnet restore
   ```

3. **Run Backend**
   ```bash
   # Start the backend server
   dotnet run --project "IO-Checkout-Tool copy"
   ```

4. **Key Files**
   - `Controllers/ApiController.cs`: Main API endpoints
   - `Controllers/AuthController.cs`: User authentication
   - `Controllers/UserController.cs`: User management
   - `Models/TagsContext.cs`: Database context
   - `Services/SignalRService.cs`: Real-time communication

### Frontend Development (Next.js)

1. **Navigate to Frontend**
   ```bash
   cd commissioning-tool-frontend
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Start Development Server**
   ```bash
   npm run dev
   ```

4. **Key Files**
   - `app/page.tsx`: Main dashboard
   - `app/commissioning/[id]/page.tsx`: Testing interface
   - `components/`: React components
   - `lib/user-context.tsx`: User authentication context

### Database Management

The application uses SQLite for local data storage:

1. **Database Location**: `IO-Checkout-Tool copy/database.db`
2. **User Management**: Stored in `Users` table
3. **Test History**: Stored in `TestHistories` table
4. **I/O Points**: Stored in `Ios` table

### API Endpoints

#### Authentication
- `POST /api/auth/login`: User login with PIN
- `GET /api/users`: Get all users (admin only)
- `POST /api/users`: Create new user (admin only)

#### Testing
- `POST /api/plc/mark-passed`: Mark I/O as passed
- `POST /api/plc/mark-failed`: Mark I/O as failed
- `POST /api/plc/fire-output`: Fire output for testing
- `POST /api/plc/toggle-testing`: Start/stop testing mode

#### Data Management
- `GET /api/project/{id}/ios`: Get I/O points for project
- `GET /api/history/{ioId}`: Get test history for I/O point
- `POST /api/sync/update`: Upload data to cloud

### Configuration

#### Backend Configuration
- **PLC Settings**: Configure in `config.json`
- **Database**: SQLite connection string
- **SignalR**: Hub URL configuration

#### Frontend Configuration
- **API Base URL**: Backend server address
- **Authentication**: User session management
- **Theme**: Light/dark mode support

### Building and Deployment

#### Development Build
```bash
# Backend
dotnet build "IO-Checkout-Tool copy"

# Frontend
cd commissioning-tool-frontend
npm run build
```

#### Production Deployment
```bash
# Backend
dotnet publish "IO-Checkout-Tool copy" -c Release

# Frontend
cd commissioning-tool-frontend
npm run build
```

### Testing

#### Backend Testing
```bash
# Run unit tests
dotnet test "IO-Checkout-Tool copy"
```

#### Frontend Testing
```bash
# Run linting
npm run lint

# Type checking
npm run type-check
```

### Troubleshooting

#### Common Issues

1. **Backend Won't Start**
   - Check if port 5000 is available
   - Verify .NET 8.0 SDK is installed
   - Check database file permissions

2. **Frontend Won't Connect**
   - Verify backend is running on port 5000
   - Check browser console for errors
   - Ensure CORS is configured correctly

3. **Database Issues**
   - Check SQLite file permissions
   - Verify database schema is up to date
   - Check for database locks

4. **PLC Connection Problems**
   - Verify PLC IP address and path
   - Check network connectivity
   - Ensure PLC is in correct mode

#### Debug Mode

1. **Backend Debugging**
   ```bash
   # Run with detailed logging
   dotnet run --project "IO-Checkout-Tool copy" --verbosity detailed
   ```

2. **Frontend Debugging**
   ```bash
   # Run with debug mode
   npm run dev -- --debug
   ```

### Contributing

1. **Code Style**
   - Follow C# coding conventions for backend
   - Use TypeScript for frontend
   - Add comments for complex logic

2. **Git Workflow**
   ```bash
   # Create feature branch
   git checkout -b feature/new-feature
   
   # Make changes and commit
   git add .
   git commit -m "Add new feature"
   
   # Push and create pull request
   git push origin feature/new-feature
   ```

3. **Testing Requirements**
   - Test on both desktop and tablet
   - Verify responsive design
   - Check user authentication flows

## Support

For technical support or questions:
- Check the troubleshooting section above
- Review the application logs
- Contact the development team

## License

This application is proprietary software. All rights reserved.
