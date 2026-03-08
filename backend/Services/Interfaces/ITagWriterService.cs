using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface ITagWriterService
{
    bool InitializeOutputTag(Io tag);
    (bool success, string? error) ToggleBit();
    (bool success, string? error) SetBit(int value);
    void Dispose();
} 