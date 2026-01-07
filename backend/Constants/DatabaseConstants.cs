namespace IO_Checkout_Tool.Constants;

public static class DatabaseConstants
{
    // Connection Strings
    public const string SQLITE_CONNECTION_STRING = "Data Source=database.db";
    public const string DATABASE_FILENAME = "database.db";
    
    // Configuration Keys
    public static class ConfigKeys
    {
        public const string IP = "ip";
        public const string PATH = "path";
        public const string SUBSYSTEM_ID = "subsystemId";
        public const string REMOTE_URL = "remoteUrl";
        public const string ORDER_MODE = "orderMode";
        public const string DISABLE_WATCHDOG = "disableWatchdog";
        
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