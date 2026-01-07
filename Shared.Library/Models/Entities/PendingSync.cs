using System.ComponentModel.DataAnnotations;

namespace Shared.Library.Models.Entities;

/// <summary>
/// Used by the local tool to queue IO updates while offline.
/// This entity is specific to the local tool's SQLite database.
/// </summary>
public class PendingSync
{
    [Key]
    public int Id { get; set; }
    
    public int IoId { get; set; }
    
    public string? InspectorName { get; set; }
    
    public string? TestResult { get; set; }
    
    public string? Comments { get; set; }
    
    public string? State { get; set; }
    
    public DateTime? Timestamp { get; set; }
    
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    public int RetryCount { get; set; } = 0;
    
    public string? LastError { get; set; }
    
    public long Version { get; set; } = 0;
} 