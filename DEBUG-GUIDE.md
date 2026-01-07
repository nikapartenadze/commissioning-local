# Debugging Guide - IO Checkout Tool

## Database Architecture

### Two Separate Databases:

1. **SQLite Database** (`database.db` in backend folder)
   - Used by C# backend
   - Stores: IO test results, test history, PLC configuration
   - Location: `IO-Checkout-Tool-Portable/backend/database.db`
   - **THIS IS WHERE PASS/FAIL RESULTS ARE SAVED**

2. **PostgreSQL Database** (remote server)
   - Used by Next.js API routes (but these aren't called)
   - Stores: Project data, subsystems, IOs (imported from cloud)
   - **NOT USED FOR PASS/FAIL OPERATIONS**

## How Pass/Fail Works

```
User clicks Pass/Fail
    ↓
Frontend calls: http://localhost:5000/api/ios/{id}/pass
    ↓
C# Backend updates SQLite database
    ↓
C# Backend sends SignalR update
    ↓
Frontend receives update and refreshes UI
```

## Checking if Pass/Fail Worked

### ✅ Check SQLite Database:
1. Open: `IO-Checkout-Tool-Portable/backend/database.db` with SQLite browser
2. Query: `SELECT * FROM Ios WHERE Result IS NOT NULL`
3. You should see Passed/Failed results

### ❌ Don't Check PostgreSQL:
- PostgreSQL is only for importing initial IO data
- Pass/fail results go to SQLite, not PostgreSQL

## Cloud Sync Issues

### Check Cloud Connection:
1. Look at backend window logs
2. Search for: "Cloud not connected" or "Cloud connection"
3. Cloud sync requires active connection to remote server

### Cloud Sync Flow:
```
User clicks "Sync to Cloud"
    ↓
Frontend calls: http://localhost:5000/api/cloud/sync
    ↓
C# Backend checks: Is cloud connected?
    ↓
If YES: Uploads SQLite data to remote server
If NO: Returns "Cloud not connected" error
```

### Check Backend Logs:
- Success: "Successfully uploaded X test results to cloud"
- Failure: "Failed to upload test results" or "Cloud not connected"

## Fire Output Delay

Fire output has intentional delays:
- 250ms delay after stop (for PLC communication)
- This is normal behavior

## Debugging Steps

1. **Check Backend Window** (remove `/MIN` from START.bat)
   - Look for API call logs
   - Look for database update logs
   - Look for cloud sync logs

2. **Check SQLite Database**
   - Open `database.db` with SQLite browser
   - Verify results are being saved

3. **Check Browser Console**
   - Look for API call logs
   - Look for SignalR updates
   - Look for errors

4. **Check Network Tab**
   - Verify API calls are being made
   - Check response status codes
   - Check response data

## Common Issues

### "Nothing changed in database"
- **Problem**: Checking PostgreSQL instead of SQLite
- **Solution**: Check `database.db` (SQLite) file

### "Cloud sync shows success but nothing uploaded"
- **Problem**: Cloud sync returns success but upload fails
- **Solution**: Check backend logs for actual upload status

### "Fire output is slow"
- **Problem**: Normal behavior - has delays for PLC communication
- **Solution**: This is intentional, not a bug

## Files to Check

- Backend logs: Check backend window console
- SQLite DB: `IO-Checkout-Tool-Portable/backend/database.db`
- Config: `IO-Checkout-Tool-Portable/backend/config.json`

