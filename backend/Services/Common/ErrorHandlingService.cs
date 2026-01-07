using IO_Checkout_Tool.Constants;
using IO_Checkout_Tool.Services.Interfaces;
using Microsoft.Extensions.Logging;

namespace IO_Checkout_Tool.Services.Common;

public interface IErrorHandlingService
{
    Task<Result<T>> ExecuteWithErrorHandlingAsync<T>(Func<Task<T>> operation, string operationName);
    Task<Result> ExecuteWithErrorHandlingAsync(Func<Task> operation, string operationName);
    void LogError(Exception ex, string message, params object[] args);
    void LogWarning(string message, params object[] args);
    void LogInformation(string message, params object[] args);
}

public class ErrorHandlingService : IErrorHandlingService
{
    private readonly ILogger<ErrorHandlingService> _logger;
    private readonly IErrorDialogService _errorDialogService;

    public ErrorHandlingService(ILogger<ErrorHandlingService> logger, IErrorDialogService errorDialogService)
    {
        _logger = logger;
        _errorDialogService = errorDialogService;
    }

    public async Task<Result<T>> ExecuteWithErrorHandlingAsync<T>(Func<Task<T>> operation, string operationName)
    {
        try
        {
            _logger.LogInformation("Starting operation: {OperationName}", operationName);
            var result = await operation();
            _logger.LogInformation("Completed operation: {OperationName}", operationName);
            return Result<T>.Success(result);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in operation: {OperationName}", operationName);
            _errorDialogService.ShowError($"Error in {operationName}", ex.Message);
            return Result<T>.Failure(ex.Message);
        }
    }

    public async Task<Result> ExecuteWithErrorHandlingAsync(Func<Task> operation, string operationName)
    {
        try
        {
            _logger.LogInformation("Starting operation: {OperationName}", operationName);
            await operation();
            _logger.LogInformation("Completed operation: {OperationName}", operationName);
            return Result.Success();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in operation: {OperationName}", operationName);
            _errorDialogService.ShowError($"Error in {operationName}", ex.Message);
            return Result.Failure(ex.Message);
        }
    }

    public void LogError(Exception ex, string message, params object[] args)
    {
        _logger.LogError(ex, message, args);
    }

    public void LogWarning(string message, params object[] args)
    {
        _logger.LogWarning(message, args);
    }

    public void LogInformation(string message, params object[] args)
    {
        _logger.LogInformation(message, args);
    }
}

public class Result<T>
{
    public bool IsSuccess { get; }
    public bool IsFailure => !IsSuccess;
    public T? Value { get; }
    public string? Error { get; }

    private Result(bool isSuccess, T? value, string? error)
    {
        IsSuccess = isSuccess;
        Value = value;
        Error = error;
    }

    public static Result<T> Success(T value) => new(true, value, null);
    public static Result<T> Failure(string error) => new(false, default, error);
}

public class Result
{
    public bool IsSuccess { get; }
    public bool IsFailure => !IsSuccess;
    public string? Error { get; }

    private Result(bool isSuccess, string? error)
    {
        IsSuccess = isSuccess;
        Error = error;
    }

    public static Result Success() => new(true, null);
    public static Result Failure(string error) => new(false, error);
} 