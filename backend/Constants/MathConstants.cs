namespace IO_Checkout_Tool.Constants;

public static class MathConstants
{
    // Percentage Calculations
    public const int PERCENTAGE_MULTIPLIER = 100;
    public const int DECIMAL_PRECISION = 2;
    
    // Format Strings
    public const string PERCENTAGE_FORMAT = "0.00";
    
    // Array Indices for Graph Data
    public static class GraphIndices
    {
        public const int PASSED_INDEX = 0;
        public const int FAILED_INDEX = 1;
        public const int NOT_TESTED_INDEX = 2;
    }
    
    // Label Formats
    public static class LabelFormats
    {
        public const string PASSED_LABEL_FORMAT = "Passed: {0} ({1}%) ";
        public const string FAILED_LABEL_FORMAT = "Failed: {0} ({1}%)";
        public const string NOT_TESTED_LABEL_FORMAT = "Not Tested: {0} ({1}%)";
    }
} 