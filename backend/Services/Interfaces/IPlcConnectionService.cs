using IO_Checkout_Tool.Services.PlcTags;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface IPlcConnectionService
{
    Task<bool> TestNetworkConnectivityAsync(bool showErrorDialog = true);
    Task<bool> TestConnectionAsync(List<NativeTag> tags, bool showErrorDialog = true);
} 