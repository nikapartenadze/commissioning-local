# IO Checkout Tool

A Blazor application for testing and commissioning industrial I/O systems with PLC integration.

## Setup Instructions

### 1. First-Time Setup

1. **Copy the configuration template:**
   - Copy `config.json.template` to `config.json`
   - The `config.json` file will contain your specific PLC connection settings

2. **Configure your PLC connection:**
   - Open `config.json` in any text editor (like Notepad)
   - Update the settings for your specific setup
   - See the **Configuration** section below for details

### 2. Configuration

Edit the `config.json` file with your settings:

```json
{
  "ip": "192.168.1.100",           // PLC IP address
  "path": "1,0",                   // PLC communication path  
  "remoteUrl": "",                 // Remote server URL (optional)
  "subsystemId": "1",              // Unique system identifier
  "orderMode": "0"                 // 0=any order, 1=specific order
}
```

**Configuration Settings:**

- **ip**: The IP address of your PLC (ask your network administrator)
- **path**: The communication path to the PLC (provided by PLC programmer)
- **remoteUrl**: Web address for uploading test data (leave empty if not needed)
- **subsystemId**: Unique number for this testing station
- **orderMode**: Whether tests must be done in order (0=no, 1=yes)

📖 **For detailed help**, see `config-help.txt`

### 3. Running the Application

1. Make sure your `config.json` file is configured correctly
2. Run the application
3. If you see a configuration error, check your `config.json` file

## Troubleshooting

**"Failed to read config.json" error:**
- Make sure `config.json` exists in the application folder
- Check that the JSON format is valid (proper quotes and commas)
- Verify all required settings are present (ip, path, subsystemId)
- See `config-help.txt` for detailed instructions

**PLC Connection Issues:**
- Verify the IP address is correct and the PLC is reachable
- Check that the path setting matches your PLC configuration
- Ensure your network allows communication on the specified IP

## Cloud Sync (Optional)

The IO Checkout Tool can sync with a cloud-based server for remote monitoring:

**Setup:**
1. Deploy the IO-Checkout-Cloud application to your server
2. Set the `remoteUrl` in `config.json` to your cloud server URL
3. The local app will automatically sync test results to the cloud

**Features:**
- Automatic sync of IO definitions from cloud on startup
- Real-time sync of test results to cloud
- Offline operation when cloud is unavailable
- Cloud serves as master source for IO definitions
- Local app maintains test results authority

**Benefits:**
- Remote monitoring of test progress
- Centralized IO configuration management
- Historical test data tracking
- Multi-site coordination

## Development

This application uses:
- .NET 9.0
- Blazor Server
- Entity Framework Core
- MudBlazor UI Framework
- libplctag for PLC communication