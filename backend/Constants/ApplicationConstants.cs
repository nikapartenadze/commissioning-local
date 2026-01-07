namespace IO_Checkout_Tool.Constants;

public static class ApplicationConstants
{
    public static class Delays
    {
        public const int UI_DELAY_MS = 500;
        public const int CONNECTION_TIMEOUT_MS = 5000;
        public const int RETRY_DELAY_MS = 1000;
    }

    public static class Defaults
    {
        public const int SINGLE_INSTANCE_MAX_COUNT = 1;
        public const string EMPTY_STRING = "";
        public const string DEFAULT_TIMESTAMP_FORMAT = "yyyy-MM-dd HH:mm:ss";
    }

    public static class FileExtensions
    {
        public const string JSON = ".json";
        public const string CSV = ".csv";
        public const string XLSX = ".xlsx";
    }

    public static class ErrorMessages
    {
        public const string SINGLE_INSTANCE_MESSAGE = "Application is already running. Only one instance is allowed.";
        public const string DATABASE_CONNECTION_ERROR = "Failed to connect to database";
        public const string PLC_CONNECTION_ERROR = "Failed to connect to PLC";
        public const string INVALID_CONFIGURATION = "Invalid configuration detected";
        public const string TEST_EXECUTION_ERROR = "Error occurred during test execution";
        public const string COMMENTS_REQUIRED = "Comments are required for failed tests";
    }

    public static class ConfigurationKeys
    {
        public const string ORDER_MODE = "OrderMode";
        public const string CONNECTION_STRING = "ConnectionString";
        public const string PLC_IP_ADDRESS = "PlcIpAddress";
        public const string AUTO_ADVANCE = "AutoAdvance";
    }

    public static class DialogButtons
    {
        public const string OK = "OK";
        public const string CANCEL = "Cancel";
        public const string YES = "Yes";
        public const string NO = "No";
        public const string RETRY = "Retry";
    }
} 