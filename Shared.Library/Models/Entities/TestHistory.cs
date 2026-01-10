using System.ComponentModel.DataAnnotations;

namespace Shared.Library.Models.Entities;

public class TestHistory
{
    public int Id { get; set; }
    
    [Required]
    public int IoId { get; set; }
    
    [StringLength(50)]
    public string? Result { get; set; }
    
    public string? Timestamp { get; set; }
    
    [StringLength(1000)]
    public string? Comments { get; set; }
    
    [StringLength(100)]
    public string? TestedBy { get; set; }
    
    [StringLength(50)]
    public string? State { get; set; }
    
    [StringLength(100)]
    public string? FailureMode { get; set; }
    
    public Io? Io { get; set; }

    public DateTime? TimestampAsDateTime => 
        DateTime.TryParse(Timestamp, out var date) ? date : null;
    
    public bool IsPassed => Result == Shared.Library.Constants.TestConstants.RESULT_PASSED;
    public bool IsFailed => Result == Shared.Library.Constants.TestConstants.RESULT_FAILED;
} 