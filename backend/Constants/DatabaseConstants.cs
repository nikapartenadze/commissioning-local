namespace IO_Checkout_Tool.Constants;

public static class DatabaseConstants
{
    // Data directory (configurable via DATA_DIR env var for Docker)
    public static string DataDir => Environment.GetEnvironmentVariable("DATA_DIR") ?? ".";

    // Connection Strings (resolved at runtime for Docker support)
    public static string SqliteConnectionString => $"Data Source={Path.Combine(DataDir, "database.db")}";
    public const string DATABASE_FILENAME = "database.db";
    public static string DatabasePath => Path.Combine(DataDir, DATABASE_FILENAME);

    // Logs directory
    public static string LogsDir => Path.Combine(DataDir, "logs");

    // Config file path
    public static string ConfigFilePath => Path.Combine(DataDir, "config.json");

    // Legacy constant for backward compatibility
    public const string SQLITE_CONNECTION_STRING = "Data Source=database.db";
    
    // Configuration Keys
    public static class ConfigKeys
    {
        public const string IP = "ip";
        public const string PATH = "path";
        public const string SUBSYSTEM_ID = "subsystemId";
        public const string REMOTE_URL = "remoteUrl";
        public const string ORDER_MODE = "orderMode";
        
        // Column visibility settings
        public const string SHOW_STATE_COLUMN = "showStateColumn";
        public const string SHOW_RESULT_COLUMN = "showResultColumn";
        public const string SHOW_TIMESTAMP_COLUMN = "showTimestampColumn";
        public const string SHOW_HISTORY_COLUMN = "showHistoryColumn";
    }
    
    // Default Values
    public static class Defaults
    {
        public const int RECENT_HISTORY_COUNT = 100;
        public const int ORDER_MODE_ENABLED = 1;
        public const int SINGLE_INSTANCE_MAX_COUNT = 1;
    }
} 