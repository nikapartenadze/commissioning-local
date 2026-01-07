using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace Shared.Library.Models.Entities;

[Table("projects")]
public class Project
{
    public int Id { get; set; }
    
    [Required]
    public string Name { get; set; } = string.Empty;
    
    [StringLength(255)]
    public string? ApiKey { get; set; }
    
    // Navigation properties
    public ICollection<Subsystem> Subsystems { get; set; } = new List<Subsystem>();
} 