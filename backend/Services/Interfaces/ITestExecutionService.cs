using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface ITestExecutionService
{
    Task<bool> ExecuteTestAsync(Io triggeredTag, int resultCode, string swapped = "");
    Task<bool> HandleManualFailAsync(Io failTag, string comments);
    Task<bool> ClearTestResultAsync(Io tag);
    Task<Io?> UpdateNextTestTagAsync();
    Task<string?> GetFailureCommentsAsync(string? tagDescription, string? swapped = null);
} 