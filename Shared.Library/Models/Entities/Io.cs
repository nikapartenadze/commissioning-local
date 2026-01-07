using System.ComponentModel.DataAnnotations;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using CsvHelper.Configuration.Attributes;
using MessagePack;

namespace Shared.Library.Models.Entities;

[MessagePackObject]
public class Io
#if TOOL_APP
    : INotifyPropertyChanged
#endif
{
#if TOOL_APP
    private string? _state;
#endif

    [MessagePack.Key(0)]
    public int Id { get; set; }

    [MessagePack.Key(1)]
    [Required]
    public int SubsystemId { get; set; }

    [MessagePack.Key(2)]
    [Required]
    [StringLength(100)]
    public string? Name { get; set; }
    
    [MessagePack.Key(3)]
    [StringLength(500)]
    public string? Description { get; set; }

    [MessagePack.Key(4)]
    [Ignore] // CsvHelper ignore
    [StringLength(50)]
    public string? State 
    { 
#if TOOL_APP
        get => _state;
        set
        {
            if (_state != value)
            {
                _state = value;
                OnPropertyChanged();
            }
        }
#else
        get; set;
#endif
    }

    [MessagePack.Key(5)]
    [StringLength(50)]
    public string? Result { get; set; }
    
    [MessagePack.Key(6)]
    public string? Timestamp { get; set; }
    
    [MessagePack.Key(7)]
    [StringLength(1000)]
    public string? Comments { get; set; }

    [MessagePack.Key(8)]
    public int? Order { get; set; }

    [MessagePack.Key(9)]
    public long Version { get; set; } = 0;

    // Navigation properties
    [IgnoreMember]
    public Subsystem? Subsystem { get; set; }

    // Computed properties - don't serialize for SignalR efficiency
    [IgnoreMember]
    public bool IsOutput => Name?.Contains(":O.") == true || Name?.Contains(".O.") == true || Name?.Contains(":O:") == true || Name?.Contains(".Outputs.") == true || Name?.EndsWith(".DO") == true;
    
    [IgnoreMember]
    public bool HasResult => !string.IsNullOrEmpty(Result);
    
    [IgnoreMember]
    public bool IsPassed => Result == Shared.Library.Constants.TestConstants.RESULT_PASSED;
    
    [IgnoreMember]
    public bool IsFailed => Result == Shared.Library.Constants.TestConstants.RESULT_FAILED;

#if TOOL_APP
    public event PropertyChangedEventHandler? PropertyChanged;

    protected virtual void OnPropertyChanged([CallerMemberName] string? propertyName = null)
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
#endif
} 