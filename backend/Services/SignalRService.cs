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
} 