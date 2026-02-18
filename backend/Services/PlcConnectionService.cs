using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Logging;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Services.PlcTags;
using IO_Checkout_Tool.Services.PlcTags.Native;
using IO_Checkout_Tool.Constants;

namespace IO_Checkout_Tool.Services;

public class PlcConnectionService : IPlcConnectionService
{
    private readonly IConfigurationService _configService;
    private readonly IErrorDialogService _errorDialogService;
    private readonly ISignalRService _signalRService;
    private readonly ILogger<PlcConnectionService> _logger;

    public PlcConnectionService(
        IConfigurationService configService,
        IErrorDialogService errorDialogService,
        ISignalRService signalRService,
        ILogger<PlcConnectionService> logger)
    {
        _configService = configService;
        _errorDialogService = errorDialogService;
        _signalRService = signalRService;
        _logger = logger;
    }

    public async Task<bool> TestNetworkConnectivityAsync(bool showErrorDialog = true)
    {
        const int ethernetIpPort = 44818; // Standard Ethernet/IP port
        const int timeoutMs = 5000; // 5 second timeout

        if (string.IsNullOrEmpty(_configService.Ip))
        {
            _logger.LogError("PLC IP address is not configured");
            _ = _signalRService.BroadcastError("plc", "PLC IP address is not configured", "error");
            if (showErrorDialog)
            {
                _errorDialogService.ShowError("Configuration Error",
                    "<p><strong>PLC IP address is not configured.</strong></p>" +
                    "<br/>" +
                    "<p>Please check your configuration settings and ensure a valid IP address is provided.</p>");
            }
            return false;
        }

        try
        {
            _logger.LogInformation("Testing network connectivity to PLC at {IpAddress}:{Port}", _configService.Ip, ethernetIpPort);
            
            using var tcpClient = new TcpClient();
            var connectTask = tcpClient.ConnectAsync(_configService.Ip, ethernetIpPort);
            
            if (await Task.WhenAny(connectTask, Task.Delay(timeoutMs)) == connectTask)
            {
                await connectTask; // This will throw if connection failed
                _logger.LogInformation("Network connectivity test successful - PLC is reachable at {IpAddress}:{Port}", _configService.Ip, ethernetIpPort);
                return true;
            }
            else
            {
                _logger.LogError("Network connectivity test timed out after {TimeoutMs}ms - PLC not reachable at {IpAddress}:{Port}", timeoutMs, _configService.Ip, ethernetIpPort);
                _ = _signalRService.BroadcastError("plc", $"PLC not reachable at {_configService.Ip} — connection timed out", "error");
                if (showErrorDialog)
                {
                    var localIp = GetLocalIpAddress();
                    _errorDialogService.ShowError("Network Connection Failed", 
                        $"<p><strong>Unable to establish network connection to PLC.</strong></p>" +
                        $"<br/>" +
                        $"<p><strong>Connection Details:</strong></p>" +
                        $"<ul>" +
                        $"<li><strong>Local IP:</strong> {localIp}</li>" +
                        $"<li><strong>PLC IP:</strong> {_configService.Ip}</li>" +
                        $"<li><strong>Port:</strong> {ethernetIpPort} (Ethernet/IP)</li>" +
                        $"</ul>" +
                        $"<br/>" +
                        $"<p><strong>Please verify:</strong></p>" +
                        $"<ul>" +
                        $"<li>PLC is powered on and connected to network</li>" +
                        $"<li>IP address <strong>{_configService.Ip}</strong> is correct</li>" +
                        $"<li>Network connectivity between the server and PLC</li>" +
                        $"<li>No firewall blocking port <strong>{ethernetIpPort}</strong></li>" +
                        $"</ul>");
                }
                return false;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Network connectivity test failed with exception - PLC not reachable at {IpAddress}:{Port}", _configService.Ip, ethernetIpPort);
            _ = _signalRService.BroadcastError("plc", $"PLC network error at {_configService.Ip}: {ex.Message}", "error");

            if (showErrorDialog)
            {
                var localIp = GetLocalIpAddress();
                var errorMessage = ex.Message;
                
                // Provide more specific error messages for common cases
                if (ex is SocketException socketEx)
                {
                    errorMessage = socketEx.SocketErrorCode switch
                    {
                        SocketError.HostUnreachable => "Host unreachable - check network routing",
                        SocketError.NetworkUnreachable => "Network unreachable - check network configuration", 
                        SocketError.ConnectionRefused => "Connection refused - PLC may not be accepting connections",
                        SocketError.TimedOut => "Connection timed out - PLC not responding",
                        _ => $"Network error: {socketEx.SocketErrorCode}"
                    };
                }
                
                _errorDialogService.ShowError("Network Connection Failed", 
                    $"<p><strong>Unable to establish network connection to PLC.</strong></p>" +
                    $"<br/>" +
                    $"<p><strong>Connection Details:</strong></p>" +
                    $"<ul>" +
                    $"<li><strong>Local IP:</strong> {localIp}</li>" +
                    $"<li><strong>PLC IP:</strong> {_configService.Ip}</li>" +
                    $"<li><strong>Port:</strong> {ethernetIpPort} (Ethernet/IP)</li>" +
                    $"<li><strong>Error:</strong> <span style='color: #d32f2f;'>{errorMessage}</span></li>" +
                    $"</ul>" +
                    $"<br/>" +
                    $"<p><strong>Please verify:</strong></p>" +
                    $"<ul>" +
                    $"<li>PLC is powered on and connected to network</li>" +
                    $"<li>IP address <strong>{_configService.Ip}</strong> is correct</li>" +
                                         $"<li>Network connectivity between the server and PLC</li>" +
                    $"<li>No firewall blocking port <strong>{ethernetIpPort}</strong></li>" +
                    $"</ul>");
            }
            
            return false;
        }
    }

    public async Task<bool> TestConnectionAsync(List<NativeTag> tags, bool showErrorDialog = true)
    {
        if (!tags.Any())
        {
            _logger.LogWarning("No tags available for PLC connection test");
            if (showErrorDialog)
            {
                _errorDialogService.ShowError("No IO Tags Available", 
                    "No IO tags are available to test PLC communication. " +
                    "Please ensure the application has synced with the cloud server and IO definitions are available.");
            }
            return false;
        }

        try
        {
            var testTag = tags.First();
            
            // Initialize the tag if not already initialized
            if (testTag.Initialize() != LibPlcTag.PLCTAG_STATUS_OK)
            {
                _logger.LogError("Failed to initialize test tag");
                if (showErrorDialog)
                {
                    var ipv4Address = GetLocalIpAddress();
                    _errorDialogService.ShowCommunicationError(
                        ipv4Address.ToString(), 
                        _configService.Ip, 
                        _configService.Path);
                }
                return false;
            }
            
            // Try to read the tag
            var status = testTag.Read();
            
            if (status == LibPlcTag.PLCTAG_STATUS_OK)
            {
                _logger.LogInformation("Connection test successful");
                return true;
            }
            else if (status == LibPlcTag.PLCTAG_ERR_TIMEOUT)
            {
                if (showErrorDialog)
                {
                    var ipv4Address = GetLocalIpAddress();
                    _errorDialogService.ShowCommunicationError(
                        ipv4Address.ToString(), 
                        _configService.Ip, 
                        _configService.Path);
                }
                return false;
            }
            else
            {
                _logger.LogWarning("Connection test failed with status: {Status}", LibPlcTag.DecodeError(status));
                if (showErrorDialog)
                {
                    var ipv4Address = GetLocalIpAddress();
                    _errorDialogService.ShowCommunicationError(
                        ipv4Address.ToString(), 
                        _configService.Ip, 
                        _configService.Path);
                }
                return false;
            }
        }
        catch (Exception e)
        {
            _logger.LogError(e, "Exception during connection test");
            
            // Show error dialog for any communication exception
            if (showErrorDialog)
            {
                var ipv4Address = GetLocalIpAddress();
                _errorDialogService.ShowCommunicationError(
                    ipv4Address.ToString(), 
                    _configService.Ip, 
                    _configService.Path);
            }
            
            return false;
        }
    }

    private IPAddress GetLocalIpAddress()
    {
        string hostName = Dns.GetHostName();
        IPHostEntry ipEntry = Dns.GetHostEntry(hostName);
        IPAddress[] ipAddress = ipEntry.AddressList;
        return ipAddress.FirstOrDefault(ip => ip.AddressFamily == AddressFamily.InterNetwork)!;
    }
} 