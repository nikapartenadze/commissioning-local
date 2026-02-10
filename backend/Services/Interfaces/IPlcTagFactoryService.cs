using IO_Checkout_Tool.Services.PlcTags;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface IPlcTagFactoryService
{
    List<NativeTag> CreateReadTags(List<Io> tags);
    NativeTag CreateReadTag(string tagName);
    NativeTag CreateWriteTag(string tagName);
    NativeTag CreateDintTag(string tagName);
} 