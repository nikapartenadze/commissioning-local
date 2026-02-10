using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.Options;
using IO_Checkout_Tool.Models.Configuration;
using IO_Checkout_Tool.Services.Interfaces;
using Shared.Library.DTOs;
using Shared.Library.Models.Entities;
using System.Net.Http.Json;

namespace IO_Checkout_Tool.Services;

public class SignalRCloudSyncService : ICloudSyncService, IAsyncDisposable
{
    private readonly HttpClient _httpClient;
    private readonly IOptions<ConfigurationSettings> _config;
    private readonly ILogger<SignalRCloudSyncService> _logger;
    private readonly IErrorDialogService _errorDialogService;
    private HubConnection? _hubConnection;
    private readonly SemaphoreSlim _connectionLock = new(1, 1);
    private string? _cloudUrl;

    public bool IsConnected => _hubConnection?.State == HubConnectionState.Connected;
    public event Action? ConnectionStateChanged;

    public SignalRCloudSyncService(
        HttpClient httpClient,
        IOptions<ConfigurationSettings> config,
        ILogger<SignalRCloudSyncService> logger,
        IErrorDialogService errorDialogService)
    {
        _httpClient = httpClient;
        _config = config;
        _logger = logger;
        _errorDialogService = errorDialogService;
        _cloudUrl = _config.Value.RemoteUrl;
    }

    private async Task<bool> EnsureConnectionAsync()
    {
        if (string.IsNullOrEmpty(_cloudUrl))
        {
            _logger.LogWarning("Cloud URL not configured");
            return false;
        }

        await _connectionLock.WaitAsync();
        try
        {
            if (_hubConnection?.State == HubConnectionState.Connected)
            {
                return true;
            }

            if (_hubConnection == null)
            {
                // Build SignalR URL with API key as query parameter
                var apiPassword = _config.Value.ApiPassword;
                var hubUrl = string.IsNullOrEmpty(apiPassword) 
                    ? $"{_cloudUrl}/syncHub"
                    : $"{_cloudUrl}/syncHub?apiKey={Uri.EscapeDataString(apiPassword)}";
                
                _logger.LogInformation("Creating SignalR connection to {HubUrl} with API key: {HasApiKey}", 
                    $"{_cloudUrl}/syncHub", !string.IsNullOrEmpty(apiPassword) ? "PROVIDED" : "MISSING");
                
                _hubConnection = new HubConnectionBuilder()
                    .WithUrl(hubUrl)
                    .WithAutomaticReconnect()
                    .Build();

                // Set up event handlers
                _hubConnection.Reconnecting += (error) =>
                {
                    ConnectionStateChanged?.Invoke();
                    _logger.LogWarning(error, "SignalR connection lost, attempting to reconnect...");
                    return Task.CompletedTask;
                };

                _hubConnection.Reconnected += (connectionId) =>
                {
                    ConnectionStateChanged?.Invoke();
                    _logger.LogInformation("SignalR reconnected with connection ID: {ConnectionId}", connectionId);
                    return Task.CompletedTask;
                };

                _hubConnection.Closed += (error) =>
                {
                    ConnectionStateChanged?.Invoke();
                    _logger.LogError(error, "SignalR connection closed");
                    return Task.CompletedTask;
                };
            }

            if (_hubConnection.State == HubConnectionState.Disconnected)
            {
                await _hubConnection.StartAsync();
                _logger.LogInformation("SignalR connection established to {Url}", $"{_cloudUrl}/syncHub");
                ConnectionStateChanged?.Invoke();
            }

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to establish SignalR connection");
            return false;
        }
        finally
        {
            _connectionLock.Release();
        }
    }

    public async Task<List<Io>> GetSubsystemIosAsync(int subsystemId)
    {
        // For fetching data, we still use HTTP as it's more appropriate for request/response
        if (string.IsNullOrEmpty(_cloudUrl))
        {
            _logger.LogWarning("Cloud URL not configured");
            return new List<Io>();
        }

        try
        {
            // Add API key header if configured
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{_cloudUrl}/api/sync/subsystem/{subsystemId}");
            AddApiKeyHeader(request);
            
            var response = await _httpClient.SendAsync(request);
            
            // Check for authentication errors
            if (HandleAuthenticationError(response))
            {
                return new List<Io>();
            }
            
            if (response.IsSuccessStatusCode)
            {
                var syncResponse = await response.Content.ReadFromJsonAsync<SyncResponseDto>();
                return syncResponse?.Ios ?? new List<Io>();
            }
            
            _logger.LogError("Failed to get IOs from cloud: {StatusCode}", response.StatusCode);
            return new List<Io>();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting IOs from cloud");
            return new List<Io>();
        }
    }

    public async Task<bool> SyncIoUpdateAsync(IoUpdateDto update)
    {
        if (!await EnsureConnectionAsync())
        {
            _logger.LogWarning("SignalR connection not available, falling back to HTTP");
            return await SyncViaHttpAsync(new List<IoUpdateDto> { update });
        }

        try
        {
            await _hubConnection!.InvokeAsync("UpdateIO", update);
            _logger.LogInformation("Successfully synced IO update via SignalR: {Id}", update.Id);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error syncing IO update via SignalR, falling back to HTTP");
            return await SyncViaHttpAsync(new List<IoUpdateDto> { update });
        }
    }

    public async Task<bool> SyncIoUpdatesAsync(List<IoUpdateDto> updates)
    {
        if (!await EnsureConnectionAsync())
        {
            _logger.LogWarning("SignalR connection not available, falling back to HTTP");
            return await SyncViaHttpAsync(updates);
        }

        try
        {
            await _hubConnection!.InvokeAsync("SyncMultipleIOs", updates);
            _logger.LogInformation("Successfully synced {Count} IO updates via SignalR", updates.Count);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error syncing IO updates via SignalR, falling back to HTTP");
            return await SyncViaHttpAsync(updates);
        }
    }

    public Task<bool> SyncTestHistoriesAsync(int subsystemId, List<TestHistoryDto> histories)
    {
        _logger.LogDebug("SyncTestHistoriesAsync not implemented in SignalRCloudSyncService - use ResilientCloudSyncService");
        return Task.FromResult(false);
    }

    public async Task<bool> TriggerFreshSyncAsync()
    {
        _logger.LogInformation("TriggerFreshSyncAsync not fully implemented in SignalRCloudSyncService - use ResilientCloudSyncService for full functionality");
        
        // Basic implementation - just fetch data, no local sync
        try
        {
            var subsystemId = int.Parse(_config.Value.SubsystemId);
            var cloudIos = await GetSubsystemIosAsync(subsystemId);
            return cloudIos.Any();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in TriggerFreshSyncAsync");
            return false;
        }
    }

    private async Task<bool> SyncViaHttpAsync(List<IoUpdateDto> updates)
    {
        try
        {
            var batch = new IoSyncBatchDto { Updates = updates };
            
            // Add API key header if configured
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{_cloudUrl}/api/sync/update");
            request.Content = JsonContent.Create(batch);
            AddApiKeyHeader(request);
            
            var response = await _httpClient.SendAsync(request);
            
            // Check for authentication errors
            if (HandleAuthenticationError(response))
            {
                return false;
            }
            
            if (response.IsSuccessStatusCode)
            {
                _logger.LogInformation("Successfully synced {Count} IO updates via HTTP fallback", updates.Count);
                return true;
            }
            
            _logger.LogError("Failed to sync IO updates via HTTP: {StatusCode}", response.StatusCode);
            return false;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error syncing IO updates via HTTP");
            return false;
        }
    }

    public async Task<bool> IsCloudAvailable()
    {
        // First try SignalR connection
        if (await EnsureConnectionAsync())
        {
            return true;
        }

        // Fall back to HTTP health check
        if (string.IsNullOrEmpty(_cloudUrl))
        {
            return false;
        }

        try
        {
            var response = await _httpClient.GetAsync($"{_cloudUrl}/api/sync/health");
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_hubConnection != null)
        {
            await _hubConnection.DisposeAsync();
        }
        _connectionLock?.Dispose();
    }

    private void AddApiKeyHeader(HttpRequestMessage request)
    {
        var apiPassword = _config.Value.ApiPassword;
        if (!string.IsNullOrEmpty(apiPassword))
        {
            request.Headers.Add("X-API-Key", apiPassword);
        }
    }

    private bool HandleAuthenticationError(HttpResponseMessage response)
    {
        if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
        {
            _logger.LogError("Authentication failed - invalid API password");
            _errorDialogService.ShowAuthenticationError();
            return true;
        }
        return false;
    }
} 