using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace IO_Checkout_Tool.Models;

[Table("Users")]
public class User
{
    [Key]
    [DatabaseGenerated(DatabaseGeneratedOption.Identity)]
    public int Id { get; set; }

    [Required]
    [MaxLength(100)]
    public string FullName { get; set; } = string.Empty;

    [Required]
    public string Pin { get; set; } = string.Empty;

    public bool IsAdmin { get; set; } = false;

    public bool IsActive { get; set; } = true;

    [Required]
    public string CreatedAt { get; set; } = string.Empty;

    public string? LastUsedAt { get; set; }
}

