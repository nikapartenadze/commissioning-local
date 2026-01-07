using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface ITagWriterService
{
    void InitializeOutputTag(Io tag);
    void ToggleBit();
    void Dispose();
} 