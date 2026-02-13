using Microsoft.EntityFrameworkCore;
using IO_Checkout_Tool.Models;
using IO_Checkout_Tool.Models.Configuration;
using IO_Checkout_Tool.Repositories;
using Shared.Library.Repositories.Interfaces;
using IO_Checkout_Tool.Services;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Services.State;
using IO_Checkout_Tool.Controllers;
using IO_Checkout_Tool.Constants;
using IO_Checkout_Tool.Hubs;
using IO_Checkout_Tool.Services.Common;
using MessagePack;

namespace IO_Checkout_Tool.Extensions;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddApplicationConfiguration(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<PlcConfiguration>(configuration);
        
        // Bind the ConfigurationSettings from the root configuration
        services.Configure<ConfigurationSettings>(configuration);
        
        return services;
    }

    public static IServiceCollection AddDatabaseContext(this IServiceCollection services, IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("SQLite") 
            ?? DatabaseConstants.SQLITE_CONNECTION_STRING;
        
        services.AddDbContextFactory<TagsContext>(opt => 
            opt.UseSqlite(connectionString, options =>
            {
                options.CommandTimeout(30); // 30 second timeout
            })
            .EnableSensitiveDataLogging(false)
            .EnableServiceProviderCaching(true));
        
        return services;
    }

    public static IServiceCollection AddRepositories(this IServiceCollection services)
    {
        services.AddScoped<IIoRepository, IoRepository>();
        services.AddScoped<ITestHistoryRepository, TestHistoryRepository>();
        services.AddScoped<IPendingSyncRepository, PendingSyncRepository>();
        services.AddScoped<IUserRepository, UserRepository>();
        return services;
    }

    public static IServiceCollection AddCoreServices(this IServiceCollection services)
    {
        services.AddSingleton<IConfigurationService, ConfigurationService>();
        services.AddSingleton<IErrorDialogService, ErrorDialogService>();
        services.AddSingleton<ISimpleDialogService, SimpleDialogService>();
        services.AddSingleton<IStartupCoordinationService, StartupCoordinationService>();

        services.AddSingleton<IWatchdogService, WatchdogService>();
        services.AddScoped<IErrorHandlingService, ErrorHandlingService>();
        services.AddSingleton<IDialogCoordinatorService, DialogCoordinatorService>();
        services.AddScoped<IDatabaseSeedingService, DatabaseSeedingService>();
        return services;
    }

    public static IServiceCollection AddPlcServices(this IServiceCollection services)
    {
        services.AddSingleton<IPlcTagFactoryService, PlcTagFactoryService>();
        services.AddSingleton<ITagReaderService, NativeTagReaderService>();
        services.AddSingleton<ITagWriterService, TagWriterService>();
        services.AddSingleton<IPlcConnectionService, PlcConnectionService>();
        services.AddSingleton<IPlcCommunicationService, PlcCommunicationService>();
        services.AddSingleton<IPlcInitializationService, PlcInitializationService>();
        services.AddSingleton<ITagChangeFrequencyService, TagChangeFrequencyService>();
        return services;
    }

    public static IServiceCollection AddBusinessServices(this IServiceCollection services)
    {
        services.AddScoped<ITestHistoryService, TestHistoryService>();
        services.AddScoped<IIoTestService, IoTestService>();
        services.AddScoped<IIoStatisticsService, IoStatisticsService>();
        services.AddScoped<IGraphDataService, GraphDataService>();
        services.AddScoped<ITestExecutionService, TestExecutionService>();
        services.AddScoped<IDialogManagerService, DialogManagerService>();
        services.AddScoped<IExportService, ExportService>();
        services.AddSingleton<ISignalRService, SignalRService>();
        services.AddScoped<IFilterService, FilterService>();
        
        // Register cloud sync abstractions
        services.AddSingleton<IHttpCloudClient, HttpCloudClient>();
        services.AddSingleton<ISignalRCloudClient, SignalRCloudClient>();
        
        services.AddSingleton<ICloudSyncService, ResilientCloudSyncService>();
        services.AddSingleton<ResilientCloudSyncService>();
        services.AddScoped<IAuthService, AuthService>();
        return services;
    }

    public static IServiceCollection AddStateManagement(this IServiceCollection services)
    {
        services.AddScoped<IAppStateService, AppStateService>();
        return services;
    }

    public static IServiceCollection AddSignalRServices(this IServiceCollection services)
    {
        services.AddSignalR(options =>
        {
            // Optimize for industrial/PLC applications
            options.KeepAliveInterval = TimeSpan.FromSeconds(10);
            options.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
            options.HandshakeTimeout = TimeSpan.FromSeconds(15);
            options.EnableDetailedErrors = true;
            
            // Optimize for compressed data transmission
            options.MaximumReceiveMessageSize = 1024 * 1024; // 1MB for large I/O datasets
        })
        .AddMessagePackProtocol(options =>
        {
            // Configure MessagePack for optimal I/O data serialization
            options.SerializerOptions = MessagePackSerializerOptions.Standard
                .WithCompression(MessagePackCompression.Lz4BlockArray)
                .WithSecurity(MessagePackSecurity.UntrustedData);
        });
        
        return services;
    }

    public static IServiceCollection AddBusinessControllers(this IServiceCollection services)
    {
        services.AddScoped<TestExecutionController>();
        services.AddScoped<DialogController>();
        services.AddScoped<EventHandlingController>();
        return services;
    }

    public static IServiceCollection AddHostedServices(this IServiceCollection services)
    {
        services.AddHostedService<DatabaseInitializationHostedService>();
        services.AddHostedService<CloudSyncHostedService>();           // Run cloud sync FIRST
        services.AddHostedService<PlcInitializationHostedService>();   // Run PLC init AFTER cloud sync
        services.AddHostedService<OfflineSyncHostedService>();
        services.AddHostedService<CloudReconnectionHostedService>();

        // Config file watcher for auto-reinitialization on external config.json changes
        services.AddHostedService<ConfigFileWatcherService>();

        // PLC Simulator (for testing without physical PLC)
        services.AddSingleton<PlcSimulatorService>();
        services.AddHostedService(sp => sp.GetRequiredService<PlcSimulatorService>());

        return services;
    }

    public static bool IsApplicationAlreadyRunning()
    {
        var currentProcess = System.Diagnostics.Process.GetCurrentProcess();
        var existingProcesses = System.Diagnostics.Process.GetProcessesByName(currentProcess.ProcessName);
        return existingProcesses.Length > DatabaseConstants.Defaults.SINGLE_INSTANCE_MAX_COUNT;
    }
} 