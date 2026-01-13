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

if (!args.Contains("--allow-multiple-instances") && IO_Checkout_Tool.Extensions.ServiceCollectionExtensions.IsApplicationAlreadyRunning())
{
    Console.WriteLine(TestConstants.UiText.SINGLE_INSTANCE_MESSAGE);
    Console.ReadKey();
    Environment.Exit(0);
}

var builder = WebApplication.CreateBuilder(args);

// Configure application
builder.Configuration.AddJsonFile("config.json", optional: false, reloadOnChange: true);

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

// Add CORS for Next.js frontend
builder.Services.AddCors(options =>
{
    options.AddPolicy("NextJsFrontend", policy =>
    {
        policy.WithOrigins("http://localhost:3000", "https://localhost:3000", "http://localhost:3001", "https://localhost:3001")
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials();
    });
});

// Add API controllers
builder.Services.AddControllers();

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
app.UseAntiforgery();

// Map API controllers
app.MapControllers();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();
app.MapHub<Hub>(SignalRConstants.HUB_ENDPOINT);

app.Run();


