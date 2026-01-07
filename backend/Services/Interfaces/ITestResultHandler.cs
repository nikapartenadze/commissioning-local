using IO_Checkout_Tool.Models.Common;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface ITestResultHandler
{
    Task<ServiceExecutionResult> HandleAsync(Io triggeredTag, string swapped = "");
} 