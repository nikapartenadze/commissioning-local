using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface ISignalRService
{
    Task SendMessageAsync(Io tag);
    Task SendDialogCloseAsync();
    Task SendIOUpdateAsync(Io io);
    Task SendStateUpdateAsync(Io io);
} 