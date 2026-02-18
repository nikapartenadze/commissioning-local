using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;
using IO_Checkout_Tool.Models;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Controllers;

[Authorize]
[ApiController]
[Route("api/diagnostics")]
public class DiagnosticController : ControllerBase
{
    private readonly IDbContextFactory<TagsContext> _contextFactory;
    private readonly ILogger<DiagnosticController> _logger;

    public DiagnosticController(
        IDbContextFactory<TagsContext> contextFactory,
        ILogger<DiagnosticController> logger)
    {
        _contextFactory = contextFactory;
        _logger = logger;
    }

    /// <summary>
    /// Get all unique tag types
    /// </summary>
    [HttpGet("tag-types")]
    public async Task<ActionResult<List<string>>> GetTagTypes()
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            var tagTypes = await context.TagTypeDiagnostics
                .Select(d => d.TagType)
                .Distinct()
                .OrderBy(t => t)
                .ToListAsync();
            
            return Ok(tagTypes);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting tag types");
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Get failure modes for a specific tag type
    /// </summary>
    [HttpGet("failure-modes")]
    public async Task<ActionResult<List<string>>> GetFailureModes([FromQuery] string? tagType)
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            
            IQueryable<TagTypeDiagnostic> query = context.TagTypeDiagnostics;
            
            if (!string.IsNullOrEmpty(tagType))
            {
                query = query.Where(d => d.TagType == tagType);
            }
            
            var failureModes = await query
                .Select(d => d.FailureMode)
                .Distinct()
                .OrderBy(f => f)
                .ToListAsync();
            
            return Ok(failureModes);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting failure modes for tag type {TagType}", tagType);
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Get diagnostic steps for a specific tag type and failure mode
    /// </summary>
    [HttpGet("steps")]
    public async Task<ActionResult<object>> GetDiagnosticSteps(
        [FromQuery] string tagType,
        [FromQuery] string failureMode)
    {
        try
        {
            if (string.IsNullOrEmpty(tagType) || string.IsNullOrEmpty(failureMode))
            {
                return BadRequest("Both tagType and failureMode are required");
            }

            using var context = await _contextFactory.CreateDbContextAsync();
            
            var diagnostic = await context.TagTypeDiagnostics
                .FirstOrDefaultAsync(d => d.TagType == tagType && d.FailureMode == failureMode);
            
            if (diagnostic == null)
            {
                return NotFound(new 
                { 
                    error = "No diagnostic steps found",
                    tagType,
                    failureMode,
                    message = $"No troubleshooting steps available for {tagType} with failure mode '{failureMode}'"
                });
            }
            
            return Ok(new 
            { 
                tagType = diagnostic.TagType,
                failureMode = diagnostic.FailureMode,
                steps = diagnostic.DiagnosticSteps,
                lastUpdated = diagnostic.UpdatedAt ?? diagnostic.CreatedAt
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting diagnostic steps for {TagType} - {FailureMode}", tagType, failureMode);
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Get all diagnostics (for management/admin)
    /// </summary>
    [HttpGet("all")]
    public async Task<ActionResult<List<TagTypeDiagnostic>>> GetAllDiagnostics()
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            var diagnostics = await context.TagTypeDiagnostics
                .OrderBy(d => d.TagType)
                .ThenBy(d => d.FailureMode)
                .ToListAsync();
            
            return Ok(diagnostics);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting all diagnostics");
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Create or update a diagnostic entry
    /// </summary>
    [HttpPost]
    public async Task<ActionResult<TagTypeDiagnostic>> CreateOrUpdateDiagnostic([FromBody] TagTypeDiagnostic diagnostic)
    {
        try
        {
            if (string.IsNullOrEmpty(diagnostic.TagType) || string.IsNullOrEmpty(diagnostic.FailureMode))
            {
                return BadRequest("TagType and FailureMode are required");
            }

            using var context = await _contextFactory.CreateDbContextAsync();
            
            var existing = await context.TagTypeDiagnostics
                .FirstOrDefaultAsync(d => d.TagType == diagnostic.TagType && d.FailureMode == diagnostic.FailureMode);
            
            if (existing != null)
            {
                // Update existing
                existing.DiagnosticSteps = diagnostic.DiagnosticSteps;
                existing.UpdatedAt = DateTime.UtcNow;
                _logger.LogInformation("Updated diagnostic for {TagType} - {FailureMode}", diagnostic.TagType, diagnostic.FailureMode);
            }
            else
            {
                // Create new
                diagnostic.CreatedAt = DateTime.UtcNow;
                context.TagTypeDiagnostics.Add(diagnostic);
                _logger.LogInformation("Created new diagnostic for {TagType} - {FailureMode}", diagnostic.TagType, diagnostic.FailureMode);
            }
            
            await context.SaveChangesAsync();
            
            return Ok(diagnostic);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error creating/updating diagnostic");
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Delete a diagnostic entry
    /// </summary>
    [HttpDelete]
    public async Task<IActionResult> DeleteDiagnostic([FromQuery] string tagType, [FromQuery] string failureMode)
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            
            var diagnostic = await context.TagTypeDiagnostics
                .FirstOrDefaultAsync(d => d.TagType == tagType && d.FailureMode == failureMode);
            
            if (diagnostic == null)
            {
                return NotFound();
            }
            
            context.TagTypeDiagnostics.Remove(diagnostic);
            await context.SaveChangesAsync();
            
            _logger.LogInformation("Deleted diagnostic for {TagType} - {FailureMode}", tagType, failureMode);
            
            return NoContent();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error deleting diagnostic");
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Bulk import diagnostics from JSON
    /// </summary>
    [HttpPost("import")]
    public async Task<ActionResult<object>> BulkImportDiagnostics([FromBody] List<TagTypeDiagnostic> diagnostics)
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            
            var imported = 0;
            var updated = 0;
            
            foreach (var diagnostic in diagnostics)
            {
                var existing = await context.TagTypeDiagnostics
                    .FirstOrDefaultAsync(d => d.TagType == diagnostic.TagType && d.FailureMode == diagnostic.FailureMode);
                
                if (existing != null)
                {
                    existing.DiagnosticSteps = diagnostic.DiagnosticSteps;
                    existing.UpdatedAt = DateTime.UtcNow;
                    updated++;
                }
                else
                {
                    diagnostic.CreatedAt = DateTime.UtcNow;
                    context.TagTypeDiagnostics.Add(diagnostic);
                    imported++;
                }
            }
            
            await context.SaveChangesAsync();
            
            _logger.LogInformation("Bulk import completed: {Imported} new, {Updated} updated", imported, updated);
            
            return Ok(new { imported, updated, total = imported + updated });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during bulk import");
            return StatusCode(500, "Internal server error");
        }
    }
}

