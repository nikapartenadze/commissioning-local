using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using IO_Checkout_Tool.Services.Interfaces;

namespace IO_Checkout_Tool.Tests.TestHelpers;

/// <summary>
/// Test implementation of IHttpCloudClient that records requests and allows setting responses
/// </summary>
public class TestHttpCloudClient : IHttpCloudClient
{
    private readonly Dictionary<string, HttpResponseMessage> _responses = new();
    private readonly List<HttpRequest> _requests = new();
    private readonly object _lock = new();

    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Gets all recorded HTTP requests
    /// </summary>
    public IReadOnlyList<HttpRequest> Requests
    {
        get
        {
            lock (_lock)
            {
                return _requests.ToList().AsReadOnly();
            }
        }
    }

    /// <summary>
    /// Sets a response for a specific URL pattern
    /// </summary>
    public void SetResponse(string urlPattern, HttpResponseMessage response)
    {
        lock (_lock)
        {
            _responses[urlPattern] = response;
        }
    }

    /// <summary>
    /// Sets a successful JSON response for a URL pattern
    /// </summary>
    public void SetJsonResponse<T>(string urlPattern, T data, HttpStatusCode statusCode = HttpStatusCode.OK)
    {
        var json = JsonSerializer.Serialize(data);
        var content = new StringContent(json, Encoding.UTF8, "application/json");
        var response = new HttpResponseMessage(statusCode)
        {
            Content = content
        };
        SetResponse(urlPattern, response);
    }

    /// <summary>
    /// Sets an error response for a URL pattern
    /// </summary>
    public void SetErrorResponse(string urlPattern, HttpStatusCode statusCode, string? errorMessage = null)
    {
        var response = new HttpResponseMessage(statusCode);
        if (!string.IsNullOrEmpty(errorMessage))
        {
            response.Content = new StringContent(errorMessage, Encoding.UTF8, "text/plain");
        }
        SetResponse(urlPattern, response);
    }

    /// <summary>
    /// Clears all recorded requests and responses
    /// </summary>
    public void Clear()
    {
        lock (_lock)
        {
            _requests.Clear();
            foreach (var response in _responses.Values)
            {
                response.Dispose();
            }
            _responses.Clear();
        }
    }

    public Task<HttpResponseMessage> GetAsync(string url, CancellationToken cancellationToken = default)
    {
        return GetAsync(url, new Dictionary<string, string>(), cancellationToken);
    }

    public Task<HttpResponseMessage> GetAsync(string url, Dictionary<string, string> headers, CancellationToken cancellationToken = default)
    {
        lock (_lock)
        {
            _requests.Add(new HttpRequest
            {
                Method = HttpMethod.Get,
                Url = url,
                Headers = new Dictionary<string, string>(headers),
                Timestamp = DateTime.UtcNow
            });
        }

        return Task.FromResult(GetResponse(url));
    }

    public Task<HttpResponseMessage> PostAsync(string url, HttpContent content, CancellationToken cancellationToken = default)
    {
        return PostAsync(url, content, new Dictionary<string, string>(), cancellationToken);
    }

    public async Task<HttpResponseMessage> PostAsync(string url, HttpContent content, Dictionary<string, string> headers, CancellationToken cancellationToken = default)
    {
        string? body = null;
        if (content != null)
        {
            body = await content.ReadAsStringAsync(cancellationToken);
        }

        lock (_lock)
        {
            _requests.Add(new HttpRequest
            {
                Method = HttpMethod.Post,
                Url = url,
                Headers = new Dictionary<string, string>(headers),
                Body = body,
                Timestamp = DateTime.UtcNow
            });
        }

        return GetResponse(url);
    }

    private HttpResponseMessage GetResponse(string url)
    {
        lock (_lock)
        {
            // Try exact match first
            if (_responses.TryGetValue(url, out var exactResponse))
            {
                return CloneResponse(exactResponse);
            }

            // Try pattern match (simple contains check)
            var matchingKey = _responses.Keys.FirstOrDefault(k => url.Contains(k) || k.Contains(url));
            if (matchingKey != null && _responses.TryGetValue(matchingKey, out var patternResponse))
            {
                return CloneResponse(patternResponse);
            }

            // Default: return 200 OK with empty content
            return new HttpResponseMessage(HttpStatusCode.OK);
        }
    }

    private HttpResponseMessage CloneResponse(HttpResponseMessage original)
    {
        var cloned = new HttpResponseMessage(original.StatusCode);
        
        // Copy headers
        foreach (var header in original.Headers)
        {
            cloned.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }

        // Clone content if present
        if (original.Content != null)
        {
            var contentString = original.Content.ReadAsStringAsync().GetAwaiter().GetResult();
            cloned.Content = new StringContent(contentString, Encoding.UTF8, original.Content.Headers.ContentType?.MediaType ?? "application/json");
            
            // Copy content headers
            foreach (var header in original.Content.Headers)
            {
                cloned.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }
        }

        return cloned;
    }
}

/// <summary>
/// Represents an HTTP request made to the test client
/// </summary>
public class HttpRequest
{
    public HttpMethod Method { get; set; } = null!;
    public string Url { get; set; } = null!;
    public Dictionary<string, string> Headers { get; set; } = new();
    public string? Body { get; set; }
    public DateTime Timestamp { get; set; }
}
