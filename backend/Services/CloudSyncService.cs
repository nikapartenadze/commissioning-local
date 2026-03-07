using System.Net.Http.Json;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Models.Configuration;
using Shared.Library.DTOs;
using Shared.Library.Models.Entities;
using Microsoft.Extensions.Options;

namespace IO_Checkout_Tool.Services;

public class CloudSyncService : ICloudSyncService
{
    private readonly HttpClient _httpClient;
    private readonly IOptions<ConfigurationSettings> _config;
    private readonly ILogger<CloudSyncService> _logger;
    private readonly IErrorDialogService _errorDialogService;
    private string? _cloudUrl;

    // This is a simple HTTP-only implementation, so always "connected" if cloud URL is configured
    public bool IsConnected => !string.IsNullOrEmpty(_cloudUrl);
    public event Action? ConnectionStateChanged;

    public CloudSyncService(
        HttpClient httpClient,
        IOptions<ConfigurationSettings> config,
        ILogger<CloudSyncService> logger,
        IErrorDialogService errorDialogService)
    {
        _httpClient = httpClient;
        _config = config;
        _logger = logger;
        _errorDialogService = errorDialogService;
        _cloudUrl = _config.Value.RemoteUrl;
    }

    public async Task<List<Io>> GetSubsystemIosAsync(int subsystemId)
    {
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

    public Task<bool> SyncTestHistoriesAsync(int subsystemId, List<TestHistoryDto> histories)
    {
        _logger.LogDebug("SyncTestHistoriesAsync not implemented in CloudSyncService - use ResilientCloudSyncService");
        return Task.FromResult(false);
    }

    public async Task<bool> TriggerFreshSyncAsync(bool skipPlcInitialization = false)
    {
        _logger.LogInformation("TriggerFreshSyncAsync not fully implemented in CloudSyncService - use ResilientCloudSyncService for full functionality");
        
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

    public async Task<bool> SyncIoUpdateAsync(IoUpdateDto update)
    {
        if (string.IsNullOrEmpty(_cloudUrl))
        {
            _logger.LogWarning("Cloud URL not configured");
            return false;
        }

        try
        {
            var batch = new IoSyncBatchDto { Updates = new List<IoUpdateDto> { update } };
            
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
            
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error syncing IO update");
            return false;
        }
    }

    public async Task<bool> SyncIoUpdatesAsync(List<IoUpdateDto> updates)
    {
        if (string.IsNullOrEmpty(_cloudUrl))
        {
            _logger.LogWarning("Cloud URL not configured");
            return false;
        }

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
            
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error syncing IO updates");
            return false;
        }
    }

    public async Task<bool> IsCloudAvailable()
    {
        if (string.IsNullOrEmpty(_cloudUrl))
        {
            return false;
        }

        try
        {
            // Health endpoint doesn't require API key
            var response = await _httpClient.GetAsync($"{_cloudUrl}/api/sync/health");
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
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