using System.Net.Http;
using IO_Checkout_Tool.Services.Interfaces;

namespace IO_Checkout_Tool.Services;

/// <summary>
/// Production implementation of IHttpCloudClient that wraps HttpClient
/// </summary>
public class HttpCloudClient : IHttpCloudClient
{
    private readonly HttpClient _httpClient;

    public HttpCloudClient(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public TimeSpan Timeout
    {
        get => _httpClient.Timeout;
        set => _httpClient.Timeout = value;
    }

    public Task<HttpResponseMessage> GetAsync(string url, CancellationToken cancellationToken = default)
    {
        return GetAsync(url, new Dictionary<string, string>(), cancellationToken);
    }

    public Task<HttpResponseMessage> GetAsync(string url, Dictionary<string, string> headers, CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        foreach (var header in headers)
        {
            request.Headers.Add(header.Key, header.Value);
        }
        return _httpClient.SendAsync(request, cancellationToken);
    }

    public Task<HttpResponseMessage> PostAsync(string url, HttpContent content, CancellationToken cancellationToken = default)
    {
        return PostAsync(url, content, new Dictionary<string, string>(), cancellationToken);
    }

    public Task<HttpResponseMessage> PostAsync(string url, HttpContent content, Dictionary<string, string> headers, CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = content
        };
        foreach (var header in headers)
        {
            request.Headers.Add(header.Key, header.Value);
        }
        return _httpClient.SendAsync(request, cancellationToken);
    }
}
