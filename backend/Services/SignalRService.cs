using IO_Checkout_Tool.Services.Interfaces;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using IO_Checkout_Tool.Constants;
using Shared.Library.Models.Entities;
using Shared.Library.DTOs;

namespace IO_Checkout_Tool.Services;

public class SignalRService : ISignalRService
{
    private readonly IHubContext<IO_Checkout_Tool.Hubs.Hub> _hubContext;
    private readonly ILogger<SignalRService> _logger;

    public SignalRService(IHubContext<IO_Checkout_Tool.Hubs.Hub> hubContext, ILogger<SignalRService> logger)
    {
        _hubContext = hubContext;
        _logger = logger;
    }

    public async Task SendMessageAsync(Io tag)
    {
        try
        {
            await _hubContext.Clients.All.SendAsync(SignalRConstants.HubMethods.RECEIVE_MESSAGE, tag);
            _logger.LogDebug("SignalR: Message sent successfully for tag {TagName}", tag.Name);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SignalR: Error sending message for tag {TagName}", tag.Name);
        }
    }

    public async Task SendDialogCloseAsync()
    {
        try
        {
            await _hubContext.Clients.All.SendAsync(SignalRConstants.HubMethods.DIALOG_CLOSED);
            _logger.LogDebug("SignalR: Dialog close event sent to all clients");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SignalR: Error sending dialog close event");
        }
    }

    public async Task SendIOUpdateAsync(Io io)
    {
        try
        {
            _logger.LogDebug("SignalR: Received IO for update - ID: {Id}, Name: {Name}, Result: {Result}, State: {State}", io.Id, io.Name, io.Result, io.State);
            
            var update = new IoUpdateDto
            {
                Id = io.Id,
                Result = io.Result ?? "Not Tested",
                State = io.State ?? "FALSE", // Default to FALSE instead of UNKNOWN
                Timestamp = io.Timestamp ?? DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm:ss"),
                Comments = io.Comments ?? ""
            };

            await _hubContext.Clients.All.SendAsync("UpdateIO", update.Id, update.Result, update.State, update.Timestamp, update.Comments);
            _logger.LogDebug("SignalR: IO update sent for {TagName} - State: {State}, Result: {Result}", io.Name, update.State, update.Result);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SignalR: Error sending IO update for {TagName}", io.Name);
        }
    }

    public async Task SendStateUpdateAsync(Io io)
    {
        try
        {
            // Only send state updates, not result updates
            await _hubContext.Clients.All.SendAsync("UpdateState", io.Id, io.State ?? "FALSE");
            _logger.LogDebug("SignalR: State update sent for {TagName} - State: {State}", io.Name, io.State);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SignalR: Error sending state update for {TagName}", io.Name);
        }
    }

    public async Task BroadcastConfigurationReloading()
    {
        try
        {
            await _hubContext.Clients.All.SendAsync("ConfigurationReloading");
            _logger.LogInformation("SignalR: Broadcasted ConfigurationReloading to all clients");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SignalR: Error broadcasting ConfigurationReloading");
        }
    }

    public async Task BroadcastConfigurationReloaded()
    {
        try
        {
            await _hubContext.Clients.All.SendAsync("ConfigurationReloaded");
            _logger.LogInformation("SignalR: Broadcasted ConfigurationReloaded to all clients");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SignalR: Error broadcasting ConfigurationReloaded");
        }
    }

    public async Task BroadcastConfiguration(int backendPort, string subsystemId, string plcIp, bool cloudConnected)
    {
        try
        {
            await _hubContext.Clients.All.SendAsync("ConfigurationUpdate", backendPort, subsystemId, plcIp, cloudConnected);
            _logger.LogDebug("SignalR: Broadcasted configuration - Port: {Port}, Subsystem: {Subsystem}, PLC: {PlcIp}, Cloud: {Cloud}",
                backendPort, subsystemId, plcIp, cloudConnected);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SignalR: Error broadcasting configuration");
        }
    }

    public async Task BroadcastTestingStateChanged(bool isTesting)
    {
        try
        {
            await _hubContext.Clients.All.SendAsync("TestingStateChanged", isTesting);
            _logger.LogInformation("SignalR: Broadcasted TestingStateChanged - isTesting: {IsTesting}", isTesting);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SignalR: Error broadcasting TestingStateChanged");
        }
    }

    public async Task BroadcastCommentUpdate(int ioId, string? comments)
    {
        try
        {
            await _hubContext.Clients.All.SendAsync("CommentUpdate", ioId, comments ?? "");
            _logger.LogDebug("SignalR: Broadcasted CommentUpdate for IO {IoId}", ioId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SignalR: Error broadcasting CommentUpdate for IO {IoId}", ioId);
        }
    }

    public async Task BroadcastNetworkStatusChanged(string moduleName, string status, int errorCount)
    {
        try
        {
            await _hubContext.Clients.All.SendAsync("NetworkStatusChanged", moduleName, status, errorCount);
            _logger.LogDebug("SignalR: Broadcasted NetworkStatusChanged for module {ModuleName} - Status: {Status}, Errors: {ErrorCount}", moduleName, status, errorCount);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SignalR: Error broadcasting NetworkStatusChanged for module {ModuleName}", moduleName);
        }
    }

    public async Task BroadcastError(string source, string message, string severity = "error")
    {
        try
        {
            await _hubContext.Clients.All.SendAsync("ErrorEvent", source, message, severity);
            _logger.LogDebug("SignalR: Broadcasted ErrorEvent - Source: {Source}, Severity: {Severity}, Message: {Message}", source, severity, message);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SignalR: Error broadcasting ErrorEvent from {Source}", source);
        }
    }
} 