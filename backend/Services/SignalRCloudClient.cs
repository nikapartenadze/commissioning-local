using Microsoft.AspNetCore.SignalR.Client;
using IO_Checkout_Tool.Services.Interfaces;
using Microsoft.Extensions.Logging;

namespace IO_Checkout_Tool.Services;

/// <summary>
/// Production implementation of ISignalRCloudClient that wraps HubConnection
/// </summary>
public class SignalRCloudClient : ISignalRCloudClient, IAsyncDisposable
{
    private readonly ILogger<SignalRCloudClient> _logger;
    private HubConnection? _hubConnection;
    private bool _isConnected;

    public SignalRCloudClient(ILogger<SignalRCloudClient> logger)
    {
        _logger = logger;
    }

    public bool IsConnected => _isConnected && _hubConnection?.State == HubConnectionState.Connected;

    public HubConnectionState State => _hubConnection?.State ?? HubConnectionState.Disconnected;

    public event Action? ConnectionStateChanged;

    public async Task<bool> ConnectAsync(string url, string? apiKey, CancellationToken cancellationToken = default)
    {
        try
        {
            // If already connected, return true
            if (_hubConnection?.State == HubConnectionState.Connected)
            {
                if (!_isConnected)
                {
                    _isConnected = true;
                    ConnectionStateChanged?.Invoke();
                }
                return true;
            }

            // Build SignalR URL with API key as query parameter
            var hubUrl = string.IsNullOrEmpty(apiKey)
                ? $"{url}/syncHub"
                : $"{url}/syncHub?apiKey={Uri.EscapeDataString(apiKey)}";

            _logger.LogInformation("Creating SignalR connection to {HubUrl} with API key: {HasApiKey}",
                $"{url}/syncHub", !string.IsNullOrEmpty(apiKey) ? "PROVIDED" : "MISSING");

            // Dispose existing connection if any
            if (_hubConnection != null)
            {
                await _hubConnection.DisposeAsync();
            }

            _hubConnection = new HubConnectionBuilder()
                .WithUrl(hubUrl)
                .WithAutomaticReconnect(new[] {
                    TimeSpan.Zero,              // Immediate retry
                    TimeSpan.FromSeconds(2),    // Quick retry for brief interruptions
                    TimeSpan.FromSeconds(5),    // Short delay
                    TimeSpan.FromSeconds(15),   // Increased for network issues
                    TimeSpan.FromSeconds(30),   // Longer delay for persistent issues
                    TimeSpan.FromMinutes(1),    // Even longer for major outages
                    TimeSpan.FromMinutes(2)     // Max delay before giving up automatic retries
                })
                .Build();

            _hubConnection.Reconnecting += (error) =>
            {
                _isConnected = false;
                ConnectionStateChanged?.Invoke();
                _logger.LogWarning(error, "SignalR connection lost, attempting to reconnect...");
                return Task.CompletedTask;
            };

            _hubConnection.Reconnected += (connectionId) =>
            {
                _isConnected = true;
                ConnectionStateChanged?.Invoke();
                _logger.LogInformation("SignalR reconnected with connection ID: {ConnectionId}", connectionId);
                return Task.CompletedTask;
            };

            _hubConnection.Closed += (error) =>
            {
                _isConnected = false;
                ConnectionStateChanged?.Invoke();
                _logger.LogWarning(error, "SignalR connection closed");
                return Task.CompletedTask;
            };

            if (_hubConnection.State == HubConnectionState.Disconnected)
            {
                await _hubConnection.StartAsync(cancellationToken);

                _isConnected = true;
                ConnectionStateChanged?.Invoke();
                _logger.LogInformation("SignalR connection established to {Url}", url);
                return true;
            }

            _logger.LogWarning("SignalR connection in unexpected state: {State}", _hubConnection.State);
            return false;
        }
        catch (Exception ex)
        {
            _isConnected = false;
            ConnectionStateChanged?.Invoke();
            _logger.LogDebug(ex, "Failed to establish SignalR connection to {Url}", url);
            return false;
        }
    }

    public Task InvokeAsync(string methodName, params object[] args)
    {
        if (_hubConnection == null)
        {
            throw new InvalidOperationException("SignalR connection not initialized. Call ConnectAsync first.");
        }

        return _hubConnection.InvokeAsync(methodName, args);
    }

    public async Task DisconnectAsync()
    {
        if (_hubConnection != null)
        {
            _isConnected = false;
            ConnectionStateChanged?.Invoke();
            await _hubConnection.StopAsync();
            _logger.LogInformation("SignalR connection disconnected");
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_hubConnection != null)
        {
            _isConnected = false;
            ConnectionStateChanged?.Invoke();
            await _hubConnection.DisposeAsync();
            _hubConnection = null;
        }
    }
}
