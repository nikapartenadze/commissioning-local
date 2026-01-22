using System.Net.Http;

namespace IO_Checkout_Tool.Services.Interfaces;

/// <summary>
/// Abstraction for HTTP communication with cloud service.
/// Enables testing by allowing mock/test implementations.
/// </summary>
public interface IHttpCloudClient
{
    /// <summary>
    /// Gets or sets the timeout for HTTP requests
    /// </summary>
    TimeSpan Timeout { get; set; }

    /// <summary>
    /// Sends a GET request to the specified URL
    /// </summary>
    Task<HttpResponseMessage> GetAsync(string url, CancellationToken cancellationToken = default);

    /// <summary>
    /// Sends a GET request to the specified URL with custom headers
    /// </summary>
    Task<HttpResponseMessage> GetAsync(string url, Dictionary<string, string> headers, CancellationToken cancellationToken = default);

    /// <summary>
    /// Sends a POST request to the specified URL with the given content
    /// </summary>
    Task<HttpResponseMessage> PostAsync(string url, HttpContent content, CancellationToken cancellationToken = default);

    /// <summary>
    /// Sends a POST request to the specified URL with the given content and custom headers
    /// </summary>
    Task<HttpResponseMessage> PostAsync(string url, HttpContent content, Dictionary<string, string> headers, CancellationToken cancellationToken = default);
}
