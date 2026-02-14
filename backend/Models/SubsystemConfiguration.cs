using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace IO_Checkout_Tool.Models;

[Table("SubsystemConfigurations")]
public class SubsystemConfiguration
{
    [Key]
    [DatabaseGenerated(DatabaseGeneratedOption.Identity)]
    public int Id { get; set; }
    
    [Required]
    public required string ProjectName { get; set; }
    
    [Required]
    public int SubsystemId { get; set; }
    
    [Required]
    public required string SubsystemName { get; set; }
    
    [Required]
    public required string Ip { get; set; }
    
    [Required]
    public required string Path { get; set; }
    
    public string? RemoteUrl { get; set; }
    
    public string? ApiPassword { get; set; }
    
    public bool OrderMode { get; set; } = false;
    
    public bool DisableWatchdog { get; set; } = true;
    
    public bool ShowStateColumn { get; set; } = true;
    
    public bool ShowHzColumn { get; set; } = true;
    
    public bool ShowResultColumn { get; set; } = true;
    
    public bool ShowTimestampColumn { get; set; } = true;
    
    public bool ShowHistoryColumn { get; set; } = true;
    
    public bool IsActive { get; set; } = false;
    
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    
    // Description or notes about this subsystem
    public string? Description { get; set; }
}

