using Microsoft.AspNetCore.SignalR.Client;
using IO_Checkout_Tool.Services.Interfaces;

namespace IO_Checkout_Tool.Tests.TestHelpers;

/// <summary>
/// Test implementation of ISignalRCloudClient that simulates SignalR connection
/// </summary>
public class TestSignalRCloudClient : ISignalRCloudClient
{
    private readonly object _lock = new();
    private bool _isConnected;
    private HubConnectionState _state = HubConnectionState.Disconnected;
    private readonly List<SignalRInvocation> _invocations = new();
    private bool _shouldFailConnect;

    public bool IsConnected
    {
        get
        {
            lock (_lock)
            {
                return _isConnected && _state == HubConnectionState.Connected;
            }
        }
    }

    public HubConnectionState State
    {
        get
        {
            lock (_lock)
            {
                return _state;
            }
        }
    }

    public event Action? ConnectionStateChanged;

    /// <summary>
    /// Gets all recorded SignalR invocations
    /// </summary>
    public IReadOnlyList<SignalRInvocation> Invocations
    {
        get
        {
            lock (_lock)
            {
                return _invocations.ToList().AsReadOnly();
            }
        }
    }

    /// <summary>
    /// Sets whether ConnectAsync should fail
    /// </summary>
    public void SetShouldFailConnect(bool shouldFail)
    {
        lock (_lock)
        {
            _shouldFailConnect = shouldFail;
        }
    }

    /// <summary>
    /// Simulates a connection
    /// </summary>
    public void SimulateConnect()
    {
        lock (_lock)
        {
            _state = HubConnectionState.Connected;
            _isConnected = true;
        }
        ConnectionStateChanged?.Invoke();
    }

    /// <summary>
    /// Simulates a disconnection
    /// </summary>
    public void SimulateDisconnect()
    {
        lock (_lock)
        {
            _state = HubConnectionState.Disconnected;
            _isConnected = false;
        }
        ConnectionStateChanged?.Invoke();
    }

    /// <summary>
    /// Simulates a reconnection
    /// </summary>
    public void SimulateReconnect()
    {
        lock (_lock)
        {
            _state = HubConnectionState.Connected;
            _isConnected = true;
        }
        ConnectionStateChanged?.Invoke();
    }

    /// <summary>
    /// Clears all recorded invocations
    /// </summary>
    public void ClearInvocations()
    {
        lock (_lock)
        {
            _invocations.Clear();
        }
    }

    public Task<bool> ConnectAsync(string url, string? apiKey, CancellationToken cancellationToken = default)
    {
        lock (_lock)
        {
            if (_shouldFailConnect)
            {
                _state = HubConnectionState.Disconnected;
                _isConnected = false;
                ConnectionStateChanged?.Invoke();
                return Task.FromResult(false);
            }

            _state = HubConnectionState.Connected;
            _isConnected = true;
        }

        ConnectionStateChanged?.Invoke();
        return Task.FromResult(true);
    }

    public Task InvokeAsync(string methodName, object arg)
    {
        lock (_lock)
        {
            // Check if we're actually connected before allowing invocation
            if (!_isConnected || _state != HubConnectionState.Connected)
            {
                throw new InvalidOperationException($"Cannot invoke {methodName}: SignalR connection is not connected. State: {_state}");
            }
            
            _invocations.Add(new SignalRInvocation
            {
                MethodName = methodName,
                Arguments = [arg],
                Timestamp = DateTime.UtcNow
            });
        }

        // Simulate successful invocation
        return Task.CompletedTask;
    }

    public Task DisconnectAsync()
    {
        lock (_lock)
        {
            _state = HubConnectionState.Disconnected;
            _isConnected = false;
        }
        ConnectionStateChanged?.Invoke();
        return Task.CompletedTask;
    }

    public ValueTask DisposeAsync()
    {
        lock (_lock)
        {
            _state = HubConnectionState.Disconnected;
            _isConnected = false;
        }
        ConnectionStateChanged?.Invoke();
        return ValueTask.CompletedTask;
    }
}

/// <summary>
/// Represents a SignalR method invocation
/// </summary>
public class SignalRInvocation
{
    public string MethodName { get; set; } = null!;
    public object[] Arguments { get; set; } = Array.Empty<object>();
    public DateTime Timestamp { get; set; }
}
