using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Models.Common;

public class TestDialogResult
{
    public Io UpdateTag { get; set; } = new();
    public MudBlazor.DialogResult? DialogResult { get; set; }
    public string SwappedMessage { get; set; } = string.Empty;
} 