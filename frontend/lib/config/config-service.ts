/**
 * Configuration Service
 *
 * TypeScript port of the C# ConfigurationService.
 * Manages application configuration with file persistence and change notifications.
 *
 * Features:
 * - Load/save config from config.json
 * - Watch for file changes (fs.watch)
 * - Event emitter for config changes
 * - Singleton pattern
 */

import { promises as fs } from 'fs';
import { watch, FSWatcher } from 'fs';
import path from 'path';
import {
  AppConfig,
  AppConfigExtended,
  ConfigUpdateRequest,
  ConfigChangeEvent,
  ConfigChangeListener,
  DEFAULT_CONFIG,
} from './types';

// Path to config file (relative to frontend directory)
const CONFIG_FILE_PATH = path.join(process.cwd(), 'config.json');

/**
 * ConfigurationService - Singleton service for managing application configuration.
 *
 * Ported from C# backend/Services/ConfigurationService.cs
 */
class ConfigurationService {
  private static instance: ConfigurationService | null = null;

  private config: AppConfigExtended | null = null;
  private watcher: FSWatcher | null = null;
  private listeners: Set<ConfigChangeListener> = new Set();
  private isInternalWrite = false;
  private internalWriteTimeout: NodeJS.Timeout | null = null;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get the singleton instance of ConfigurationService.
   */
  public static getInstance(): ConfigurationService {
    if (!ConfigurationService.instance) {
      ConfigurationService.instance = new ConfigurationService();
    }
    return ConfigurationService.instance;
  }

  /**
   * Initialize the configuration service.
   * Loads config from file and starts watching for changes.
   */
  public async initialize(): Promise<void> {
    await this.loadConfig();
    this.startWatching();
  }

  /**
   * Get the current configuration.
   * Loads from file if not already loaded.
   */
  public async getConfig(): Promise<AppConfigExtended> {
    if (!this.config) {
      await this.loadConfig();
    }
    return this.config!;
  }

  /**
   * Get configuration synchronously (returns cached config or defaults).
   * Use getConfig() for guaranteed fresh data.
   */
  public getConfigSync(): AppConfigExtended {
    return this.config || { ...DEFAULT_CONFIG };
  }

  /**
   * Load configuration from config.json file.
   * Creates default config if file doesn't exist.
   */
  public async loadConfig(): Promise<AppConfigExtended> {
    try {
      const fileContent = await fs.readFile(CONFIG_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(fileContent);

      // Merge with defaults to ensure all fields exist
      this.config = {
        ip: parsed.ip ?? DEFAULT_CONFIG.ip,
        path: parsed.path ?? DEFAULT_CONFIG.path,
        remoteUrl: parsed.remoteUrl ?? DEFAULT_CONFIG.remoteUrl,
        apiPassword: parsed.apiPassword ?? parsed.ApiPassword ?? DEFAULT_CONFIG.apiPassword,
        subsystemId: parsed.subsystemId ?? DEFAULT_CONFIG.subsystemId,
        orderMode: String(parsed.orderMode ?? DEFAULT_CONFIG.orderMode),
        syncBatchSize: Number(parsed.syncBatchSize ?? DEFAULT_CONFIG.syncBatchSize),
        syncBatchDelayMs: Number(parsed.syncBatchDelayMs ?? DEFAULT_CONFIG.syncBatchDelayMs),
        showStateColumn: parsed.showStateColumn ?? true,
        showResultColumn: parsed.showResultColumn ?? true,
        showTimestampColumn: parsed.showTimestampColumn ?? true,
        showHistoryColumn: parsed.showHistoryColumn ?? true,
      };

      console.log('[ConfigService] Configuration loaded:', {
        ip: this.config.ip,
        subsystemId: this.config.subsystemId,
      });

      return this.config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('[ConfigService] Config file not found, creating default config');
        await this.saveConfig(DEFAULT_CONFIG);
        this.config = { ...DEFAULT_CONFIG };
        return this.config;
      }
      console.error('[ConfigService] Error loading config:', error);
      this.config = { ...DEFAULT_CONFIG };
      return this.config;
    }
  }

  /**
   * Save configuration to config.json file.
   */
  public async saveConfig(updates: ConfigUpdateRequest): Promise<AppConfigExtended> {
    const currentConfig = await this.getConfig();
    const previousConfig = { ...currentConfig };

    // Merge updates with current config
    const newConfig: AppConfigExtended = {
      ...currentConfig,
      ...updates,
      // Ensure apiPassword is saved with correct casing for compatibility
      apiPassword: updates.apiPassword ?? currentConfig.apiPassword,
    };

    // Prepare JSON for file (use ApiPassword for C# backend compatibility)
    const fileData = {
      ip: newConfig.ip,
      path: newConfig.path,
      remoteUrl: newConfig.remoteUrl,
      ApiPassword: newConfig.apiPassword, // C# expects "ApiPassword"
      subsystemId: newConfig.subsystemId,
      orderMode: newConfig.orderMode,
      syncBatchSize: newConfig.syncBatchSize,
      syncBatchDelayMs: newConfig.syncBatchDelayMs,
      showStateColumn: newConfig.showStateColumn,
      showResultColumn: newConfig.showResultColumn,
      showTimestampColumn: newConfig.showTimestampColumn,
      showHistoryColumn: newConfig.showHistoryColumn,
    };

    // Mark as internal write to prevent watcher from triggering
    this.notifyInternalWrite();

    try {
      await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(fileData, null, 2), 'utf-8');
      this.config = newConfig;

      // Calculate changed fields
      const changedFields = this.getChangedFields(previousConfig, newConfig);

      // Notify listeners if there are changes
      if (changedFields.length > 0) {
        this.notifyListeners({
          previousConfig,
          currentConfig: newConfig,
          changedFields,
        });
      }

      console.log('[ConfigService] Configuration saved:', {
        ip: newConfig.ip,
        subsystemId: newConfig.subsystemId,
        changedFields,
      });

      return newConfig;
    } catch (error) {
      console.error('[ConfigService] Error saving config:', error);
      throw error;
    }
  }

  /**
   * Update cloud-related settings only (lightweight update).
   * Does not trigger full reinitialization.
   */
  public async updateCloudSettings(
    remoteUrl: string,
    apiPassword: string,
    subsystemId: string
  ): Promise<void> {
    await this.saveConfig({
      remoteUrl: remoteUrl.replace(/\/$/, ''), // Trim trailing slash
      apiPassword,
      subsystemId,
    });
  }

  /**
   * Update column visibility settings.
   */
  public async updateColumnVisibility(settings: {
    showStateColumn?: boolean;
    showResultColumn?: boolean;
    showTimestampColumn?: boolean;
    showHistoryColumn?: boolean;
  }): Promise<void> {
    await this.saveConfig(settings);
  }

  /**
   * Subscribe to configuration changes.
   * Returns an unsubscribe function.
   */
  public onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Mark current write as internal to prevent watcher from triggering.
   */
  public notifyInternalWrite(): void {
    this.isInternalWrite = true;
    // Clear any existing timeout
    if (this.internalWriteTimeout) {
      clearTimeout(this.internalWriteTimeout);
    }
    // Reset flag after a short delay to allow file system to settle
    this.internalWriteTimeout = setTimeout(() => {
      this.isInternalWrite = false;
    }, 1000);
  }

  /**
   * Start watching config file for external changes.
   */
  private startWatching(): void {
    if (this.watcher) {
      return; // Already watching
    }

    try {
      this.watcher = watch(CONFIG_FILE_PATH, async (eventType) => {
        if (eventType === 'change' && !this.isInternalWrite) {
          console.log('[ConfigService] Config file changed externally, reloading...');
          const previousConfig = this.config ? { ...this.config } : null;
          await this.loadConfig();

          if (previousConfig && this.config) {
            const changedFields = this.getChangedFields(previousConfig, this.config);
            if (changedFields.length > 0) {
              this.notifyListeners({
                previousConfig,
                currentConfig: this.config,
                changedFields,
              });
            }
          }
        }
      });

      console.log('[ConfigService] Watching config file for changes');
    } catch (error) {
      console.error('[ConfigService] Error starting file watcher:', error);
    }
  }

  /**
   * Stop watching config file.
   */
  public stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.log('[ConfigService] Stopped watching config file');
    }
    if (this.internalWriteTimeout) {
      clearTimeout(this.internalWriteTimeout);
      this.internalWriteTimeout = null;
    }
  }

  /**
   * Notify all listeners of configuration changes.
   */
  private notifyListeners(event: ConfigChangeEvent): void {
    Array.from(this.listeners).forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error('[ConfigService] Error in change listener:', error);
      }
    });
  }

  /**
   * Get list of fields that changed between two configs.
   */
  private getChangedFields(
    previous: AppConfigExtended,
    current: AppConfigExtended
  ): (keyof AppConfig)[] {
    const fields: (keyof AppConfig)[] = [
      'ip',
      'path',
      'remoteUrl',
      'apiPassword',
      'subsystemId',
      'orderMode',
      'syncBatchSize',
      'syncBatchDelayMs',
    ];

    return fields.filter((field) => previous[field] !== current[field]);
  }

  /**
   * Check if PLC configuration is complete (IP, Path, SubsystemId set).
   */
  public isConfigured(): boolean {
    if (!this.config) {
      return false;
    }
    return !!(this.config.ip && this.config.path && this.config.subsystemId);
  }

  /**
   * Get config file path.
   */
  public getConfigFilePath(): string {
    return CONFIG_FILE_PATH;
  }
}

// Export singleton instance getter
export const configService = ConfigurationService.getInstance();

// Export class for testing purposes
export { ConfigurationService };
