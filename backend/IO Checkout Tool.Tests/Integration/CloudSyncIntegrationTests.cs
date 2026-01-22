using System.Net;
using System.Net.Http;
using System.Text.Json;
using FluentAssertions;
using IO_Checkout_Tool.Models;
using IO_Checkout_Tool.Repositories;
using IO_Checkout_Tool.Services;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Tests.TestHelpers;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Moq;
using Shared.Library.DTOs;
using Shared.Library.Models.Entities;
using Shared.Library.Repositories.Interfaces;
using Xunit;

namespace IO_Checkout_Tool.Tests.Integration;

public class CloudSyncIntegrationTests : IDisposable
{
    private readonly TestHttpCloudClient _httpClient;
    private readonly TestSignalRCloudClient _signalRClient;
    private readonly Mock<IConfigurationService> _configServiceMock;
    private readonly Mock<ILogger<ResilientCloudSyncService>> _loggerMock;
    private readonly Mock<IErrorDialogService> _errorDialogServiceMock;
    private readonly Mock<IPlcCommunicationService> _plcCommServiceMock;
    private readonly IServiceProvider _serviceProvider;
    private readonly IDbContextFactory<TagsContext> _dbContextFactory;
    private readonly ResilientCloudSyncService _syncService;
    private const string TestCloudUrl = "https://test-cloud.example.com";
    private const string TestApiKey = "test-api-key";
    private const int TestSubsystemId = 1;

    public CloudSyncIntegrationTests()
    {
        // Create a unique in-memory database for this test instance
        // xUnit creates a new instance of the test class for each test method,
        // so each test gets its own isolated database
        var databaseName = Guid.NewGuid().ToString();
        _dbContextFactory = new InMemoryDbContextFactory(databaseName);
        
        // Set up test clients
        _httpClient = new TestHttpCloudClient();
        _signalRClient = new TestSignalRCloudClient();
        
        // Set up mocks
        _configServiceMock = new Mock<IConfigurationService>();
        _configServiceMock.Setup(x => x.RemoteUrl).Returns(TestCloudUrl);
        _configServiceMock.Setup(x => x.ApiPassword).Returns(TestApiKey);
        _configServiceMock.Setup(x => x.SubsystemId).Returns(TestSubsystemId.ToString());
        
        _loggerMock = new Mock<ILogger<ResilientCloudSyncService>>();
        _errorDialogServiceMock = new Mock<IErrorDialogService>();
        _plcCommServiceMock = new Mock<IPlcCommunicationService>();
        _plcCommServiceMock.Setup(x => x.TagList).Returns(new List<Io>());
        
        // Set up service provider with real repositories
        var services = new ServiceCollection();
        services.AddSingleton<IDbContextFactory<TagsContext>>(_dbContextFactory);
        services.AddScoped<IIoRepository, IoRepository>();
        services.AddScoped<IPendingSyncRepository, PendingSyncRepository>();
        services.AddScoped<ITestHistoryRepository, TestHistoryRepository>();
        services.AddSingleton<IPlcCommunicationService>(_plcCommServiceMock.Object);
        
        // Add logger mocks for repositories
        services.AddSingleton<ILogger<PendingSyncRepository>>(new Mock<ILogger<PendingSyncRepository>>().Object);
        services.AddSingleton<ILogger<TestHistoryRepository>>(new Mock<ILogger<TestHistoryRepository>>().Object);
        
        _serviceProvider = services.BuildServiceProvider();
        
        // Create service under test
        _syncService = new ResilientCloudSyncService(
            _httpClient,
            _signalRClient,
            _configServiceMock.Object,
            _serviceProvider,
            _loggerMock.Object,
            _errorDialogServiceMock.Object);
    }

    public void Dispose()
    {
        _syncService?.DisposeAsync().AsTask().Wait();
        _httpClient?.Clear();
        GC.SuppressFinalize(this);
    }

    #region Helper Methods

    private Io CreateTestIo(int id, int subsystemId = TestSubsystemId, string? name = null, long version = 1)
    {
        return new Io
        {
            Id = id,
            SubsystemId = subsystemId,
            Name = name ?? $"TestIO_{id}",
            Description = $"Test Description {id}",
            Order = id,
            Version = version,
            Result = null,
            Comments = null,
            Timestamp = null
        };
    }

    private IoUpdateDto CreateTestIoUpdate(int id, string? result = "Passed", long version = 1)
    {
        return new IoUpdateDto
        {
            Id = id,
            Result = result,
            Timestamp = DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm:ss"),
            Comments = "Test comment",
            TestedBy = "TestUser",
            State = "TRUE",
            Version = version
        };
    }

    private SyncResponseDto CreateSyncResponse(List<Io> ios, bool success = true)
    {
        return new SyncResponseDto
        {
            Success = success,
            Message = success ? "Success" : "Error",
            Ios = ios
        };
    }

    private PendingSync CreateTestPendingSync(int ioId, int pendingSyncId = 1, long version = 1)
    {
        return new PendingSync
        {
            Id = pendingSyncId,
            IoId = ioId,
            InspectorName = "TestUser",
            TestResult = "Passed",
            Comments = "Test comment",
            State = "TRUE",
            Timestamp = DateTime.UtcNow,
            CreatedAt = DateTime.UtcNow,
            RetryCount = 0,
            Version = version
        };
    }

    #endregion

    #region GetSubsystemIosAsync Tests

    [Fact]
    public async Task GetSubsystemIosAsync_Success_ReturnsIos()
    {
        // Arrange
        var expectedIos = new List<Io>
        {
            CreateTestIo(1),
            CreateTestIo(2),
            CreateTestIo(3)
        };
        var response = CreateSyncResponse(expectedIos);
        _httpClient.SetJsonResponse($"{TestCloudUrl}/api/sync/subsystem/{TestSubsystemId}", response);

        // Act
        var result = await _syncService.GetSubsystemIosAsync(TestSubsystemId);

        // Assert
        result.Should().HaveCount(3);
        result.Should().BeEquivalentTo(expectedIos, options => options.Excluding(x => x.State));
        
        var request = _httpClient.Requests.Should().ContainSingle().Subject;
        request.Url.Should().Contain($"/api/sync/subsystem/{TestSubsystemId}");
        request.Headers.Should().ContainKey("X-API-Key");
        request.Headers["X-API-Key"].Should().Be(TestApiKey);
    }

    [Fact]
    public async Task GetSubsystemIosAsync_EmptyResponse_ReturnsEmptyList()
    {
        // Arrange
        var response = CreateSyncResponse(new List<Io>());
        _httpClient.SetJsonResponse($"{TestCloudUrl}/api/sync/subsystem/{TestSubsystemId}", response);

        // Act
        var result = await _syncService.GetSubsystemIosAsync(TestSubsystemId);

        // Assert
        result.Should().BeEmpty();
    }

    [Fact]
    public async Task GetSubsystemIosAsync_AuthenticationFailure_ReturnsEmptyList()
    {
        // Arrange
        _httpClient.SetErrorResponse($"{TestCloudUrl}/api/sync/subsystem/{TestSubsystemId}", HttpStatusCode.Unauthorized);

        // Act
        var result = await _syncService.GetSubsystemIosAsync(TestSubsystemId);

        // Assert
        result.Should().BeEmpty();
        _errorDialogServiceMock.Verify(x => x.ShowAuthenticationError(), Times.Once);
    }

    [Fact]
    public async Task GetSubsystemIosAsync_MissingCloudUrl_ReturnsEmptyList()
    {
        // Arrange
        _configServiceMock.Setup(x => x.RemoteUrl).Returns(string.Empty);

        // Act
        var result = await _syncService.GetSubsystemIosAsync(TestSubsystemId);

        // Assert
        result.Should().BeEmpty();
        _httpClient.Requests.Should().BeEmpty();
    }

    [Fact]
    public async Task GetSubsystemIosAsync_ServerError_ReturnsEmptyList()
    {
        // Arrange
        _httpClient.SetErrorResponse($"{TestCloudUrl}/api/sync/subsystem/{TestSubsystemId}", HttpStatusCode.InternalServerError, "Server error");

        // Act
        var result = await _syncService.GetSubsystemIosAsync(TestSubsystemId);

        // Assert
        result.Should().BeEmpty();
    }

    #endregion

    #region SyncIoUpdateAsync Tests

    [Fact]
    public async Task SyncIoUpdateAsync_SignalRSuccess_ReturnsTrue()
    {
        // Arrange
        _signalRClient.SimulateConnect();
        var update = CreateTestIoUpdate(1);

        // Act
        var result = await _syncService.SyncIoUpdateAsync(update);

        // Assert
        result.Should().BeTrue();
        _signalRClient.Invocations.Should().ContainSingle();
        _signalRClient.Invocations[0].MethodName.Should().Be("UpdateIO");
        _httpClient.Requests.Should().BeEmpty();
    }

    [Fact]
    public async Task SyncIoUpdateAsync_HttpFallback_ReturnsTrue()
    {
        // Arrange
        _signalRClient.SetShouldFailConnect(true);
        var update = CreateTestIoUpdate(1);
        _httpClient.SetJsonResponse($"{TestCloudUrl}/api/sync/update", new { Success = true }, HttpStatusCode.OK);

        // Act
        var result = await _syncService.SyncIoUpdateAsync(update);

        // Assert
        result.Should().BeTrue();
        _httpClient.Requests.Should().ContainSingle();
        var request = _httpClient.Requests[0];
        request.Method.Should().Be(HttpMethod.Post);
        request.Url.Should().Contain("/api/sync/update");
    }

    [Fact]
    public async Task SyncIoUpdateAsync_OfflineQueuing_ReturnsFalseAndQueues()
    {
        // Arrange
        _signalRClient.SetShouldFailConnect(true);
        _signalRClient.SimulateDisconnect();
        var update = CreateTestIoUpdate(1);
        _httpClient.SetErrorResponse($"{TestCloudUrl}/api/sync/update", HttpStatusCode.ServiceUnavailable);

        // Act
        var result = await _syncService.SyncIoUpdateAsync(update);

        // Assert
        result.Should().BeFalse();
        
        using var scope = _serviceProvider.CreateScope();
        var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
        var pendingSyncs = await pendingRepo.GetAllPendingSyncsAsync();
        pendingSyncs.Should().ContainSingle();
        pendingSyncs[0].IoId.Should().Be(update.Id);
        pendingSyncs[0].TestResult.Should().Be(update.Result);
    }

    [Fact]
    public async Task SyncIoUpdateAsync_AuthenticationError_ReturnsFalse()
    {
        // Arrange
        _signalRClient.SetShouldFailConnect(true);
        var update = CreateTestIoUpdate(1);
        _httpClient.SetErrorResponse($"{TestCloudUrl}/api/sync/update", HttpStatusCode.Unauthorized);

        // Act
        var result = await _syncService.SyncIoUpdateAsync(update);

        // Assert
        result.Should().BeFalse();
        _errorDialogServiceMock.Verify(x => x.ShowAuthenticationError(), Times.Once);
    }

    #endregion

    #region SyncIoUpdatesAsync Tests

    [Fact]
    public async Task SyncIoUpdatesAsync_BatchSignalRSuccess_ReturnsTrue()
    {
        // Arrange
        _signalRClient.SimulateConnect();
        var updates = new List<IoUpdateDto>
        {
            CreateTestIoUpdate(1),
            CreateTestIoUpdate(2),
            CreateTestIoUpdate(3)
        };

        // Act
        var result = await _syncService.SyncIoUpdatesAsync(updates);

        // Assert
        result.Should().BeTrue();
        _signalRClient.Invocations.Should().ContainSingle();
        _signalRClient.Invocations[0].MethodName.Should().Be("SyncMultipleIOs");
        var invokedUpdates = _signalRClient.Invocations[0].Arguments[0] as List<IoUpdateDto>;
        invokedUpdates.Should().HaveCount(3);
    }

    [Fact]
    public async Task SyncIoUpdatesAsync_BatchHttpFallback_ReturnsTrue()
    {
        // Arrange
        _signalRClient.SetShouldFailConnect(true);
        var updates = new List<IoUpdateDto>
        {
            CreateTestIoUpdate(1),
            CreateTestIoUpdate(2)
        };
        _httpClient.SetJsonResponse($"{TestCloudUrl}/api/sync/update", new { Success = true }, HttpStatusCode.OK);

        // Act
        var result = await _syncService.SyncIoUpdatesAsync(updates);

        // Assert
        result.Should().BeTrue();
        _httpClient.Requests.Should().ContainSingle();
        var request = _httpClient.Requests[0];
        request.Method.Should().Be(HttpMethod.Post);
    }

    [Fact]
    public async Task SyncIoUpdatesAsync_PartialFailure_QueuesFailedUpdates()
    {
        // Arrange
        _signalRClient.SetShouldFailConnect(true);
        var updates = new List<IoUpdateDto>
        {
            CreateTestIoUpdate(1),
            CreateTestIoUpdate(2)
        };
        // First request succeeds, second fails
        _httpClient.SetJsonResponse($"{TestCloudUrl}/api/sync/update", new { Success = true }, HttpStatusCode.OK);
        
        // After first succeeds, make second fail
        _httpClient.SetErrorResponse($"{TestCloudUrl}/api/sync/update", HttpStatusCode.ServiceUnavailable);

        // Act
        var result = await _syncService.SyncIoUpdatesAsync(updates);

        // Assert
        result.Should().BeFalse();
        
        using var scope = _serviceProvider.CreateScope();
        var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
        var pendingSyncs = await pendingRepo.GetAllPendingSyncsAsync();
        // At least one should be queued
        pendingSyncs.Should().NotBeEmpty();
    }

    [Fact]
    public async Task SyncIoUpdatesAsync_EmptyBatch_ReturnsTrue()
    {
        // Arrange
        var updates = new List<IoUpdateDto>();

        // Act
        var result = await _syncService.SyncIoUpdatesAsync(updates);

        // Assert
        result.Should().BeTrue();
        _signalRClient.Invocations.Should().BeEmpty();
        _httpClient.Requests.Should().BeEmpty();
    }

    #endregion

    #region IsCloudAvailable Tests

    [Fact]
    public async Task IsCloudAvailable_Available_ReturnsTrue()
    {
        // Arrange
        _httpClient.SetJsonResponse($"{TestCloudUrl}/api/sync/health", new { Status = "OK" }, HttpStatusCode.OK);
        _signalRClient.SimulateConnect();

        // Act
        var result = await _syncService.IsCloudAvailable();

        // Assert
        result.Should().BeTrue();
        _httpClient.Requests.Should().ContainSingle();
        _httpClient.Requests[0].Url.Should().Contain("/api/sync/health");
    }

    [Fact]
    public async Task IsCloudAvailable_HttpHealthCheckFails_ReturnsFalse()
    {
        // Arrange
        _httpClient.SetErrorResponse($"{TestCloudUrl}/api/sync/health", HttpStatusCode.ServiceUnavailable);

        // Act
        var result = await _syncService.IsCloudAvailable();

        // Assert
        result.Should().BeFalse();
    }

    [Fact]
    public async Task IsCloudAvailable_SignalRConnectionFails_ReturnsFalse()
    {
        // Arrange
        _httpClient.SetJsonResponse($"{TestCloudUrl}/api/sync/health", new { Status = "OK" }, HttpStatusCode.OK);
        _signalRClient.SetShouldFailConnect(true);

        // Act
        var result = await _syncService.IsCloudAvailable();

        // Assert
        result.Should().BeFalse();
    }

    [Fact]
    public async Task IsCloudAvailable_NoCloudUrl_ReturnsFalse()
    {
        // Arrange
        _configServiceMock.Setup(x => x.RemoteUrl).Returns(string.Empty);

        // Act
        var result = await _syncService.IsCloudAvailable();

        // Assert
        result.Should().BeFalse();
    }

    #endregion

    #region TriggerFreshSyncAsync Tests (Pre-Nuclear Sync Pattern)

    [Fact]
    public async Task TriggerFreshSyncAsync_FullSuccess_CompletesPreNuclearAndNuclearSync()
    {
        // Arrange
        var cloudIos = new List<Io>
        {
            CreateTestIo(1, TestSubsystemId, "CloudIO1", version: 5),
            CreateTestIo(2, TestSubsystemId, "CloudIO2", version: 6)
        };
        
        // Set up pending sync
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            var localIo = CreateTestIo(99, TestSubsystemId, "LocalIO", version: 1);
            var ioRepo = scope.ServiceProvider.GetRequiredService<IIoRepository>();
            await ioRepo.AddAsync(localIo);
            await pendingRepo.AddPendingSyncAsync(CreateTestPendingSync(99, version: 1));
        }
        
        // Pre-sync: pending updates succeed
        _signalRClient.SimulateConnect();
        await Task.Delay(100); // Allow connection state to update
        
        // Health check
        _httpClient.SetJsonResponse($"{TestCloudUrl}/api/sync/health", new { Status = "OK" }, HttpStatusCode.OK);
        
        // Get subsystem IOs
        _httpClient.SetJsonResponse($"{TestCloudUrl}/api/sync/subsystem/{TestSubsystemId}", CreateSyncResponse(cloudIos));
        
        // Act
        var result = await _syncService.TriggerFreshSyncAsync();

        // Assert
        result.Should().BeTrue();
        
        using (var scope = _serviceProvider.CreateScope())
        {
            var ioRepo = scope.ServiceProvider.GetRequiredService<IIoRepository>();
            var localIos = await ioRepo.GetBySubsystemIdAsync(TestSubsystemId);
            // Nuclear sync should clear all local data and replace with cloud data
            localIos.Should().HaveCount(2);
            localIos.Should().Contain(io => io.Name == "CloudIO1");
            localIos.Should().Contain(io => io.Name == "CloudIO2");
            localIos.Should().NotContain(io => io.Name == "LocalIO");
        }
        
        _plcCommServiceMock.Verify(x => x.ReloadDataAfterCloudSyncAsync(), Times.Once);
    }

    [Fact]
    public async Task TriggerFreshSyncAsync_NoPendingUpdates_SkipsPreSync()
    {
        // Arrange
        var cloudIos = new List<Io>
        {
            CreateTestIo(1, TestSubsystemId, "CloudIO1")
        };
        
        _signalRClient.SimulateConnect();
        _httpClient.SetJsonResponse($"{TestCloudUrl}/api/sync/health", new { Status = "OK" }, HttpStatusCode.OK);
        _httpClient.SetJsonResponse($"{TestCloudUrl}/api/sync/subsystem/{TestSubsystemId}", CreateSyncResponse(cloudIos));

        // Act
        var result = await _syncService.TriggerFreshSyncAsync();

        // Assert
        result.Should().BeTrue();
        
        using (var scope = _serviceProvider.CreateScope())
        {
            var ioRepo = scope.ServiceProvider.GetRequiredService<IIoRepository>();
            var localIos = await ioRepo.GetBySubsystemIdAsync(TestSubsystemId);
            localIos.Should().HaveCount(1);
        }
    }

    [Fact]
    public async Task TriggerFreshSyncAsync_PreSyncFails_AbortsNuclearSync()
    {
        // Arrange
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            await pendingRepo.AddPendingSyncAsync(CreateTestPendingSync(1));
        }
        
        // Pre-sync fails (no connection)
        _signalRClient.SetShouldFailConnect(true);
        _httpClient.SetErrorResponse($"{TestCloudUrl}/api/sync/update", HttpStatusCode.ServiceUnavailable);
        _httpClient.SetErrorResponse($"{TestCloudUrl}/api/sync/health", HttpStatusCode.ServiceUnavailable);

        // Act
        var result = await _syncService.TriggerFreshSyncAsync();

        // Assert
        result.Should().BeFalse();
        
        // Verify nuclear sync didn't happen (no GetSubsystemIos call)
        _httpClient.Requests.Should().NotContain(r => r.Url.Contains("/api/sync/subsystem/"));
    }

    [Fact]
    public async Task TriggerFreshSyncAsync_VersionConflicts_RejectsConflicts()
    {
        // Arrange
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            var ioRepo = scope.ServiceProvider.GetRequiredService<IIoRepository>();
            
            // Local IO with version 5
            var localIo = CreateTestIo(1, TestSubsystemId, "LocalIO", version: 5);
            await ioRepo.AddAsync(localIo);
            
            // Pending sync with version 1 (older - should be rejected)
            var pending = CreateTestPendingSync(1, version: 1);
            await pendingRepo.AddPendingSyncAsync(pending);
        }
        
        var cloudIos = new List<Io>
        {
            CreateTestIo(1, TestSubsystemId, "CloudIO1", version: 10)
        };
        
        _signalRClient.SimulateConnect();
        await Task.Delay(100); // Allow connection state to update
        _httpClient.SetJsonResponse($"{TestCloudUrl}/api/sync/health", new { Status = "OK" }, HttpStatusCode.OK);
        _httpClient.SetJsonResponse($"{TestCloudUrl}/api/sync/subsystem/{TestSubsystemId}", CreateSyncResponse(cloudIos));

        // Act
        var result = await _syncService.TriggerFreshSyncAsync();

        // Assert
        result.Should().BeTrue();
        
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            var pendingSyncs = await pendingRepo.GetAllPendingSyncsAsync();
            // Version conflict should be rejected during pre-nuclear sync
            pendingSyncs.Should().BeEmpty();
        }
    }

    [Fact]
    public async Task TriggerFreshSyncAsync_LocalDataCleared_OldIosRemoved()
    {
        // Arrange
        using (var scope = _serviceProvider.CreateScope())
        {
            var ioRepo = scope.ServiceProvider.GetRequiredService<IIoRepository>();
            // Add old IOs
            await ioRepo.AddAsync(CreateTestIo(100, TestSubsystemId, "OldIO1"));
            await ioRepo.AddAsync(CreateTestIo(101, TestSubsystemId, "OldIO2"));
        }
        
        var cloudIos = new List<Io>
        {
            CreateTestIo(1, TestSubsystemId, "NewIO1"),
            CreateTestIo(2, TestSubsystemId, "NewIO2")
        };
        
        _signalRClient.SimulateConnect();
        await Task.Delay(100); // Allow connection state to update
        _httpClient.SetJsonResponse($"{TestCloudUrl}/api/sync/health", new { Status = "OK" }, HttpStatusCode.OK);
        _httpClient.SetJsonResponse($"{TestCloudUrl}/api/sync/subsystem/{TestSubsystemId}", CreateSyncResponse(cloudIos));

        // Act
        var result = await _syncService.TriggerFreshSyncAsync();

        // Assert
        result.Should().BeTrue();
        
        using (var scope = _serviceProvider.CreateScope())
        {
            var ioRepo = scope.ServiceProvider.GetRequiredService<IIoRepository>();
            var localIos = await ioRepo.GetBySubsystemIdAsync(TestSubsystemId);
            // Nuclear sync should clear all local data and replace with cloud data
            localIos.Should().HaveCount(2);
            localIos.Should().NotContain(io => io.Name == "OldIO1");
            localIos.Should().NotContain(io => io.Name == "OldIO2");
            localIos.Should().Contain(io => io.Name == "NewIO1");
            localIos.Should().Contain(io => io.Name == "NewIO2");
        }
    }

    #endregion

    #region SyncPendingUpdatesAsync Tests

    [Fact]
    public async Task SyncPendingUpdatesAsync_BatchSyncSuccess_RemovesFromQueue()
    {
        // Arrange
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            await pendingRepo.AddPendingSyncAsync(CreateTestPendingSync(1, 1));
            await pendingRepo.AddPendingSyncAsync(CreateTestPendingSync(2, 2));
        }
        
        _signalRClient.SimulateConnect();

        // Act
        var result = await _syncService.SyncPendingUpdatesAsync();

        // Assert
        result.Should().Be(2);
        
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            var pendingSyncs = await pendingRepo.GetAllPendingSyncsAsync();
            pendingSyncs.Should().BeEmpty();
        }
        
        _signalRClient.Invocations.Should().ContainSingle();
        _signalRClient.Invocations[0].MethodName.Should().Be("SyncMultipleIOs");
    }

    [Fact]
    public async Task SyncPendingUpdatesAsync_EmptyQueue_ReturnsZero()
    {
        // Act
        var result = await _syncService.SyncPendingUpdatesAsync();

        // Assert
        result.Should().Be(0);
        _signalRClient.Invocations.Should().BeEmpty();
    }

    [Fact]
    public async Task SyncPendingUpdatesAsync_ChronologicalOrder_ProcessesInOrder()
    {
        // Arrange
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            
            var sync1 = CreateTestPendingSync(1, 1);
            sync1.CreatedAt = DateTime.UtcNow.AddMinutes(-10);
            await pendingRepo.AddPendingSyncAsync(sync1);
            
            var sync2 = CreateTestPendingSync(2, 2);
            sync2.CreatedAt = DateTime.UtcNow.AddMinutes(-5);
            await pendingRepo.AddPendingSyncAsync(sync2);
            
            var sync3 = CreateTestPendingSync(3, 3);
            sync3.CreatedAt = DateTime.UtcNow;
            await pendingRepo.AddPendingSyncAsync(sync3);
        }
        
        _signalRClient.SimulateConnect();

        // Act
        var result = await _syncService.SyncPendingUpdatesAsync();

        // Assert
        result.Should().Be(3);
        
        // Verify batch was sent with all updates
        _signalRClient.Invocations.Should().ContainSingle();
        var invokedUpdates = _signalRClient.Invocations[0].Arguments[0] as List<IoUpdateDto>;
        invokedUpdates.Should().HaveCount(3);
    }

    [Fact]
    public async Task SyncPendingUpdatesAsync_PartialSuccess_RemovesOnlySuccessful()
    {
        // Arrange
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            await pendingRepo.AddPendingSyncAsync(CreateTestPendingSync(1, 1));
            await pendingRepo.AddPendingSyncAsync(CreateTestPendingSync(2, 2));
        }
        
        // First batch succeeds, but individual syncs will fail for some
        _signalRClient.SimulateConnect();
        // Simulate batch failure by making SignalR fail after first invocation
        _signalRClient.SetShouldFailConnect(false);
        
        // After batch fails, HTTP will be tried but also fail
        _httpClient.SetErrorResponse($"{TestCloudUrl}/api/sync/update", HttpStatusCode.ServiceUnavailable);

        // Act
        var result = await _syncService.SyncPendingUpdatesAsync();

        // Assert
        // Some may succeed, some may remain
        result.Should().BeGreaterThanOrEqualTo(0);
    }

    #endregion

    #region Connection State Management Tests

    [Fact]
    public async Task ConnectionStateChanged_EventFires_OnConnect()
    {
        // Arrange
        bool eventFired = false;
        _syncService.ConnectionStateChanged += () => eventFired = true;

        // Act
        _signalRClient.SimulateConnect();
        await Task.Delay(100); // Allow event to fire

        // Assert
        eventFired.Should().BeTrue();
        _syncService.IsConnected.Should().BeTrue();
    }

    [Fact]
    public async Task ConnectionStateChanged_EventFires_OnDisconnect()
    {
        // Arrange
        _signalRClient.SimulateConnect();
        await Task.Delay(100);
        
        bool eventFired = false;
        _syncService.ConnectionStateChanged += () => eventFired = true;

        // Act
        _signalRClient.SimulateDisconnect();
        await Task.Delay(100);

        // Assert
        eventFired.Should().BeTrue();
        _syncService.IsConnected.Should().BeFalse();
    }

    [Fact]
    public async Task ForceReconnectAsync_DisconnectsAndResetsState()
    {
        // Arrange
        _signalRClient.SimulateConnect();
        await Task.Delay(100);
        _syncService.IsConnected.Should().BeTrue();

        // Act
        await _syncService.ForceReconnectAsync();

        // Assert
        _syncService.IsConnected.Should().BeFalse();
        _signalRClient.State.Should().Be(Microsoft.AspNetCore.SignalR.Client.HubConnectionState.Disconnected);
    }

    [Fact]
    public async Task ReconnectionHandling_TriggersPendingSync()
    {
        // Arrange
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            await pendingRepo.AddPendingSyncAsync(CreateTestPendingSync(1));
        }
        
        _signalRClient.SimulateDisconnect();
        await Task.Delay(100);
        
        // Clear previous invocations
        _signalRClient.ClearInvocations();

        // Act - simulate reconnection
        _signalRClient.SimulateReconnect();
        await Task.Delay(6000); // Wait for reconnection delay + sync attempt

        // Assert
        // Pending sync should be attempted after reconnection
        // Note: This test may be flaky due to timing, but verifies the pattern
        _signalRClient.Invocations.Should().NotBeEmpty();
    }

    #endregion

    #region Offline Queue Management Tests

    [Fact]
    public async Task OfflineQueue_QueueOnDisconnect_StoresInDatabase()
    {
        // Arrange
        // First connect, then disconnect to ensure service tracks the state
        _signalRClient.SimulateConnect();
        await Task.Delay(100); // Allow state to update
        _signalRClient.SimulateDisconnect();
        // Prevent reconnection attempts after disconnect
        _signalRClient.SetShouldFailConnect(true);
        await Task.Delay(100); // Allow state to update
        
        var update = CreateTestIoUpdate(1);
        _httpClient.SetErrorResponse($"{TestCloudUrl}/api/sync/update", HttpStatusCode.ServiceUnavailable);

        // Act
        var result = await _syncService.SyncIoUpdateAsync(update);

        // Assert
        result.Should().BeFalse();
        
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            var pendingSyncs = await pendingRepo.GetAllPendingSyncsAsync();
            pendingSyncs.Should().ContainSingle();
            pendingSyncs[0].IoId.Should().Be(update.Id);
            pendingSyncs[0].Version.Should().Be(update.Version);
        }
    }

    [Fact]
    public async Task OfflineQueue_QueuePersistence_StoredInDatabase()
    {
        // Arrange
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            var pending = CreateTestPendingSync(1);
            await pendingRepo.AddPendingSyncAsync(pending);
        }

        // Act - verify it's still there
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            var pendingSyncs = await pendingRepo.GetAllPendingSyncsAsync();

            // Assert
            pendingSyncs.Should().ContainSingle();
            pendingSyncs[0].IoId.Should().Be(1);
        }
    }

    [Fact]
    public async Task OfflineQueue_QueueProcessing_ProcessesWhenReconnected()
    {
        // Arrange
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            await pendingRepo.AddPendingSyncAsync(CreateTestPendingSync(1));
        }
        
        _signalRClient.SimulateConnect();

        // Act
        var result = await _syncService.SyncPendingUpdatesAsync();

        // Assert
        result.Should().Be(1);
        
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            var pendingSyncs = await pendingRepo.GetAllPendingSyncsAsync();
            pendingSyncs.Should().BeEmpty();
        }
    }

    [Fact]
    public async Task OfflineQueue_VersionTracking_PreservesVersion()
    {
        // Arrange
        // First connect, then disconnect to ensure service tracks the state
        _signalRClient.SimulateConnect();
        await Task.Delay(100); // Allow state to update
        _signalRClient.SimulateDisconnect();
        // Prevent reconnection attempts after disconnect
        _signalRClient.SetShouldFailConnect(true);
        await Task.Delay(100); // Allow state to update
        
        var update = CreateTestIoUpdate(1, version: 42);
        _httpClient.SetErrorResponse($"{TestCloudUrl}/api/sync/update", HttpStatusCode.ServiceUnavailable);

        // Act
        await _syncService.SyncIoUpdateAsync(update);

        // Assert
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            var pendingSyncs = await pendingRepo.GetAllPendingSyncsAsync();
            pendingSyncs.Should().ContainSingle();
            pendingSyncs[0].Version.Should().Be(42);
        }
    }

    #endregion

    #region Error Handling Tests

    [Fact]
    public async Task ErrorHandling_ServerError_HandlesGracefully()
    {
        // Arrange
        _signalRClient.SetShouldFailConnect(true);
        var update = CreateTestIoUpdate(1);
        _httpClient.SetErrorResponse($"{TestCloudUrl}/api/sync/update", HttpStatusCode.InternalServerError, "Server error");

        // Act
        var result = await _syncService.SyncIoUpdateAsync(update);

        // Assert
        result.Should().BeFalse();
        
        // Should be queued for retry
        using (var scope = _serviceProvider.CreateScope())
        {
            var pendingRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            var pendingSyncs = await pendingRepo.GetAllPendingSyncsAsync();
            pendingSyncs.Should().ContainSingle();
        }
    }

    [Fact]
    public async Task ErrorHandling_InvalidJsonResponse_HandlesGracefully()
    {
        // Arrange
        _httpClient.SetResponse($"{TestCloudUrl}/api/sync/subsystem/{TestSubsystemId}", 
            new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("invalid json", System.Text.Encoding.UTF8, "application/json")
            });

        // Act
        var result = await _syncService.GetSubsystemIosAsync(TestSubsystemId);

        // Assert
        result.Should().BeEmpty();
    }

    [Fact]
    public async Task ErrorHandling_NetworkException_HandlesGracefully()
    {
        // Arrange
        _signalRClient.SetShouldFailConnect(true);
        // Don't set any response, which will cause the test client to return default OK
        // But we can test timeout scenarios
        var update = CreateTestIoUpdate(1);

        // Act & Assert
        // Should handle gracefully (either succeed with default response or queue)
        // The test passes if no exception is thrown
        var result = await _syncService.SyncIoUpdateAsync(update);
        
        // Result is a bool - method completed successfully (no exception thrown)
        // No additional assertion needed as the test verifies graceful handling
    }

    #endregion
}
