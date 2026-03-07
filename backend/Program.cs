using MudBlazor.Services;
using Microsoft.AspNetCore.ResponseCompression;
using IO_Checkout_Tool.Hubs;
using Microsoft.AspNetCore.Hosting.StaticWebAssets;
using Microsoft.EntityFrameworkCore;
using IO_Checkout_Tool;
using IO_Checkout_Tool.Repositories;
using Shared.Library.Repositories.Interfaces;
using IO_Checkout_Tool.Services;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Services.State;
using IO_Checkout_Tool.Controllers;
using IO_Checkout_Tool.Constants;
using IO_Checkout_Tool.Models;
using System.Diagnostics;
using IO_Checkout_Tool.Extensions;
using System.IO.Compression;
using System.Text;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.IdentityModel.Tokens;
using Serilog;

if (!args.Contains("--allow-multiple-instances") && IO_Checkout_Tool.Extensions.ServiceCollectionExtensions.IsApplicationAlreadyRunning())
{
    Console.WriteLine(TestConstants.UiText.SINGLE_INSTANCE_MESSAGE);
    Console.ReadKey();
    Environment.Exit(0);
}

var builder = WebApplication.CreateBuilder(args);

// Windows Service support (only activates when running as a service, no-op otherwise)
if (OperatingSystem.IsWindows())
{
    builder.Host.UseWindowsService();
}

// Ensure data directory exists (for Docker DATA_DIR support)
var dataDir = DatabaseConstants.DataDir;
if (dataDir != "." && !Directory.Exists(dataDir))
{
    Directory.CreateDirectory(dataDir);
}

// Configure Serilog
var logsDir = DatabaseConstants.LogsDir;
if (!Directory.Exists(logsDir))
{
    Directory.CreateDirectory(logsDir);
}

Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .MinimumLevel.Override("Microsoft", Serilog.Events.LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.AspNetCore", Serilog.Events.LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.EntityFrameworkCore", Serilog.Events.LogEventLevel.Warning)
    .Enrich.FromLogContext()
    .WriteTo.Console()
    .WriteTo.File(
        Path.Combine(logsDir, "backend-.log"),
        rollingInterval: RollingInterval.Day,
        retainedFileCountLimit: 30,
        outputTemplate: "{Timestamp:yyyy-MM-dd HH:mm:ss.fff} [{Level:u3}] {SourceContext}: {Message:lj}{NewLine}{Exception}")
    .CreateLogger();

builder.Host.UseSerilog();

// Resolve config.json path (supports DATA_DIR for Docker)
var configPath = dataDir == "." ? "config.json" : Path.Combine(dataDir, "config.json");
var templatePath = "config.json.template";

// Ensure config.json exists (create from template or empty defaults if missing)
if (!File.Exists(configPath))
{
    if (File.Exists(templatePath))
    {
        File.Copy(templatePath, configPath);
        Log.Information("Created config.json from template at {Path}", configPath);
    }
    else
    {
        var defaultConfig = new Dictionary<string, object>
        {
            { "ip", "" },
            { "path", "" },
            { "subsystemId", "" },
            { "remoteUrl", "" },
            { "ApiPassword", "" },
            { "orderMode", "0" },
            { "syncBatchSize", 50 },
            { "syncBatchDelayMs", 500 }
        };
        var json = System.Text.Json.JsonSerializer.Serialize(defaultConfig, new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(configPath, json);
        Log.Information("Created empty config.json at {Path}. Configure via the UI.", configPath);
    }
}

// Configure application — optional: true so the app starts even if config.json is malformed
builder.Configuration.AddJsonFile(configPath, optional: true, reloadOnChange: true);

// Add application configuration
builder.Services.AddApplicationConfiguration(builder.Configuration);

// Add core services
builder.Services.AddRazorPages();
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();
builder.Services.AddMudServices();

// Enhanced response compression for industrial/PLC applications
builder.Services.AddResponseCompression(opts =>
{
    // Include MIME types commonly used in PLC/industrial applications
    opts.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat([
        "application/octet-stream",
        "application/json",           // I/O data, API responses
        "text/json",                  // Alternative JSON content type
        "text/plain",                 // Log data, CSV exports
        "text/csv"                    // Export files
    ]);
    
    // Use both Brotli and Gzip for optimal compression
    opts.Providers.Add<BrotliCompressionProvider>();
    opts.Providers.Add<GzipCompressionProvider>();
    
    // Enable for HTTPS connections
    opts.EnableForHttps = true;
});

// Configure Brotli compression for better performance with repetitive I/O data
builder.Services.Configure<BrotliCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.Optimal;
});

// Configure Gzip compression
builder.Services.Configure<GzipCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.Optimal;
});

builder.Services.AddHttpClient();

// Add CORS for Next.js frontend (supports Docker and any host)
builder.Services.AddCors(options =>
{
    options.AddPolicy("NextJsFrontend", policy =>
    {
        policy.SetIsOriginAllowed(origin =>
              {
                  var uri = new Uri(origin);
                  // Allow frontend ports: 3000 (Docker), 3002 (dev), 5000 (backend)
                  return uri.Port == 5000 || uri.Port == 3002 || uri.Port == 3000;
              })
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials();
    });
});

// Add API controllers
builder.Services.AddControllers();

// Add JWT authentication
var jwtSecretKey = builder.Configuration["Jwt:SecretKey"] ?? "F4ct0ry-C0mm1ss10n1ng-JWT-S3cr3t-K3y-2026!";
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = builder.Configuration["Jwt:Issuer"] ?? "io-checkout-tool",
            ValidAudience = builder.Configuration["Jwt:Audience"] ?? "io-checkout-frontend",
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtSecretKey))
        };

        // Extract token from SignalR query string
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                var accessToken = context.Request.Query["access_token"];
                var path = context.HttpContext.Request.Path;
                if (!string.IsNullOrEmpty(accessToken) && path.StartsWithSegments("/hub"))
                {
                    context.Token = accessToken;
                }
                return Task.CompletedTask;
            }
        };
    });
builder.Services.AddAuthorization();

// Rate limiting for login endpoint
builder.Services.AddRateLimiter(options =>
{
    options.AddFixedWindowLimiter("AuthRateLimit", limiterOptions =>
    {
        limiterOptions.PermitLimit = 5;
        limiterOptions.Window = TimeSpan.FromMinutes(1);
        limiterOptions.QueueLimit = 0;
    });
    options.RejectionStatusCode = 429;
});

StaticWebAssetsLoader.UseStaticWebAssets(builder.Environment, builder.Configuration);

// Add application services using extension methods
builder.Services
    .AddDatabaseContext(builder.Configuration)
    .AddRepositories()
    .AddCoreServices()
    .AddPlcServices()
    .AddBusinessServices()
    .AddStateManagement()
    .AddSignalRServices()
    .AddBusinessControllers();

// Register hosted services
builder.Services.AddHostedServices();

var app = builder.Build();

// Check for database seeding command-line argument
if (args.Contains("--seed-database"))
{
    Console.WriteLine("Database seeding requested. Starting seeding process...");
    
    using (var scope = app.Services.CreateScope())
    {
        var seedingService = scope.ServiceProvider.GetRequiredService<IDatabaseSeedingService>();
        var success = await seedingService.SeedDatabaseWithTestTagsAsync(1000);
        
        if (success)
        {
            Console.WriteLine("Database successfully seeded with 1000 test tags (tag1-tag1000).");
        }
        else
        {
            Console.WriteLine("Database seeding failed. Check the logs for details.");
        }
    }
    
    Console.WriteLine("Press any key to continue with normal application startup...");
    Console.ReadKey();
}

// Configure the HTTP request pipeline.
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
    app.UseHsts();
}

// Enable response compression in all environments for better performance
app.UseResponseCompression();

// Enable CORS
app.UseCors("NextJsFrontend");

app.UseStaticFiles();
app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();
app.UseAntiforgery();

// Map API controllers
app.MapControllers();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();
app.MapHub<Hub>(SignalRConstants.HUB_ENDPOINT);

app.Run();


