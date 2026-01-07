namespace IO_Checkout_Tool.Models.Common;

public class ServiceExecutionResult
{
    public bool IsSuccess { get; }
    public string? ErrorMessage { get; }

    private ServiceExecutionResult(bool isSuccess, string? errorMessage = null)
    {
        IsSuccess = isSuccess;
        ErrorMessage = errorMessage;
    }

    public static ServiceExecutionResult Success() => new(true);
    public static ServiceExecutionResult Failed(string errorMessage) => new(false, errorMessage);
}

public class CommentUpdateResult
{
    public bool Success { get; set; }
    public bool ChangesWereMade { get; set; }
    public string? ErrorMessage { get; set; }

    public static CommentUpdateResult Successful(bool changesWereMade) => new CommentUpdateResult 
    { 
        Success = true, 
        ChangesWereMade = changesWereMade 
    };
    
    public static CommentUpdateResult Failed(string errorMessage) => new CommentUpdateResult 
    { 
        Success = false, 
        ChangesWereMade = false, 
        ErrorMessage = errorMessage 
    };
} 