using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Models.Common;

public class ControllerExecutionResult
{
    public bool IsSuccess { get; init; }
    public bool IsSkipped { get; init; }
    public Io? UpdateTag { get; init; }
    public bool ShouldShowAnimation { get; init; }

    public static ControllerExecutionResult Success(Io updateTag, bool showAnimation = false) 
        => new() { IsSuccess = true, UpdateTag = updateTag, ShouldShowAnimation = showAnimation };
    
    public static ControllerExecutionResult Failed() 
        => new() { IsSuccess = false };
    
    public static ControllerExecutionResult Skipped() 
        => new() { IsSkipped = true };
} 