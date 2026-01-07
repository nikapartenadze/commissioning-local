using IO_Checkout_Tool.Constants;
using IO_Checkout_Tool.Models.Common;
using Shared.Library.Repositories.Interfaces;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.SharedComponents;
using Shared.Library.Models.Entities;
using Shared.Library.DTOs;

namespace IO_Checkout_Tool.Services;

public class IoTestService : IIoTestService
{
    private readonly IIoRepository _ioRepository;
    private readonly ITestHistoryService _historyService;
    private readonly ICloudSyncService _cloudSyncService;
    private readonly ILogger<IoTestService> _logger;

    public IoTestService(
        IIoRepository ioRepository, 
        ITestHistoryService historyService,
        ICloudSyncService cloudSyncService,
        ILogger<IoTestService> logger)
    {
        _ioRepository = ioRepository;
        _historyService = historyService;
        _cloudSyncService = cloudSyncService;
        _logger = logger;
    }

    public async Task<Io?> GetNextUntestedTagAsync()
    {
        return await _ioRepository.GetNextUntestedAsync();
    }

    public async Task<bool> MarkTestPassedAsync(Io tag, string comments = "")
    {
        return await UpdateTestResultAsync(tag, TestConstants.RESULT_PASSED, comments);
    }

    public async Task<bool> MarkTestFailedAsync(Io tag, string comments)
    {
        return await UpdateTestResultAsync(tag, TestConstants.RESULT_FAILED, comments);
    }

    public async Task<bool> ClearTestResultAsync(Io tag)
    {
        try
        {
            var dbTag = await GetDbTagAsync(tag.Id);
            if (dbTag == null) return false;

            // If the tag is already fully cleared (no result and no comments), do nothing
            if (string.IsNullOrEmpty(dbTag.Result) && string.IsNullOrEmpty(dbTag.Comments))
            {
                _logger.LogDebug("Tag {TagId} is already cleared, skipping clear operation", tag.Id);
                return true;
            }

            // Store the old values to determine if we should add history
            var hadComments = !string.IsNullOrEmpty(dbTag.Comments);
            var hadResult = !string.IsNullOrEmpty(dbTag.Result);

            // Prepare the cleared message
            string? clearedComment = null;
            
            // Add local history if there were comments or a previous result
            if (hadComments || hadResult)
            {
                if (hadResult && hadComments)
                {
                    clearedComment = $"Previous result was {dbTag.Result}";
                }
                else if (hadResult)
                {
                    clearedComment = $"Previous result was {dbTag.Result}";
                }
                else
                {
                    clearedComment = "Cleared comments";
                }
                
                await _historyService.AddTestHistoryAsync(
                    dbTag.Id,
                    TestConstants.RESULT_CLEARED,
                    clearedComment,
                    tag.State ?? "");
            }
            
            ClearTagResult(dbTag);
            
            await _ioRepository.UpdateAsync(dbTag);
            
            // Always sync with "Cleared" result if there was something to clear
            if (hadComments || hadResult)
            {
                await SyncClearedToCloudAsync(dbTag, tag.State, TestConstants.RESULT_CLEARED, clearedComment);
            }
            else
            {
                // Sync without adding history - nothing was cleared
                await SyncToCloudAsync(dbTag, tag.State);
            }
            
            return true;
        }
        catch
        {
            return false;
        }
    }

    public async Task<CommentUpdateResult> UpdateCommentAsync(Io tag, string newComment)
    {
        try
        {
            var dbTag = await GetDbTagAsync(tag.Id);
            if (dbTag == null) return CommentUpdateResult.Failed("Tag not found in database");

            var oldComment = dbTag.Comments;
            
            // Normalize empty values for comparison
            var normalizedOldComment = string.IsNullOrEmpty(oldComment) ? "" : oldComment;
            var normalizedNewComment = string.IsNullOrEmpty(newComment) ? "" : newComment;
            
            // If there's no actual change, don't create history
            if (normalizedOldComment == normalizedNewComment)
            {
                return CommentUpdateResult.Successful(changesWereMade: false); // No change needed
            }
            
            dbTag.Comments = newComment;
            dbTag.Timestamp = CreateTimestamp();

            var (historyResult, historyComment) = DetermineCommentChange(oldComment, newComment);

            await _ioRepository.UpdateAsync(dbTag);
            await _historyService.AddTestHistoryAsync(dbTag.Id, historyResult, historyComment, tag.State);

            // Sync to cloud with the comment change result
            await SyncCommentChangeToCloudAsync(dbTag, tag.State, historyResult, historyComment);

            return CommentUpdateResult.Successful(changesWereMade: true);
        }
        catch (Exception ex)
        {
            return CommentUpdateResult.Failed($"Error updating comment: {ex.Message}");
        }
    }

    private async Task<bool> UpdateTestResultAsync(Io tag, string result, string comments)
    {
        try
        {
            var dbTag = await GetDbTagAsync(tag.Id);
            if (dbTag == null) return false;

            UpdateTagWithResult(dbTag, result, comments);
            await _ioRepository.UpdateAsync(dbTag);
            await _historyService.AddTestHistoryAsync(dbTag.Id, result, comments, tag.State);

            // Sync to cloud
            await SyncToCloudAsync(dbTag, tag.State);

            return true;
        }
        catch
        {
            return false;
        }
    }

    private async Task SyncToCloudAsync(Io io, string? state = null)
    {
        try
        {
            if (io.Id <= 0) return;

            // Get TestedBy from the most recent TestHistory record (not Environment.UserName)
            var history = await _historyService.GetHistoryForIoAsync(io.Id);
            var testedBy = history.FirstOrDefault()?.TestedBy ?? "Unknown";

            var update = new IoUpdateDto
            {
                Id = io.Id,
                Result = io.Result,
                Timestamp = io.Timestamp,
                Comments = io.Comments,
                TestedBy = testedBy, // Use actual user from TestHistory
                State = state,
                Version = io.Version
            };

            // Don't await - let it run in background
            _ = _cloudSyncService.SyncIoUpdateAsync(update).ContinueWith(task =>
            {
                if (!task.Result)
                {
                    _logger.LogWarning("Failed to sync IO {IoId} to cloud (will retry from queue)", io.Id);
                }
            }, TaskContinuationOptions.OnlyOnRanToCompletion);
        }
        catch (Exception ex)
        {
            // Log but don't fail the local operation
            _logger.LogError(ex, "Error syncing IO {IoId} to cloud", io.Id);
        }
    }

    private async Task SyncClearedToCloudAsync(Io io, string? state, string? historyResult, string? clearedComment)
    {
        try
        {
            if (io.Id <= 0) return;

            // Get TestedBy from the most recent TestHistory record (not Environment.UserName)
            var history = await _historyService.GetHistoryForIoAsync(io.Id);
            var testedBy = history.FirstOrDefault()?.TestedBy ?? "Unknown";

            var update = new IoUpdateDto
            {
                Id = io.Id,
                Result = historyResult,
                Timestamp = io.Timestamp,
                Comments = clearedComment,
                TestedBy = testedBy, // Use actual user from TestHistory
                State = state,
                Version = io.Version
            };

            // Don't await - let it run in background
            _ = _cloudSyncService.SyncIoUpdateAsync(update).ContinueWith(task =>
            {
                if (!task.Result)
                {
                    _logger.LogWarning("Failed to sync IO {IoId} to cloud (will retry from queue)", io.Id);
                }
            }, TaskContinuationOptions.OnlyOnRanToCompletion);
        }
        catch (Exception ex)
        {
            // Log but don't fail the local operation
            _logger.LogError(ex, "Error syncing IO {IoId} to cloud", io.Id);
        }
    }

    private async Task SyncCommentChangeToCloudAsync(Io io, string? state, string historyResult, string historyComment)
    {
        try
        {
            if (io.Id <= 0) return;

            var update = new IoUpdateDto
            {
                Id = io.Id,
                Result = historyResult,  // Send the comment change result type
                Timestamp = io.Timestamp,
                Comments = io.Comments,  // Send the actual current comment value, not the history text
                TestedBy = Environment.UserName,
                State = state,
                Version = io.Version
            };

            // Don't await - let it run in background
            _ = _cloudSyncService.SyncIoUpdateAsync(update).ContinueWith(task =>
            {
                if (!task.Result)
                {
                    _logger.LogWarning("Failed to sync IO {IoId} to cloud (will retry from queue)", io.Id);
                }
            }, TaskContinuationOptions.OnlyOnRanToCompletion);
        }
        catch (Exception ex)
        {
            // Log but don't fail the local operation
            _logger.LogError(ex, "Error syncing IO {IoId} to cloud", io.Id);
        }
    }

    private async Task<Io?> GetDbTagAsync(int tagId)
    {
        return await _ioRepository.GetByIdAsync(tagId);
    }

    private void UpdateTagWithResult(Io dbTag, string result, string comments)
    {
        var timestamp = CreateTimestamp();
        dbTag.Result = result;
        dbTag.Timestamp = timestamp;
        dbTag.Comments = comments;
    }

    private void ClearTagResult(Io dbTag)
    {
        var timestamp = CreateTimestamp();
        dbTag.Result = null;
        dbTag.Comments = "";
        dbTag.Timestamp = timestamp;
    }

    private string CreateTimestamp()
    {
        return DateTime.UtcNow.ToString(TestConstants.TIMESTAMP_FORMAT);
    }

    private (string historyResult, string historyComment) DetermineCommentChange(string? oldComment, string? newComment)
    {
        var historyResult = DetermineCommentChangeType(oldComment, newComment);
        var historyComment = CreateCommentHistoryText(oldComment, newComment);
        return (historyResult, historyComment);
    }

    private string DetermineCommentChangeType(string? oldComment, string? newComment)
    {
        if (string.IsNullOrEmpty(oldComment) && !string.IsNullOrEmpty(newComment))
            return TestConstants.RESULT_COMMENT_ADDED;
        
        if (!string.IsNullOrEmpty(oldComment) && string.IsNullOrEmpty(newComment))
            return TestConstants.RESULT_COMMENT_REMOVED;
        
        if (oldComment != newComment)
            return TestConstants.RESULT_COMMENT_MODIFIED;
        
        return TestConstants.RESULT_COMMENT_UPDATED;
    }

    private string CreateCommentHistoryText(string? oldComment, string? newComment)
    {
        // Normalize null/empty values for consistent comparison
        var normalizedOld = string.IsNullOrEmpty(oldComment) ? "" : oldComment;
        var normalizedNew = string.IsNullOrEmpty(newComment) ? "" : newComment;
        
        // If both are effectively empty, don't create history text
        if (normalizedOld == "" && normalizedNew == "")
            return "";
            
        if (string.IsNullOrEmpty(oldComment) && !string.IsNullOrEmpty(newComment))
            return newComment;
        
        if (!string.IsNullOrEmpty(oldComment) && string.IsNullOrEmpty(newComment))
            return $"Previous comment: {oldComment}";
        
        if (oldComment != newComment && !string.IsNullOrEmpty(oldComment))
            return $"New: {newComment} (Previous: {oldComment})";
        
        return newComment ?? "";
    }

    private IoUpdateDto CreateUpdateDto(Io io, string inspectorName)
    {
        return new IoUpdateDto
        {
            Id = io.Id,
            TestedBy = inspectorName,
            Result = io.Result,
            Comments = io.Comments,
            State = io.State,
            Version = io.Version, // Include current version for conflict detection
            Timestamp = io.Timestamp
        };
    }
} 