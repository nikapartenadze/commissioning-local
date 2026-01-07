using IO_Checkout_Tool.Constants;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Services.Common;
using Shared.Library.Models.Entities;
using IO_Checkout_Tool.Models.Common;
using Microsoft.Extensions.Logging;

namespace IO_Checkout_Tool.Services;

public class TestExecutionService : ITestExecutionService
{
    private readonly IIoTestService _ioTestService;
    private readonly IAppStateService _appStateService;
    private readonly IPlcCommunicationService _plcCommunicationService;
    private readonly IDialogManagerService _dialogManager;
    private readonly IErrorHandlingService _errorHandlingService;
    private readonly ILogger<TestExecutionService> _logger;

    public TestExecutionService(
        IIoTestService ioTestService,
        IAppStateService appStateService,
        IPlcCommunicationService plcCommunicationService,
        IDialogManagerService dialogManager,
        IErrorHandlingService errorHandlingService,
        ILogger<TestExecutionService> logger)
    {
        _ioTestService = ioTestService;
        _appStateService = appStateService;
        _plcCommunicationService = plcCommunicationService;
        _dialogManager = dialogManager;
        _errorHandlingService = errorHandlingService;
        _logger = logger;
    }

    public async Task<bool> ExecuteTestAsync(Io triggeredTag, int resultCode, string swapped = "")
    {
        var result = await _errorHandlingService.ExecuteWithErrorHandlingAsync(async () =>
        {
            _logger.LogInformation("Executing test for tag {TagName} with result code {ResultCode}", 
                triggeredTag.Name, resultCode);

            var executionResult = resultCode switch
            {
                TestConstants.ResultCodes.TEST_PASSED => await HandleTestPassedAsync(triggeredTag, swapped),
                TestConstants.ResultCodes.TEST_FAILED => await HandleTestFailedAsync(triggeredTag, swapped),
                TestConstants.ResultCodes.TEST_CLEARED => await HandleTestClearedAsync(triggeredTag),
                _ => ServiceExecutionResult.Failed("Invalid result code")
            };

            if (executionResult.IsSuccess)
            {
                await UpdateNextTestTagAsync();
                _logger.LogInformation("Test execution completed successfully for tag {TagName}", triggeredTag.Name);
            }
            else
            {
                _logger.LogWarning("Test execution failed for tag {TagName}: {Error}", 
                    triggeredTag.Name, executionResult.ErrorMessage);
            }

            return executionResult.IsSuccess;
        }, $"ExecuteTest for tag {triggeredTag.Name}");

        return result.IsSuccess && result.Value;
    }

    public async Task<bool> HandleManualFailAsync(Io failTag, string comments)
    {
        var result = await _errorHandlingService.ExecuteWithErrorHandlingAsync(async () =>
        {
            _logger.LogInformation("Handling manual fail for tag {TagName} with comments: {Comments}", 
                failTag.Name, comments);

            var success = await _ioTestService.MarkTestFailedAsync(failTag, comments);
            
            if (success)
            {
                UpdateTagInMemory(failTag, TestConstants.RESULT_FAILED, comments);
                await UpdateNextTestTagAsync();
                _logger.LogInformation("Manual fail processed successfully for tag {TagName}", failTag.Name);
            }
            else
            {
                _logger.LogWarning("Failed to process manual fail for tag {TagName}", failTag.Name);
            }
            
            return success;
        }, $"HandleManualFail for tag {failTag.Name}");

        return result.IsSuccess && result.Value;
    }

    public async Task<bool> ClearTestResultAsync(Io tag)
    {
        var result = await _errorHandlingService.ExecuteWithErrorHandlingAsync(async () =>
        {
            _logger.LogInformation("Clearing test result for tag {TagName}", tag.Name);

            var success = await _ioTestService.ClearTestResultAsync(tag);
            
            if (success)
            {
                UpdateTagInMemory(tag, null, "");
                await UpdateNextTestTagAsync();
                _logger.LogInformation("Test result cleared successfully for tag {TagName}", tag.Name);
            }
            else
            {
                _logger.LogWarning("Failed to clear test result for tag {TagName}", tag.Name);
            }
            
            return success;
        }, $"ClearTestResult for tag {tag.Name}");

        return result.IsSuccess && result.Value;
    }

    public async Task<Io?> UpdateNextTestTagAsync()
    {
        var result = await _errorHandlingService.ExecuteWithErrorHandlingAsync(async () =>
        {
            _logger.LogDebug("Updating next test tag");

            var nextTag = await _ioTestService.GetNextUntestedTagAsync();
            
            if (nextTag != null)
            {
                _appStateService.TestState.TestTag = nextTag;
                _plcCommunicationService.InitializeOutputTag(nextTag);
                _logger.LogInformation("Next test tag updated to {TagName}", nextTag.Name);
            }
            else
            {
                _appStateService.TestState.TestTag = new Io();
                _logger.LogInformation("No more tags to test - testing complete");
            }
            
            return nextTag;
        }, "UpdateNextTestTag");

        return result.IsSuccess ? result.Value : null;
    }

    public async Task<string?> GetFailureCommentsAsync(string? tagDescription, string? swapped = null)
    {
        var result = await _errorHandlingService.ExecuteWithErrorHandlingAsync(async () =>
        {
            _logger.LogDebug("Getting failure comments for tag description: {Description}", tagDescription);
            
            var comments = await _dialogManager.GetCommentsAsync(tagDescription, swapped);
            
            if (string.IsNullOrEmpty(comments))
            {
                _logger.LogWarning("No comments provided for failed test with description: {Description}", tagDescription);
            }
            
            return comments;
        }, "GetFailureComments");

        return result.IsSuccess ? result.Value : null;
    }

    private async Task<ServiceExecutionResult> HandleTestPassedAsync(Io triggeredTag, string swapped)
    {
        try
        {
            var success = await _ioTestService.MarkTestPassedAsync(triggeredTag);
            
            if (success)
            {
                UpdateTagInMemory(triggeredTag, TestConstants.RESULT_PASSED, "");
                return ServiceExecutionResult.Success();
            }
            
            return ServiceExecutionResult.Failed("Failed to mark test as passed in database");
        }
        catch (Exception ex)
        {
            _errorHandlingService.LogError(ex, "Error handling test passed for tag {TagName}", triggeredTag.Name ?? "Unknown");
            return ServiceExecutionResult.Failed($"Exception occurred: {ex.Message}");
        }
    }

    private async Task<ServiceExecutionResult> HandleTestFailedAsync(Io triggeredTag, string swapped)
    {
        try
        {
            var comments = await GetFailureCommentsAsync(triggeredTag.Description, swapped);
            if (string.IsNullOrEmpty(comments))
            {
                return ServiceExecutionResult.Failed(ApplicationConstants.ErrorMessages.COMMENTS_REQUIRED);
            }

            var success = await _ioTestService.MarkTestFailedAsync(triggeredTag, comments);
            
            if (success)
            {
                UpdateTagInMemory(triggeredTag, TestConstants.RESULT_FAILED, comments);
                return ServiceExecutionResult.Success();
            }
            
            return ServiceExecutionResult.Failed("Failed to mark test as failed in database");
        }
        catch (Exception ex)
        {
            _errorHandlingService.LogError(ex, "Error handling test failed for tag {TagName}", triggeredTag.Name ?? "Unknown");
            return ServiceExecutionResult.Failed($"Exception occurred: {ex.Message}");
        }
    }

    private async Task<ServiceExecutionResult> HandleTestClearedAsync(Io triggeredTag)
    {
        try
        {
            var success = await _ioTestService.ClearTestResultAsync(triggeredTag);
            
            if (success)
            {
                UpdateTagInMemory(triggeredTag, null, "");
                return ServiceExecutionResult.Success();
            }
            
            return ServiceExecutionResult.Failed("Failed to clear test result in database");
        }
        catch (Exception ex)
        {
            _errorHandlingService.LogError(ex, "Error handling test cleared for tag {TagName}", triggeredTag.Name ?? "Unknown");
            return ServiceExecutionResult.Failed($"Exception occurred: {ex.Message}");
        }
    }

    private void UpdateTagInMemory(Io tag, string? result, string comments)
    {
        try
        {
            var updateTag = _plcCommunicationService.TagList.FirstOrDefault(a => a.Id == tag.Id);
            if (updateTag != null)
            {
                updateTag.Result = result;
                updateTag.Comments = comments;
                updateTag.Timestamp = DateTime.UtcNow.ToString(TestConstants.TIMESTAMP_FORMAT);
                
                _logger.LogDebug("Updated tag {TagName} in memory with result {Result}", 
                    tag.Name ?? "Unknown", result ?? "cleared");
            }
            else
            {
                _logger.LogWarning("Could not find tag {TagName} in memory to update", tag.Name ?? "Unknown");
            }
        }
        catch (Exception ex)
        {
            _errorHandlingService.LogError(ex, "Error updating tag {TagName} in memory", tag.Name ?? "Unknown");
        }
    }
} 