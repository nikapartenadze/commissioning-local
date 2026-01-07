using IO_Checkout_Tool.SharedComponents;
using IO_Checkout_Tool.Models.Common;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface IIoTestService
{
    Task<Io?> GetNextUntestedTagAsync();
    Task<bool> MarkTestPassedAsync(Io tag, string comments = "");
    Task<bool> MarkTestFailedAsync(Io tag, string comments);
    Task<bool> ClearTestResultAsync(Io tag);
    Task<CommentUpdateResult> UpdateCommentAsync(Io tag, string newComment);
} 