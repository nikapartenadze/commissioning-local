using Microsoft.AspNetCore.Mvc;
using IO_Checkout_Tool.Services.Interfaces;
using Shared.Library.Models.Entities;
using Shared.Library.DTOs;
using Shared.Library.Repositories.Interfaces;
using IO_Checkout_Tool.Models.Configuration;

namespace IO_Checkout_Tool.Controllers;

[ApiController]
[Route("api")]
public class ApiController : ControllerBase
{
    private readonly IPlcCommunicationService _plcCommunication;
    private readonly IConfigurationService _configuration;
    private readonly IIoRepository _ioRepository;
    private readonly ITestHistoryRepository _testHistoryRepository;
    private readonly ICloudSyncService _cloudSyncService;
    private readonly ISignalRService _signalRService;
    private readonly IIoTestService _ioTestService;
    private readonly ILogger<ApiController> _logger;
    private static bool _isTesting = false;

    public ApiController(
        IPlcCommunicationService plcCommunication,
        IConfigurationService configuration,
        IIoRepository ioRepository,
        ITestHistoryRepository testHistoryRepository,
        ICloudSyncService cloudSyncService,
        ISignalRService signalRService,
        IIoTestService ioTestService,
        ILogger<ApiController> logger)
    {
        _plcCommunication = plcCommunication;
        _configuration = configuration;
        _ioRepository = ioRepository;
        _testHistoryRepository = testHistoryRepository;
        _cloudSyncService = cloudSyncService;
        _signalRService = signalRService;
        _ioTestService = ioTestService;
        _logger = logger;
    }

    /// <summary>
    /// Get all IOs for the configured subsystem
    /// </summary>
    [HttpGet("ios")]
    public async Task<ActionResult<List<Io>>> GetIos()
    {
        try
        {
            var subsystemId = int.Parse(_configuration.SubsystemId);
            var ios = await _ioRepository.GetBySubsystemIdAsync(subsystemId);
            
            // Update states from PLC communication service
            foreach (var io in ios)
            {
                var plcIo = _plcCommunication.TagList?.FirstOrDefault(t => t.Id == io.Id);
                if (plcIo != null)
                {
                    io.State = plcIo.State;
                }
            }
            
            return Ok(ios);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting IOs");
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Get IOs for a specific subsystem
    /// </summary>
    [HttpGet("ios/subsystem/{subsystemId}")]
    public async Task<ActionResult<List<Io>>> GetIosBySubsystem(int subsystemId)
    {
        try
        {
            var ios = await _ioRepository.GetBySubsystemIdAsync(subsystemId);
            
            // Update states from PLC communication service
            foreach (var io in ios)
            {
                var plcIo = _plcCommunication.TagList?.FirstOrDefault(t => t.Id == io.Id);
                if (plcIo != null)
                {
                    io.State = plcIo.State;
                }
            }
            
            return Ok(ios);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting IOs for subsystem {SubsystemId}", subsystemId);
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Get PLC connection status and configuration
    /// </summary>
    [HttpGet("status")]
    public ActionResult<object> GetStatus()
    {
        try
        {
            return Ok(new
            {
                plcConnected = _plcCommunication.IsPlcConnected,
                plcIp = _configuration.Ip,
                plcPath = _configuration.Path,
                subsystemId = _configuration.SubsystemId,
                remoteUrl = _configuration.RemoteUrl,
                apiPassword = _configuration.ApiPassword,
                disableTesting = _configuration.DisableWatchdog,
                cloudConnected = _cloudSyncService.IsConnected,
                totalIos = _plcCommunication.TagList?.Count ?? 0,
                testingEnabled = !_configuration.DisableWatchdog,
                isTesting = _isTesting
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting status");
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Test PLC connection
    /// </summary>
    [HttpPost("plc/test-connection")]
    public async Task<ActionResult<object>> TestPlcConnection([FromBody] TestConnectionRequest request)
    {
        try
        {
            var testIp = request?.Ip ?? _configuration.Ip;
            var testPort = request?.Port ?? 44818;
            
            // For now, we'll test if the current PLC is connected
            // In a real implementation, you might want to test the specific IP/port
            var isConnected = _plcCommunication.IsPlcConnected;
            
            // Log the test attempt for debugging
            _logger.LogInformation("Testing PLC connection to {Ip}:{Port}, Current connection status: {IsConnected}", 
                testIp, testPort, isConnected);
            
            return Ok(new
            {
                success = isConnected,
                message = isConnected ? "PLC connection successful" : "PLC connection failed",
                ip = testIp,
                port = testPort,
                note = "This tests the current PLC connection. To test specific IP/port, save configuration first."
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error testing PLC connection");
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Disconnect from PLC - stops all tag reading and allows configuration changes
    /// </summary>
    [HttpPost("plc/disconnect")]
    public async Task<ActionResult<object>> DisconnectPlc()
    {
        try
        {
            _logger.LogInformation("Received PLC disconnect request from UI");
            await _plcCommunication.DisconnectPlcAsync();

            return Ok(new
            {
                success = true,
                message = "PLC disconnected successfully. You can now change configuration."
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error disconnecting from PLC");
            return StatusCode(500, new { success = false, message = ex.Message });
        }
    }

    /// <summary>
    /// Mark an IO as passed
    /// </summary>
    [HttpPost("ios/{id}/pass")]
    public async Task<ActionResult<object>> MarkIoPassed(int id, [FromBody] TestResultRequest request)
    {
        try
        {
            var io = await _ioRepository.GetByIdAsync(id);
            if (io == null)
            {
                return NotFound($"IO with ID {id} not found");
            }

            // Preserve old comment for history before clearing
            var oldComment = io.Comments;
            
            io.Result = "Passed";
            io.Timestamp = DateTime.UtcNow.ToString("MM/dd/yy h:mm:ss.fff tt");
            // Clear comments when passing (unless explicitly provided)
            io.Comments = request?.Comments ?? null;

            await _ioRepository.UpdateAsync(io);
            await _ioRepository.SaveChangesAsync();

            // Add test history - preserve old comment in history even though we cleared it on IO
            var testHistory = new TestHistory
            {
                IoId = id,
                Result = "Passed",
                Timestamp = io.Timestamp,
                Comments = oldComment, // Preserve the old comment in history, even if cleared on IO
                State = io.State,
                TestedBy = request?.CurrentUser ?? "Unknown"
            };
            await _testHistoryRepository.AddAsync(testHistory);
            await _testHistoryRepository.SaveChangesAsync();

            // Refresh the TagList in PlcCommunicationService to reflect database changes
            await _plcCommunication.RefreshTagListFromDatabaseAsync();

            // Send SignalR update to frontend
            _logger.LogInformation("API: About to send IO update - ID: {Id}, Result: {Result}, State: {State}", io.Id, io.Result, io.State);
            await _signalRService.SendIOUpdateAsync(io);

            return Ok(new { success = true, message = "IO marked as passed" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error marking IO {Id} as passed", id);
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Mark an IO as failed
    /// </summary>
    [HttpPost("ios/{id}/fail")]
    public async Task<ActionResult<object>> MarkIoFailed(int id, [FromBody] TestResultRequest request)
    {
        try
        {
            var io = await _ioRepository.GetByIdAsync(id);
            if (io == null)
            {
                return NotFound($"IO with ID {id} not found");
            }

            io.Result = "Failed";
            io.Timestamp = DateTime.UtcNow.ToString("MM/dd/yy h:mm:ss.fff tt");
            io.Comments = request?.Comments ?? io.Comments;

            await _ioRepository.UpdateAsync(io);
            await _ioRepository.SaveChangesAsync();

            // Add test history
            var testHistory = new TestHistory
            {
                IoId = id,
                Result = "Failed",
                Timestamp = io.Timestamp,
                Comments = io.Comments,
                State = io.State,
                TestedBy = request?.CurrentUser ?? "Unknown",
                FailureMode = request?.FailureMode
            };
            await _testHistoryRepository.AddAsync(testHistory);
            await _testHistoryRepository.SaveChangesAsync();

            // Refresh the TagList in PlcCommunicationService to reflect database changes
            await _plcCommunication.RefreshTagListFromDatabaseAsync();

            // Send SignalR update to frontend
            _logger.LogInformation("API: About to send IO update - ID: {Id}, Result: {Result}, State: {State}", io.Id, io.Result, io.State);
            await _signalRService.SendIOUpdateAsync(io);

            return Ok(new { success = true, message = "IO marked as failed" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error marking IO {Id} as failed", id);
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Clear test result for an IO
    /// </summary>
    [HttpPost("ios/{id}/clear")]
    public async Task<ActionResult<object>> ClearIoResult(int id, [FromBody] TestResultRequest? request)
    {
        try
        {
            var io = await _ioRepository.GetByIdAsync(id);
            if (io == null)
            {
                return NotFound($"IO with ID {id} not found");
            }

            // Store the old values BEFORE clearing - preserve actual comment for history
            var hadComments = !string.IsNullOrEmpty(io.Comments);
            var hadResult = !string.IsNullOrEmpty(io.Result);
            var originalComment = io.Comments; // Preserve the actual comment
            var originalResult = io.Result; // Preserve the actual result
            
            // Add history if there were comments or a previous result - preserve actual comment
            if (hadComments || hadResult)
            {
                // Use the actual comment if it exists, otherwise create a descriptive message
                string? historyComment;
                if (hadComments)
                {
                    // Preserve the actual comment that was there
                    historyComment = originalComment;
                }
                else if (hadResult)
                {
                    // No comment but had result - describe what was cleared
                    historyComment = $"Cleared {originalResult} result";
                }
                else
                {
                    historyComment = "Cleared comments";
                }
                
                // Add test history with "Cleared" result, preserving actual comment
                var testHistory = new TestHistory
                {
                    IoId = id,
                    Result = "Cleared",
                    Timestamp = DateTime.UtcNow.ToString("MM/dd/yy h:mm:ss.fff tt"),
                    Comments = historyComment, // Preserve actual comment instead of generic message
                    State = io.State,
                    TestedBy = request?.CurrentUser ?? "Unknown"
                };
                await _testHistoryRepository.AddAsync(testHistory);
                await _testHistoryRepository.SaveChangesAsync();
            }

            // Clear the IO result
            io.Result = null;
            io.Timestamp = null;
            io.Comments = null;

            await _ioRepository.UpdateAsync(io);
            await _ioRepository.SaveChangesAsync();

            // Sync cleared result to cloud - send null Result/Comments to actually clear on cloud
            if (hadComments || hadResult)
            {
                var history = await _testHistoryRepository.GetByIoIdAsync(id);
                var testedBy = history.OrderByDescending(h => h.Timestamp).FirstOrDefault()?.TestedBy ?? request?.CurrentUser ?? "Unknown";
                
                var cloudUpdate = new IoUpdateDto
                {
                    Id = io.Id,
                    Result = null, // Send null to clear on cloud
                    Timestamp = null, // Send null to clear on cloud
                    Comments = null, // Send null to clear on cloud
                    TestedBy = testedBy,
                    State = io.State,
                    Version = io.Version
                };
                
                // Don't await - let it run in background
                _ = _cloudSyncService.SyncIoUpdateAsync(cloudUpdate).ContinueWith(task =>
                {
                    if (!task.Result)
                    {
                        _logger.LogWarning("Failed to sync cleared IO {IoId} to cloud (will retry from queue)", io.Id);
                    }
                }, TaskContinuationOptions.OnlyOnRanToCompletion);
            }

            // Refresh the TagList in PlcCommunicationService to reflect database changes
            await _plcCommunication.RefreshTagListFromDatabaseAsync();

            // Send SignalR update to frontend
            _logger.LogInformation("API: About to send IO update - ID: {Id}, Result: {Result}, State: {State}", io.Id, io.Result, io.State);
            await _signalRService.SendIOUpdateAsync(io);

            return Ok(new { success = true, message = "IO result cleared" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error clearing IO {Id}", id);
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Toggle testing mode - broadcasts to all connected clients via SignalR
    /// </summary>
    [HttpPost("testing/toggle")]
    public async Task<ActionResult<object>> ToggleTesting()
    {
        try
        {
            // Toggle the testing state
            _isTesting = !_isTesting;

            _logger.LogInformation("Testing mode toggled to: {IsTesting}", _isTesting);

            // Broadcast to all connected clients so they see the state change immediately
            await _signalRService.BroadcastTestingStateChanged(_isTesting);

            return Ok(new {
                success = true,
                message = "Testing mode toggled",
                isTesting = _isTesting
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error toggling testing mode");
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Update comment for an IO (can be used anytime, not just on fail)
    /// </summary>
    [HttpPost("ios/{id}/comment")]
    public async Task<ActionResult<object>> UpdateIoComment(int id, [FromBody] UpdateCommentRequest request)
    {
        try
        {
            var io = await _ioRepository.GetByIdAsync(id);
            if (io == null)
            {
                return NotFound($"IO with ID {id} not found");
            }

            // Get current state from PLC communication service
            var plcIo = _plcCommunication.TagList?.FirstOrDefault(t => t.Id == io.Id);
            if (plcIo != null)
            {
                io.State = plcIo.State;
            }

            // Use IoTestService to update comment - this handles:
            // 1. Local database update
            // 2. Test history recording
            // 3. Cloud sync to PostgreSQL
            var result = await _ioTestService.UpdateCommentAsync(io, request.Comments ?? "");

            if (!result.Success)
            {
                _logger.LogWarning("Failed to update comment for IO {Id}: {Error}", id, result.ErrorMessage);
                return BadRequest(new { success = false, error = result.ErrorMessage });
            }

            _logger.LogInformation("Comment updated for IO {Id}: {Comments} (changes made: {ChangesMade})",
                id, request.Comments, result.ChangesWereMade);

            // Broadcast comment update to all connected clients
            await _signalRService.BroadcastCommentUpdate(id, request.Comments);

            return Ok(new
            {
                success = true,
                message = result.ChangesWereMade ? "Comment updated and synced to cloud" : "No changes needed",
                id = io.Id,
                comments = request.Comments,
                synced = result.ChangesWereMade
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error updating comment for IO {Id}", id);
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Get test history for an IO
    /// </summary>
    [HttpGet("ios/{id}/history")]
    public async Task<ActionResult<List<TestHistory>>> GetIoHistory(int id)
    {
        try
        {
            var history = await _testHistoryRepository.GetByIoIdAsync(id);
            return Ok(history);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting history for IO {Id}", id);
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Get all test history
    /// </summary>
    [HttpGet("history")]
    public async Task<ActionResult<List<TestHistory>>> GetAllHistory()
    {
        try
        {
            var history = await _testHistoryRepository.GetAllAsync();
            return Ok(history);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting all history");
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Fire output (start/stop) - matches C# app behavior
    /// </summary>
    [HttpPost("ios/{id}/fire-output")]
    public async Task<ActionResult<object>> FireOutput(int id, [FromBody] FireOutputRequest request)
    {
        try
        {
            var io = await _ioRepository.GetByIdAsync(id);
            if (io == null)
            {
                return NotFound($"IO with ID {id} not found");
            }

            // Check if this is an output IO
            if (!io.Name?.Contains(":O.") == true)
            {
                return BadRequest("This IO is not an output");
            }

            // Find the actual tag in the TagList (same as C# app)
            var actualTag = _plcCommunication.TagList.FirstOrDefault(t => t.Name == io.Name);
            if (actualTag == null)
            {
                return BadRequest("Output tag not found in PLC communication service");
            }

            // Initialize the output tag for writing (same as C# app)
            _plcCommunication.InitializeOutputTag(actualTag);

            if (request.Action == "start")
            {
                // Fire the output ON (same as C# app's FireDown)
                _plcCommunication.ToggleBit();
                _logger.LogInformation("Output {IoName} fired ON", io.Name);
            }
            else if (request.Action == "stop")
            {
                // Fire the output OFF (same as C# app's FireUp)
                _plcCommunication.ToggleBit();
                _logger.LogInformation("Output {IoName} fired OFF", io.Name);
                
                // After stopping the output, trigger the ValueChanged flow (same as C# app)
                // This will show the Pass/Fail dialog for output testing
                await Task.Delay(250); // Same delay as C# app (TestConstants.UI_DELAY_MS)
                
                // Trigger the value changed event for the output
                // This simulates what happens in C# app's FireUp method
                await TriggerOutputValueChangedAsync(actualTag);
            }

            return Ok(new { message = $"Output {request.Action} command executed" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error firing output for ID {Id}", id);
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Upload local test data to remote cloud - only uploads changed IOs to prevent duplicates
    /// </summary>
    [HttpPost("cloud/sync")]
    public async Task<ActionResult<object>> UploadToCloud()
    {
        try
        {
            if (!_cloudSyncService.IsConnected)
            {
                return BadRequest(new { success = false, message = "Cloud not connected" });
            }

            var subsystemId = int.Parse(_configuration.SubsystemId);
            _logger.LogInformation("Uploading local test data to cloud for subsystem {SubsystemId}", subsystemId);

            // Get all local IOs with test results
            var localIos = await _ioRepository.GetBySubsystemIdAsync(subsystemId);
            var testResults = localIos.Where(io => !string.IsNullOrEmpty(io.Result) || !string.IsNullOrEmpty(io.Comments)).ToList();

            if (!testResults.Any())
            {
                return Ok(new {
                    success = true,
                    message = "No test results to upload",
                    subsystemId = subsystemId,
                    uploadedCount = 0,
                    skippedCount = 0
                });
            }

            // Filter to only IOs that have changed since last sync
            // An IO needs syncing if:
            // 1. It has never been synced (CloudSyncedAt is null), OR
            // 2. It was modified after the last sync (Timestamp > CloudSyncedAt)
            var needsSync = testResults.Where(io =>
            {
                // Never synced before
                if (!io.CloudSyncedAt.HasValue)
                    return true;

                // Check if modified since last sync
                if (!string.IsNullOrEmpty(io.Timestamp))
                {
                    if (DateTime.TryParse(io.Timestamp, out var ioTimestamp))
                    {
                        return ioTimestamp > io.CloudSyncedAt.Value;
                    }
                }

                return false;
            }).ToList();

            var skippedCount = testResults.Count - needsSync.Count;

            if (!needsSync.Any())
            {
                _logger.LogInformation("All {TotalCount} test results already synced - nothing new to upload", testResults.Count);
                return Ok(new {
                    success = true,
                    message = $"All test results already synced to cloud (checked {testResults.Count} IOs)",
                    subsystemId = subsystemId,
                    uploadedCount = 0,
                    skippedCount = skippedCount
                });
            }

            _logger.LogInformation("Found {NeedsSyncCount} IOs to sync, {SkippedCount} already synced", needsSync.Count, skippedCount);

            // Upload test results to cloud - get TestedBy from most recent TestHistory
            var updates = new List<IoUpdateDto>();
            foreach (var io in needsSync)
            {
                if (io.Id <= 0) continue; // Skip if ID is invalid

                // Get the most recent test history for this IO to get the TestedBy field
                var history = await _testHistoryRepository.GetByIoIdAsync(io.Id, limit: 1);
                var testedBy = history.FirstOrDefault()?.TestedBy ?? "Unknown";

                updates.Add(new IoUpdateDto
                {
                    Id = io.Id,
                    Result = io.Result ?? "Not Tested",
                    Comments = io.Comments ?? "",
                    State = io.State ?? "FALSE",
                    Timestamp = io.Timestamp ?? DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm:ss"),
                    TestedBy = testedBy,
                    Version = io.Version
                });
            }

            var uploadSuccess = await _cloudSyncService.SyncIoUpdatesAsync(updates);

            if (uploadSuccess)
            {
                // Mark these IOs as synced to prevent duplicate uploads
                var syncTime = DateTime.UtcNow;
                foreach (var io in needsSync)
                {
                    io.CloudSyncedAt = syncTime;
                    await _ioRepository.UpdateAsync(io);
                }
                await _ioRepository.SaveChangesAsync();

                _logger.LogInformation("Successfully uploaded {Count} test results to cloud for subsystem {SubsystemId}", needsSync.Count, subsystemId);

                return Ok(new {
                    success = true,
                    message = $"Successfully uploaded {needsSync.Count} test results to cloud",
                    subsystemId = subsystemId,
                    uploadedCount = needsSync.Count,
                    skippedCount = skippedCount
                });
            }
            else
            {
                _logger.LogWarning("Failed to upload test results to cloud for subsystem {SubsystemId}", subsystemId);
                return StatusCode(500, new {
                    success = false,
                    message = "Failed to upload test results to cloud"
                });
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error uploading to cloud");
            return StatusCode(500, new {
                success = false,
                message = "Internal server error during upload"
            });
        }
    }

    /// <summary>
    /// Trigger value changed event for output testing (matches C# app behavior)
    /// </summary>
    private async Task TriggerOutputValueChangedAsync(Io outputTag)
    {
        try
        {
            // This simulates the C# app's ValueChanged flow after output firing
            // The output should trigger a Pass/Fail dialog for testing
            
            // Create a temporary IO object with "Not Tested" result to trigger the dialog
            // Even if the IO already has a result, we want to trigger the dialog for testing
            var triggerIo = new Io
            {
                Id = outputTag.Id,
                Name = outputTag.Name,
                Result = null, // Set to null so SignalR will send "Not Tested"
                State = outputTag.State ?? "FALSE",
                Timestamp = null, // No timestamp so frontend knows this is a trigger
                Comments = null // No comments so frontend knows this is a trigger
            };

            await _signalRService.SendIOUpdateAsync(triggerIo);
            _logger.LogInformation("Triggered output value changed for {TagName}", outputTag.Name);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error triggering output value changed for {TagName}", outputTag.Name);
        }
    }
}

public class TestConnectionRequest
{
    public string? Ip { get; set; }
    public int Port { get; set; } = 44818;
}

public class TestResultRequest
{
    public string? Comments { get; set; }
    public string? CurrentUser { get; set; }
    public string? FailureMode { get; set; }
}

public class FireOutputRequest
{
    public string Action { get; set; } = string.Empty; // "start" or "stop"
}

public class UpdateCommentRequest
{
    public string? Comments { get; set; }
}
