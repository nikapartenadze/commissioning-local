using Shared.Library.Models.Entities;
using CsvHelper.Configuration.Attributes;

namespace Shared.Library.DTOs;

public class SyncRequestDto
{
    public int SubsystemId { get; set; }
}

public class SyncResponseDto
{
    public bool Success { get; set; }
    public string? Message { get; set; }
    public List<Io>? Ios { get; set; }
}

public class IoUpdateDto
{
    public int Id { get; set; }
    public string? Result { get; set; }
    public string? Timestamp { get; set; }
    public string? Comments { get; set; }
    public string? TestedBy { get; set; }
    public string? State { get; set; }
    public long Version { get; set; }
}

public class IoSyncBatchDto
{
    public List<IoUpdateDto> Updates { get; set; } = new();
}

#region Admin Management DTOs

public class IoWithSubsystemDto
{
    public int? Id { get; set; }
    public int SubsystemId { get; set; }
    public string? SubsystemName { get; set; }
    public string? Name { get; set; }
    public string? Description { get; set; }
    public int? Order { get; set; }
    public long Version { get; set; }
    public string? Result { get; set; }
    public string? Timestamp { get; set; }
    public string? Comments { get; set; }
}



public class IoImportDto
{
    [Name("Name")]
    public string? Name { get; set; }
    
    [Name("Description")]
    public string Description { get; set; } = "";
    
    [Name("Order")]
    public int? Order { get; set; }
}

public class IoImportResultDto
{
    public IoImportDto InputData { get; set; } = new();
    public bool Success { get; set; }
    public string? Message { get; set; }
}

public class SubsystemManagementDto
{
    public int? Id { get; set; }
    public int ProjectId { get; set; }
    public string? Name { get; set; }
}

public class ProjectManagementDto
{
    public int? Id { get; set; }
    public string? Name { get; set; }
    public string? ApiKey { get; set; }
}

#endregion 