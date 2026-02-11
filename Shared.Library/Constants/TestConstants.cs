namespace Shared.Library.Constants;

public static class TestConstants
{
    // Test Results
    public const string RESULT_PASSED = "Passed";
    public const string RESULT_FAILED = "Failed";
    public const string RESULT_NOT_TESTED = "Not Tested";
    public const string RESULT_CLEARED = "Cleared";
    public const string RESULT_COMMENT_ADDED = "Comment Added";
    public const string RESULT_COMMENT_REMOVED = "Comment Removed";
    public const string RESULT_COMMENT_MODIFIED = "Comment Modified";
    public const string RESULT_COMMENT_UPDATED = "Comment Updated";
    
    // Description Types  
    public const string DESC_SPARE = "SPARE";
    public const string DESC_INPUT = "INPUT";
    public const string DESC_OUTPUT = "OUTPUT";
    
    // Tag Patterns
    public const string OUTPUT_TAG_SUFFIX = ":O.";
    
    // Date Format
    public const string TIMESTAMP_FORMAT = "MM/dd/yy h:mm:ss.fff tt";
    public const string TIMESTAMP_DISPLAY_FORMAT = "MM/dd/yy h:mm tt";
    
    // File Names
    public const string EXPORT_CSV_FILENAME = "export.csv";
    public const string CSV_CONTENT_TYPE = "text/plain";
    
    // Timing Constants
    public const int UI_DELAY_MS = 250;
    public const int SUCCESS_ANIMATION_DURATION_MS = 2000;
    
    // Row Heights
    public const string ROW_HEIGHT = "75px";
    
    // Test Execution Result Codes
    public static class ResultCodes
    {
        public const int TEST_PASSED = 0;
        public const int TEST_FAILED = 1;
        public const int TEST_CLEARED = 2;
    }
    
    // PLC Write Values
    public static class PlcValues
    {
        public const int OUTPUT_ENABLED = 1;
    }
    
    // UI Text
    public static class UiText
    {
        public const string UNKNOWN_DESCRIPTION = "Unknown";
        public const string SINGLE_INSTANCE_MESSAGE = "Application is already running, press any key to exit.";
    }
    
    // Dialog Parameters
    public static class DialogParameters
    {
        public const string IO_ID = "IoId";
        public const string TAG = "Tag";
        public const string DESCRIPTION = "Description";
        public const string VALUE = "Value";
        public const string COMMENT = "Comment";
    }
    
    // Animation and Styles
    public static class Styles
    {
        public const string TEST_BUTTON_BASE = "user-select:none;-webkit-user-select:none;font-size:100px; margin-top:25px;";
        public const string TEST_BUTTON_GREEN = TEST_BUTTON_BASE + "background-color:green";
        public const string TEST_BUTTON_LIGHT_GREEN = TEST_BUTTON_BASE + "background-color:lightgreen";
        
        public const string PASS_ANIMATION_VISIBLE = "opacity:1; -webkit-transition: opacity 1.0s; transition: opacity 1.0s;";
        public const string PASS_ANIMATION_HIDDEN = "opacity:0; -webkit-transition: opacity 1.0s; transition: opacity 1.0s;";
        
        // Row Styles
        public const string ROW_PASSED = "background-color:lightgreen;height:" + ROW_HEIGHT;
        public const string ROW_FAILED = "background-color:coral;height:" + ROW_HEIGHT;
        public const string ROW_DEFAULT = "background-color:white;height:" + ROW_HEIGHT;
    }
    
    // Filter States
    public static class FilterStates
    {
        public const string STATE_TRUE = "TRUE";
        public const string STATE_FALSE = "FALSE";
    }
    
    // Dialog Titles
    public static class DialogTitles
    {
        public const string VALUE_CHANGED = "Value has changed";
        public const string COMMENT = "Comment";
        public const string TEST_HISTORY = "Test History";
        public const string COMPLETE_TEST_HISTORY = "Complete Test History";
    }
} 