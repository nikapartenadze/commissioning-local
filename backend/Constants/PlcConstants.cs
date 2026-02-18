namespace IO_Checkout_Tool.Constants;

public static class PlcConstants
{
    public const int DefaultTagTimeout = 1000;
    public const int TagReadInterval = 75;

    // Performance optimization constants - balanced for 1000 tags and PLC limits
    public const int MaxTagsPerBatch = 25;
    public const int OptimizedTagTimeout = 800;
    public const int MaxConcurrentBatches = 6;
    public const int ConnectionRetryDelay = 50;

    // Optimized batch reading constants
    public const int OptimizedBatchSize = 50; // Larger batches for parallel initialization
    public const int OptimizedReadInterval = 100; // Slightly longer interval for better throughput

    public static class ErrorMessages
    {
        public const string ErrorTimeout = "ErrorTimeout";
        public const string ErrorNotFound = "ErrorNotFound";
        public const string ErrorNotAllowed = "ErrorNotAllowed";
        public const string TaskCanceled = "A task was canceled.";
        public const string PlcCommFailure = "Failed to communicate with PLC";
        public const string FailedTags = "Failed tags";
        public const string ConnectionFailed = "Connection to internet not detected on startup";
        public const string FailedToReadTags = "Failed to read tags";
    }

    public static class LogMessages
    {
        public const string PlcInitSuccess = "PLC initialization completed successfully";
        public const string PlcInitFailed = "PLC initialization failed";
        public const string PlcInitError = "Error during PLC initialization";
    }
}
