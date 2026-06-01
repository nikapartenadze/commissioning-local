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
  EMBEDDED_REMOTE_URL,
  McmConnection,
} from './types';
import { resolveConfigFilePath } from '@/lib/storage-paths';

// Keep config beside the active database unless CONFIG_PATH overrides it.
const CONFIG_FILE_PATH = resolveConfigFilePath();

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

      // Migration: if the new `mcms` array is missing but the legacy
      // single-MCM fields are populated, synthesise mcms[0] from them so the
      // central-tool flow has at least one entry to work with. If neither is
      // populated, mcms stays empty and the landing page invites the user to
      // add one.
      const legacyIp: string = parsed.ip ?? DEFAULT_CONFIG.ip;
      const legacyPath: string = parsed.path ?? DEFAULT_CONFIG.path;
      const legacySubsystemId: string = parsed.subsystemId ?? DEFAULT_CONFIG.subsystemId;

      let mcms: McmConnection[] = [];
      if (Array.isArray(parsed.mcms)) {
        mcms = parsed.mcms
          .filter((m: any) => m && typeof m === 'object')
          .map((m: any): McmConnection => ({
            subsystemId: String(m.subsystemId ?? ''),
            name: String(m.name ?? `MCM ${m.subsystemId ?? '?'}`),
            ip: String(m.ip ?? ''),
            path: String(m.path ?? '1,0'),
            enabled: m.enabled !== false,
          }))
          .filter((m: McmConnection) => m.subsystemId.length > 0);
      } else if (legacyIp && legacySubsystemId) {
        mcms = [{
          subsystemId: legacySubsystemId,
          name: `MCM ${legacySubsystemId}`,
          ip: legacyIp,
          path: legacyPath,
          enabled: true,
        }];
      }

      // Merge with defaults to ensure all fields exist
      this.config = {
        ip: legacyIp,
        path: legacyPath,
        // remoteUrl is embedded — ignore stored value, always use the constant
        remoteUrl: EMBEDDED_REMOTE_URL,
        apiPassword: parsed.apiPassword ?? parsed.ApiPassword ?? DEFAULT_CONFIG.apiPassword,
        subsystemId: legacySubsystemId,
        updateManifestUrl: parsed.updateManifestUrl ?? DEFAULT_CONFIG.updateManifestUrl,
        orderMode: String(parsed.orderMode ?? DEFAULT_CONFIG.orderMode),
        syncBatchSize: Number(parsed.syncBatchSize ?? DEFAULT_CONFIG.syncBatchSize),
        syncBatchDelayMs: Number(parsed.syncBatchDelayMs ?? DEFAULT_CONFIG.syncBatchDelayMs),
        showStateColumn: parsed.showStateColumn ?? true,
        showResultColumn: parsed.showResultColumn ?? true,
        showTimestampColumn: parsed.showTimestampColumn ?? true,
        showHistoryColumn: parsed.showHistoryColumn ?? true,
        networkPollingDevices: Array.isArray(parsed.networkPollingDevices)
          ? parsed.networkPollingDevices.filter((d: unknown): d is string => typeof d === 'string' && d.length > 0)
          : [],
        // Optional backplane path to the DLR ring supervisor (e.g. "1,2").
        // Undefined → poller auto-derives from a SLOTn_EN4TR device name.
        dlrSupervisorPath: typeof parsed.dlrSupervisorPath === 'string' && parsed.dlrSupervisorPath.trim().length > 0
          ? parsed.dlrSupervisorPath.trim()
          : undefined,
        // Opt-in install-status gate. Undefined / missing / falsy → off (existing
        // behavior unchanged for every machine that hasn't explicitly set it).
        // Only the literal `true` enables it, so a typo like "true" string still
        // defaults to off — safer than a string truthy check.
        requireInstalledForTesting: parsed.requireInstalledForTesting === true,
        // UDT network poll cadence. Clamped to [1000, 600000] so a fat-finger
        // can't set it faster than the IO reader can survive or so slow that
        // the heartbeat thinks every device went stale. Undefined falls
        // through to the poller's own default (60_000 ms).
        networkPollingIntervalMs: typeof parsed.networkPollingIntervalMs === 'number' && Number.isFinite(parsed.networkPollingIntervalMs)
          ? Math.max(1000, Math.min(600_000, Math.floor(parsed.networkPollingIntervalMs)))
          : undefined,
        lastConnectedSubsystemId: typeof parsed.lastConnectedSubsystemId === 'string' && parsed.lastConnectedSubsystemId.length > 0
          ? parsed.lastConnectedSubsystemId
          : undefined,
        lastConnectedAt: typeof parsed.lastConnectedAt === 'string' && parsed.lastConnectedAt.length > 0
          ? parsed.lastConnectedAt
          : undefined,
        // Locally-cached MCM picker entries — populated from the cloud
        // subsystems list, enriched with PLC IP/Path on each successful
        // connect so the next visit doesn't make the operator retype the IP.
        plcProfiles: Array.isArray(parsed.plcProfiles)
          ? parsed.plcProfiles.filter((p: any): p is { name: string; subsystemId: string; plcIp: string; plcPath: string } =>
              p
              && typeof p.name === 'string'
              && typeof p.subsystemId === 'string'
              && typeof p.plcIp === 'string'
              && typeof p.plcPath === 'string')
          : [],
        mcms,
      };

      console.log('[ConfigService] Configuration loaded:', {
        ip: this.config.ip,
        subsystemId: this.config.subsystemId,
      });

      return this.config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (!this.config) {
          console.log('[ConfigService] Config file not found, using defaults');
        }
        this.config = { ...DEFAULT_CONFIG };
        // Try to create the file but don't fail if we can't
        try {
          await this.saveConfig(DEFAULT_CONFIG);
        } catch {
          // Ignore write errors — we'll use in-memory defaults
        }
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
      // remoteUrl is embedded — never accept caller-supplied values
      remoteUrl: EMBEDDED_REMOTE_URL,
    };

    // Prepare JSON for file (use ApiPassword for C# backend compatibility)
    const fileData = {
      ip: newConfig.ip,
      path: newConfig.path,
      remoteUrl: newConfig.remoteUrl,
      ApiPassword: newConfig.apiPassword, // C# expects "ApiPassword"
      subsystemId: newConfig.subsystemId,
      updateManifestUrl: newConfig.updateManifestUrl,
      orderMode: newConfig.orderMode,
      syncBatchSize: newConfig.syncBatchSize,
      syncBatchDelayMs: newConfig.syncBatchDelayMs,
      showStateColumn: newConfig.showStateColumn,
      showResultColumn: newConfig.showResultColumn,
      showTimestampColumn: newConfig.showTimestampColumn,
      showHistoryColumn: newConfig.showHistoryColumn,
      // Persist only when explicitly enabled — leaving the key absent on
      // machines that don't need the gate keeps config.json clean and
      // signals "default behavior" by its very absence.
      ...(newConfig.requireInstalledForTesting === true ? { requireInstalledForTesting: true } : {}),
      // Same pattern: only write the field when it's set to a non-default
      // value. An absent key is the universal "use default 60 s" signal.
      ...(typeof newConfig.networkPollingIntervalMs === 'number'
        ? { networkPollingIntervalMs: newConfig.networkPollingIntervalMs }
        : {}),
      // Boot-time auto-connect memory. Both fields persist only after a
      // confirmed successful PLC connect, so a fresh-installed tool with no
      // history skips auto-connect (and the operator picks an MCM as usual).
      ...(typeof newConfig.lastConnectedSubsystemId === 'string' && newConfig.lastConnectedSubsystemId.length > 0
        ? { lastConnectedSubsystemId: newConfig.lastConnectedSubsystemId }
        : {}),
      ...(typeof newConfig.lastConnectedAt === 'string' && newConfig.lastConnectedAt.length > 0
        ? { lastConnectedAt: newConfig.lastConnectedAt }
        : {}),
      // Only persist plcProfiles when there's at least one entry. Keeps a
      // brand-new config.json clean (the key only appears after the operator
      // has successfully connected to at least one MCM).
      ...(Array.isArray(newConfig.plcProfiles) && newConfig.plcProfiles.length > 0
        ? { plcProfiles: newConfig.plcProfiles }
        : {}),
      // central-tool multi-MCM config. Omitted from file when empty so
      // existing single-MCM deployments stay textually unchanged.
      ...(newConfig.mcms && newConfig.mcms.length > 0 ? { mcms: newConfig.mcms } : {}),
    };

    // Mark as internal write to prevent watcher from triggering
    this.notifyInternalWrite();

    try {
      await fs.mkdir(path.dirname(CONFIG_FILE_PATH), { recursive: true });
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
      'updateManifestUrl',
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

  // ── Multi-MCM helpers (central-tool) ────────────────────────────────────

  /**
   * Return the configured MCM list. Empty array if none configured yet.
   * Always returns a fresh array; callers can safely mutate it.
   */
  public async getMcms(): Promise<McmConnection[]> {
    const cfg = await this.getConfig();
    return [...(cfg.mcms ?? [])];
  }

  /**
   * Look up one MCM by subsystemId. Returns null when missing.
   */
  public async getMcm(subsystemId: string): Promise<McmConnection | null> {
    const list = await this.getMcms();
    return list.find((m) => m.subsystemId === subsystemId) ?? null;
  }

  /**
   * Add a new MCM. Rejects duplicate subsystemIds. Persists immediately.
   */
  public async addMcm(mcm: McmConnection): Promise<McmConnection[]> {
    const list = await this.getMcms();
    if (list.some((m) => m.subsystemId === mcm.subsystemId)) {
      throw new Error(`MCM ${mcm.subsystemId} already exists`);
    }
    const next = [...list, { ...mcm, enabled: mcm.enabled !== false }];
    await this.saveConfig({});
    // saveConfig() doesn't accept mcms in ConfigUpdateRequest — write directly
    // to the in-memory config and re-save through the underlying mechanism.
    if (this.config) {
      this.config.mcms = next;
    }
    await this.persistMcms(next);
    return next;
  }

  /**
   * Update an existing MCM. Identified by its subsystemId.
   */
  public async updateMcm(subsystemId: string, patch: Partial<McmConnection>): Promise<McmConnection[]> {
    const list = await this.getMcms();
    const idx = list.findIndex((m) => m.subsystemId === subsystemId);
    if (idx === -1) {
      throw new Error(`MCM ${subsystemId} not found`);
    }
    const next = list.slice();
    next[idx] = { ...next[idx], ...patch, subsystemId: next[idx].subsystemId };
    if (this.config) {
      this.config.mcms = next;
    }
    await this.persistMcms(next);
    return next;
  }

  /**
   * Remove an MCM from the configured list. No-op if not present.
   */
  public async removeMcm(subsystemId: string): Promise<McmConnection[]> {
    const list = await this.getMcms();
    const next = list.filter((m) => m.subsystemId !== subsystemId);
    if (next.length === list.length) {
      return list; // nothing changed
    }
    if (this.config) {
      this.config.mcms = next;
    }
    await this.persistMcms(next);
    return next;
  }

  /**
   * Merge a cloud-provided subsystem list into config.mcms in one write.
   * Adds any subsystem not already present (id + name prefilled, blank IP,
   * default path, enabled), and refreshes the display name on existing ones.
   * NEVER touches an existing MCM's ip/path/enabled — PLC IP is site-local and
   * the operator owns it. Existing MCMs not in the cloud list are left intact.
   */
  public async upsertMcmsFromCloud(
    incoming: Array<{ subsystemId: string; name: string }>
  ): Promise<{ mcms: McmConnection[]; added: string[]; updated: string[] }> {
    const list = await this.getMcms();
    const known = new Set(list.map((m) => m.subsystemId));
    const added: string[] = [];
    const updated: string[] = [];

    // Refresh names on existing entries (keep ip/path/enabled).
    const next: McmConnection[] = list.map((m) => {
      const inc = incoming.find((i) => String(i.subsystemId) === m.subsystemId);
      if (inc && inc.name && inc.name !== m.name) {
        updated.push(m.subsystemId);
        return { ...m, name: inc.name };
      }
      return m;
    });

    // Append brand-new subsystems with a blank IP for the operator to fill.
    for (const inc of incoming) {
      const sid = String(inc.subsystemId ?? '').trim();
      if (!sid || known.has(sid)) continue;
      known.add(sid);
      next.push({ subsystemId: sid, name: inc.name || `MCM ${sid}`, ip: '', path: '1,0', enabled: true });
      added.push(sid);
    }

    if (this.config) {
      this.config.mcms = next;
    }
    await this.persistMcms(next);
    return { mcms: next, added, updated };
  }

  /**
   * Write a fresh mcms array to disk, preserving every other field. Used
   * internally by add/update/remove so the file watcher doesn't trip.
   */
  private async persistMcms(mcms: McmConnection[]): Promise<void> {
    const currentConfig = await this.getConfig();
    const fileData: Record<string, unknown> = {
      ip: currentConfig.ip,
      path: currentConfig.path,
      remoteUrl: currentConfig.remoteUrl,
      ApiPassword: currentConfig.apiPassword,
      subsystemId: currentConfig.subsystemId,
      updateManifestUrl: currentConfig.updateManifestUrl,
      orderMode: currentConfig.orderMode,
      syncBatchSize: currentConfig.syncBatchSize,
      syncBatchDelayMs: currentConfig.syncBatchDelayMs,
      showStateColumn: currentConfig.showStateColumn,
      showResultColumn: currentConfig.showResultColumn,
      showTimestampColumn: currentConfig.showTimestampColumn,
      showHistoryColumn: currentConfig.showHistoryColumn,
    };
    if (mcms.length > 0) {
      fileData.mcms = mcms;
    }
    if (currentConfig.networkPollingDevices && currentConfig.networkPollingDevices.length > 0) {
      fileData.networkPollingDevices = currentConfig.networkPollingDevices;
    }
    this.notifyInternalWrite();
    await fs.mkdir(path.dirname(CONFIG_FILE_PATH), { recursive: true });
    await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(fileData, null, 2), 'utf-8');
    if (this.config) {
      this.config.mcms = mcms;
    }
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
