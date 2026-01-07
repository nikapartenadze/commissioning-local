namespace IO_Checkout_Tool.Services.Common;

public class ServiceResult<T>
{
    public bool IsSuccess { get; private set; }
    public T? Data { get; private set; }
    public string? ErrorMessage { get; private set; }
    public Exception? Exception { get; private set; }

    protected ServiceResult(bool isSuccess, T? data, string? errorMessage, Exception? exception)
    {
        IsSuccess = isSuccess;
        Data = data;
        ErrorMessage = errorMessage;
        Exception = exception;
    }

    public static ServiceResult<T> Success(T data) => new(true, data, null, null);
    public static ServiceResult<T> Success() => new(true, default, null, null);
    public static ServiceResult<T> Failure(string errorMessage) => new(false, default, errorMessage, null);
    public static ServiceResult<T> Failure(Exception exception) => new(false, default, exception.Message, exception);
    public static ServiceResult<T> Failure(string errorMessage, Exception exception) => new(false, default, errorMessage, exception);
}

public class ServiceResult : ServiceResult<object>
{
    private ServiceResult(bool isSuccess, string? errorMessage, Exception? exception) 
        : base(isSuccess, null, errorMessage, exception) { }

    public static new ServiceResult Success() => new(true, null, null);
    public static new ServiceResult Failure(string errorMessage) => new(false, errorMessage, null);
    public static new ServiceResult Failure(Exception exception) => new(false, exception.Message, exception);
    public static new ServiceResult Failure(string errorMessage, Exception exception) => new(false, errorMessage, exception);
} 