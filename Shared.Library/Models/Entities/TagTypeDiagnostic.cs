using System.ComponentModel.DataAnnotations;

namespace Shared.Library.Models.Entities;

/// <summary>
/// Stores diagnostic troubleshooting steps for different tag types and failure modes
/// </summary>
public class TagTypeDiagnostic
{
    [Required]
    [StringLength(100)]
    public string TagType { get; set; } = string.Empty;
    
    [Required]
    [StringLength(100)]
    public string FailureMode { get; set; } = string.Empty;
    
    [Required]
    public string DiagnosticSteps { get; set; } = string.Empty;  // Markdown format
    
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? UpdatedAt { get; set; }
}

