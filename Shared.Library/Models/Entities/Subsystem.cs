using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace Shared.Library.Models.Entities;

[Table("subsystems")]
public class Subsystem
{
    public int Id { get; set; }
    
    [Required]
    [Column("project_id")]
    public int ProjectId { get; set; }
    
    public string? Name { get; set; }
    
    // Navigation properties
    public Project? Project { get; set; }
} 