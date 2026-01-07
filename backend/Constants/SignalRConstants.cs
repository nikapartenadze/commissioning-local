namespace IO_Checkout_Tool.Constants;

public static class SignalRConstants
{
    // Hub Endpoints
    public const string HUB_ENDPOINT = "/hub";
    
    // Hub Method Names
    public static class HubMethods
    {
        public const string RECEIVE_MESSAGE = "ReceiveMessage";
        public const string SEND_MESSAGE = "SendMessage";
        public const string CLOSE_DIALOG = "CloseDialog";
        public const string DIALOG_CLOSED = "DialogClosed";
    }
    
    // JavaScript Functions
    public static class JavaScriptFunctions
    {
        public const string BLAZOR_DOWNLOAD_FILE = "BlazorDownloadFile";
    }
    
    // HTTP Headers
    public static class HttpHeaders
    {
        public const string GZIP_ENCODING = "gzip";
    }
} 