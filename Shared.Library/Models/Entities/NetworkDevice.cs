using System.ComponentModel.DataAnnotations;

namespace Shared.Library.Models.Entities;

public class NetworkDevice
{
    public int Id { get; set; }

    [Required]
    public int SubsystemId { get; set; }

    [Required]
    [StringLength(100)]
    public string DeviceName { get; set; } = string.Empty;

    [StringLength(50)]
    public string? DeviceType { get; set; }

    [StringLength(50)]
    public string? IpAddress { get; set; }

    public int? ParentDeviceId { get; set; }

    public int TagCount { get; set; }

    [StringLength(500)]
    public string? Description { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? UpdatedAt { get; set; }

    // Navigation
    public NetworkDevice? ParentDevice { get; set; }
}
