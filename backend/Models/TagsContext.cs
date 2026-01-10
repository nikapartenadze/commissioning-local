using Microsoft.EntityFrameworkCore;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Models;

public class TagsContext : DbContext
{
    private static bool _versionMigrationCompleted = false;
    private static readonly object _migrationLock = new object();
    
    public TagsContext(DbContextOptions<TagsContext> options) : base(options)
    {
        this.Database.EnsureCreated();
        
        // Configure SQLite for better concurrency
        try
        {
            this.Database.ExecuteSqlRaw("PRAGMA journal_mode=WAL;");
            this.Database.ExecuteSqlRaw("PRAGMA synchronous=NORMAL;");
            this.Database.ExecuteSqlRaw("PRAGMA cache_size=10000;");
            this.Database.ExecuteSqlRaw("PRAGMA temp_store=MEMORY;");
            this.Database.ExecuteSqlRaw("PRAGMA busy_timeout=30000;");
        }
        catch
        {
            // Ignore pragma errors - they're not critical
        }
        
        // Ensure TestHistories table exists (for backwards compatibility)
        try
        {
            // Check if TestHistories table exists by trying to query it
            var tableExists = this.Database.ExecuteSqlRaw("SELECT name FROM sqlite_master WHERE type='table' AND name='TestHistories';") > 0;
            
            if (!tableExists)
            {
                // Create the TestHistories table if it doesn't exist
                this.Database.ExecuteSqlRaw(@"
                    CREATE TABLE IF NOT EXISTS TestHistories (
                        Id INTEGER PRIMARY KEY AUTOINCREMENT,
                        IoId INTEGER NOT NULL,
                        Result TEXT,
                        State TEXT,
                        Comments TEXT,
                        TestedBy TEXT,
                        Timestamp TEXT NOT NULL,
                        FOREIGN KEY (IoId) REFERENCES Ios(Id)
                    );
                ");
            }
        }
        catch
        {
            // If any error occurs, try to create the table anyway
            this.Database.ExecuteSqlRaw(@"
                CREATE TABLE IF NOT EXISTS TestHistories (
                    Id INTEGER PRIMARY KEY AUTOINCREMENT,
                    IoId INTEGER NOT NULL,
                    Result TEXT,
                    State TEXT,
                    Comments TEXT,
                    TestedBy TEXT,
                    Timestamp TEXT NOT NULL,
                    FOREIGN KEY (IoId) REFERENCES Ios(Id)
                );
            ");
        }
        
        // Ensure PendingSyncs table exists for offline queue
        try
        {
            var pendingSyncsExists = this.Database.ExecuteSqlRaw("SELECT name FROM sqlite_master WHERE type='table' AND name='PendingSyncs';") > 0;
            
            if (!pendingSyncsExists)
            {
                this.Database.ExecuteSqlRaw(@"
                    CREATE TABLE IF NOT EXISTS PendingSyncs (
                        Id INTEGER PRIMARY KEY AUTOINCREMENT,
                        IoId INTEGER NOT NULL,
                        InspectorName TEXT,
                        TestResult TEXT,
                        Comments TEXT,
                        State TEXT,
                        Timestamp TEXT,
                        CreatedAt TEXT NOT NULL,
                        RetryCount INTEGER NOT NULL DEFAULT 0,
                        LastError TEXT,
                        Version INTEGER NOT NULL DEFAULT 0
                    );
                ");
                
                // Create indexes for better performance
                this.Database.ExecuteSqlRaw("CREATE INDEX IF NOT EXISTS idx_pendingsyncs_ioid ON PendingSyncs(IoId);");
                this.Database.ExecuteSqlRaw("CREATE INDEX IF NOT EXISTS idx_pendingsyncs_createdat ON PendingSyncs(CreatedAt);");
            }
            else
            {
                // Add State column if it doesn't exist (for existing databases)
                try
                {
                    this.Database.ExecuteSqlRaw("ALTER TABLE PendingSyncs ADD COLUMN State TEXT;");
                }
                catch
                {
                    // Column might already exist
                }
            }
        }
        catch
        {
            // If any error occurs, try to create the table anyway
            this.Database.ExecuteSqlRaw(@"
                CREATE TABLE IF NOT EXISTS PendingSyncs (
                    Id INTEGER PRIMARY KEY AUTOINCREMENT,
                    IoId INTEGER NOT NULL,
                    InspectorName TEXT,
                    TestResult TEXT,
                    Comments TEXT,
                    State TEXT,
                    Timestamp TEXT,
                    CreatedAt TEXT NOT NULL,
                    RetryCount INTEGER NOT NULL DEFAULT 0,
                    LastError TEXT,
                    Version INTEGER NOT NULL DEFAULT 0
                );
            ");
            
            this.Database.ExecuteSqlRaw("CREATE INDEX IF NOT EXISTS idx_pendingsyncs_ioid ON PendingSyncs(IoId);");
            this.Database.ExecuteSqlRaw("CREATE INDEX IF NOT EXISTS idx_pendingsyncs_createdat ON PendingSyncs(CreatedAt);");
        }
        
        // Add Version columns to existing tables for versioning system (only run once per app lifetime)
        if (!_versionMigrationCompleted)
        {
            lock (_migrationLock)
            {
                if (!_versionMigrationCompleted)
                {
                    try
                    {
                        // Try to select from Version column - if this fails, column doesn't exist
                        this.Database.ExecuteSqlRaw("SELECT Version FROM Ios LIMIT 1;");
                    }
                    catch
                    {
                        // Column doesn't exist, try to add it
                        try
                        {
                            this.Database.ExecuteSqlRaw("ALTER TABLE Ios ADD COLUMN Version INTEGER NOT NULL DEFAULT 0;");
                        }
                        catch
                        {
                            // Ignore any errors during column addition
                        }
                    }
                    
                    try
                    {
                        // Try to select from Version column - if this fails, column doesn't exist
                        this.Database.ExecuteSqlRaw("SELECT Version FROM PendingSyncs LIMIT 1;");
                    }
                    catch
                    {
                        // Column doesn't exist, try to add it
                        try
                        {
                            this.Database.ExecuteSqlRaw("ALTER TABLE PendingSyncs ADD COLUMN Version INTEGER NOT NULL DEFAULT 0;");
                        }
                        catch
                        {
                            // Ignore any errors during column addition
                        }
                    }
                    
                    _versionMigrationCompleted = true;
                }
            }
        }
        
        // Add new columns for diagnostic system
        try
        {
            this.Database.ExecuteSqlRaw("ALTER TABLE Ios ADD COLUMN TagType TEXT;");
        }
        catch { /* Column already exists */ }
        
        try
        {
            this.Database.ExecuteSqlRaw("ALTER TABLE TestHistories ADD COLUMN FailureMode TEXT;");
        }
        catch { /* Column already exists */ }
        
        // Create TagTypeDiagnostics table
        this.Database.ExecuteSqlRaw(@"
            CREATE TABLE IF NOT EXISTS TagTypeDiagnostics (
                TagType TEXT NOT NULL,
                FailureMode TEXT NOT NULL,
                DiagnosticSteps TEXT NOT NULL,
                CreatedAt TEXT NOT NULL,
                UpdatedAt TEXT,
                PRIMARY KEY (TagType, FailureMode)
            );
        ");
        
        // Ensure Users table exists
        try
        {
            var usersExists = this.Database.ExecuteSqlRaw("SELECT name FROM sqlite_master WHERE type='table' AND name='Users';") > 0;
            
            if (!usersExists)
            {
                this.Database.ExecuteSqlRaw(@"
                    CREATE TABLE IF NOT EXISTS Users (
                        Id INTEGER PRIMARY KEY AUTOINCREMENT,
                        FullName TEXT NOT NULL UNIQUE,
                        Pin TEXT NOT NULL,
                        IsAdmin INTEGER NOT NULL DEFAULT 0,
                        IsActive INTEGER NOT NULL DEFAULT 1,
                        CreatedAt TEXT NOT NULL,
                        LastUsedAt TEXT
                    );
                ");
                
                // Create default admin user with PIN: 852963 (only if it doesn't exist)
                // Hash the PIN using BCrypt (work factor 11)
                var adminPinHash = BCrypt.Net.BCrypt.HashPassword("852963", workFactor: 11);
                this.Database.ExecuteSqlRaw($@"
                    INSERT OR IGNORE INTO Users (FullName, Pin, IsAdmin, IsActive, CreatedAt)
                    VALUES ('Admin', '{adminPinHash}', 1, 1, datetime('now'));
                ");
            }
        }
        catch
        {
            // If any error occurs, try to create the table anyway
            this.Database.ExecuteSqlRaw(@"
                CREATE TABLE IF NOT EXISTS Users (
                    Id INTEGER PRIMARY KEY AUTOINCREMENT,
                    FullName TEXT NOT NULL UNIQUE,
                    Pin TEXT NOT NULL,
                    IsAdmin INTEGER NOT NULL DEFAULT 0,
                    IsActive INTEGER NOT NULL DEFAULT 1,
                    CreatedAt TEXT NOT NULL,
                    LastUsedAt TEXT
                );
            ");
        }
    }

    public DbSet<Io> Ios { get; set; }
    public DbSet<TestHistory> TestHistories { get; set; }
    public DbSet<PendingSync> PendingSyncs { get; set; }
    public DbSet<SubsystemConfiguration> SubsystemConfigurations { get; set; }
    public DbSet<User> Users { get; set; }
    public DbSet<TagTypeDiagnostic> TagTypeDiagnostics { get; set; }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Io>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Name).HasMaxLength(100);
            entity.Property(e => e.Description).HasMaxLength(500);
            entity.Property(e => e.Result).HasMaxLength(50);
            // State is a real-time PLC value and should not be persisted
            entity.Ignore(e => e.State);
            entity.Ignore(e => e.Subsystem);
            entity.Property(e => e.Comments).HasMaxLength(1000);
            entity.Property(e => e.Version).IsRequired().HasDefaultValue(0L);
            entity.Property(e => e.TagType).HasMaxLength(100);
        });

        modelBuilder.Entity<TestHistory>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.HasOne(e => e.Io)
                  .WithMany()
                  .HasForeignKey(e => e.IoId);
            entity.Property(e => e.Result).HasMaxLength(50);
            entity.Property(e => e.State).HasMaxLength(50);
            entity.Property(e => e.Comments).HasMaxLength(1000);
            entity.Property(e => e.TestedBy).HasMaxLength(100);
            entity.Property(e => e.FailureMode).HasMaxLength(100);
        });

        modelBuilder.Entity<PendingSync>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.Property(e => e.InspectorName).HasMaxLength(100);
            entity.Property(e => e.TestResult).HasMaxLength(50);
            entity.Property(e => e.Comments).HasMaxLength(1000);
            entity.Property(e => e.State).HasMaxLength(50);
            entity.Property(e => e.LastError).HasMaxLength(500);
            entity.Property(e => e.Version).IsRequired().HasDefaultValue(0L);
            entity.HasIndex(e => e.IoId);
            entity.HasIndex(e => e.CreatedAt);
        });

        modelBuilder.Entity<SubsystemConfiguration>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.Property(e => e.ProjectName).HasMaxLength(100).IsRequired();
            entity.Property(e => e.SubsystemName).HasMaxLength(100).IsRequired();
            entity.Property(e => e.Ip).HasMaxLength(50).IsRequired();
            entity.Property(e => e.Path).HasMaxLength(50).IsRequired();
            entity.Property(e => e.RemoteUrl).HasMaxLength(200);
            entity.Property(e => e.ApiPassword).HasMaxLength(200);
            entity.Property(e => e.Description).HasMaxLength(500);
            entity.HasIndex(e => new { e.ProjectName, e.SubsystemId }).IsUnique();
            entity.HasIndex(e => e.IsActive);
        });

        modelBuilder.Entity<User>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.Property(e => e.FullName).HasMaxLength(100).IsRequired();
            entity.Property(e => e.Pin).IsRequired();
            entity.Property(e => e.IsAdmin).IsRequired().HasDefaultValue(false);
            entity.Property(e => e.IsActive).IsRequired().HasDefaultValue(true);
            entity.Property(e => e.CreatedAt).IsRequired();
            entity.Property(e => e.LastUsedAt);
            entity.HasIndex(e => e.FullName).IsUnique();
        });

        modelBuilder.Entity<TagTypeDiagnostic>(entity =>
        {
            entity.HasKey(e => new { e.TagType, e.FailureMode });
            entity.Property(e => e.TagType).HasMaxLength(100).IsRequired();
            entity.Property(e => e.FailureMode).HasMaxLength(100).IsRequired();
            entity.Property(e => e.DiagnosticSteps).IsRequired();
            entity.Property(e => e.CreatedAt).IsRequired();
        });

        base.OnModelCreating(modelBuilder);
    }
} 