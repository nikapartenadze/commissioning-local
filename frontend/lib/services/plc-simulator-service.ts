/**
 * PLC Simulator Service
 *
 * Simulates PLC tag state changes for testing without physical hardware.
 * Port of the C# PlcSimulatorService to TypeScript.
 *
 * Features:
 * - Randomly toggles tag states at configurable intervals
 * - Pulses untested IOs (TRUE -> brief delay -> FALSE)
 * - Emits events for state changes (for WebSocket broadcast)
 * - Singleton pattern for global access
 */

import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export interface SimulatedIO {
  id: number;
  name: string;
  description?: string;
  isOutput: boolean;
  state: string;
  result?: string;
  tagType?: string;
}

export interface SimulatorStatus {
  enabled: boolean;
  intervalMs: number;
  ioCount: number;
  untestedCount: number;
}

export interface StateChangeEvent {
  id: number;
  name: string;
  oldState: string;
  newState: string;
  timestamp: Date;
}

export interface SimulatorEvents {
  stateChanged: (event: StateChangeEvent) => void;
  enabled: (intervalMs: number) => void;
  disabled: () => void;
  error: (error: Error) => void;
}

// ============================================================================
// Simulation Modes
// ============================================================================

export type SimulationMode = 'random' | 'sequential' | 'allInputsTrue' | 'rapidFire';

// ============================================================================
// PLC Simulator Service
// ============================================================================

export class PlcSimulatorService extends EventEmitter {
  private _isEnabled: boolean = false;
  private _intervalMs: number = 2000;
  private _intervalHandle: NodeJS.Timeout | null = null;
  private _ios: Map<number, SimulatedIO> = new Map();
  private _simulationMode: SimulationMode = 'random';

  // Pulse duration in ms (simulates button press)
  private readonly PULSE_DURATION_MS = 150;

  constructor() {
    super();
  }

  // ============================================================================
  // Public Properties
  // ============================================================================

  get isEnabled(): boolean {
    return this._isEnabled;
  }

  get intervalMs(): number {
    return this._intervalMs;
  }

  get simulationMode(): SimulationMode {
    return this._simulationMode;
  }

  set simulationMode(mode: SimulationMode) {
    this._simulationMode = mode;
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  /**
   * Enable the PLC simulator
   * @param intervalMs Update interval in milliseconds (500-10000)
   */
  enable(intervalMs: number = 2000): void {
    // Validate interval
    if (intervalMs < 500 || intervalMs > 10000) {
      throw new Error('Interval must be between 500ms and 10000ms');
    }

    this._intervalMs = intervalMs;
    this._isEnabled = true;

    // Clear any existing interval
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
    }

    // Start simulation loop
    this._intervalHandle = setInterval(() => {
      this.simulateTagChanges().catch((error) => {
        console.error('[PlcSimulator] Error in simulation loop:', error);
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      });
    }, this._intervalMs);

    console.log(`[PlcSimulator] ENABLED - Updates every ${intervalMs}ms`);
    this.emit('enabled', intervalMs);
  }

  /**
   * Disable the PLC simulator
   */
  disable(): void {
    this._isEnabled = false;

    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }

    console.log('[PlcSimulator] DISABLED');
    this.emit('disabled');
  }

  /**
   * Load IOs for simulation
   */
  loadIOs(ios: SimulatedIO[]): void {
    this._ios.clear();
    for (const io of ios) {
      this._ios.set(io.id, { ...io });
    }
    console.log(`[PlcSimulator] Loaded ${ios.length} IOs for simulation`);
  }

  /**
   * Get all loaded IOs
   */
  getIOs(): SimulatedIO[] {
    return Array.from(this._ios.values());
  }

  /**
   * Get IO by ID
   */
  getIO(id: number): SimulatedIO | undefined {
    return this._ios.get(id);
  }

  /**
   * Get current simulator status
   */
  getStatus(): SimulatorStatus {
    const ios = Array.from(this._ios.values());
    const untestedCount = ios.filter((io) => !io.result || io.result === '').length;

    return {
      enabled: this._isEnabled,
      intervalMs: this._intervalMs,
      ioCount: this._ios.size,
      untestedCount,
    };
  }

  /**
   * Manually trigger a specific IO state change
   */
  async triggerIO(id: number, state: string): Promise<boolean> {
    const io = this._ios.get(id);
    if (!io) {
      return false;
    }

    if (state !== 'TRUE' && state !== 'FALSE') {
      throw new Error("State must be 'TRUE' or 'FALSE'");
    }

    const oldState = io.state;
    io.state = state;

    this.emit('stateChanged', {
      id: io.id,
      name: io.name,
      oldState,
      newState: state,
      timestamp: new Date(),
    } as StateChangeEvent);

    console.log(`[PlcSimulator] Manual trigger: ${io.name} -> ${state}`);
    return true;
  }

  /**
   * Trigger all inputs to TRUE
   */
  async triggerAllInputs(): Promise<number> {
    const inputs = Array.from(this._ios.values()).filter(
      (io) => !io.isOutput && (!io.result || io.result === '')
    );

    let triggered = 0;
    for (const io of inputs) {
      const oldState = io.state;
      io.state = 'TRUE';

      this.emit('stateChanged', {
        id: io.id,
        name: io.name,
        oldState,
        newState: 'TRUE',
        timestamp: new Date(),
      } as StateChangeEvent);

      triggered++;

      // Small delay to avoid overwhelming
      await this.delay(100);
    }

    console.log(`[PlcSimulator] Triggered all ${triggered} inputs to TRUE`);
    return triggered;
  }

  /**
   * Reset all IO states to FALSE
   */
  async resetAll(): Promise<number> {
    let reset = 0;
    const ios = Array.from(this._ios.values());

    for (const io of ios) {
      if (io.state !== 'FALSE') {
        const oldState = io.state;
        io.state = 'FALSE';

        this.emit('stateChanged', {
          id: io.id,
          name: io.name,
          oldState,
          newState: 'FALSE',
          timestamp: new Date(),
        } as StateChangeEvent);

        reset++;
      }
    }

    console.log(`[PlcSimulator] Reset all ${reset} IO states to FALSE`);
    return reset;
  }

  /**
   * Run a sequence of simulated changes
   */
  async runSequence(count: number = 10, delayMs: number = 1000): Promise<string[]> {
    const untested = Array.from(this._ios.values()).filter(
      (io) => !io.result || io.result === ''
    );

    if (untested.length === 0) {
      throw new Error('No untested I/O points available');
    }

    const changes: string[] = [];

    for (let i = 0; i < count && i < untested.length; i++) {
      const io = untested[i];
      const oldState = io.state;
      const newState = Math.random() < 0.7 ? 'TRUE' : 'FALSE';
      io.state = newState;

      this.emit('stateChanged', {
        id: io.id,
        name: io.name,
        oldState,
        newState,
        timestamp: new Date(),
      } as StateChangeEvent);

      changes.push(`${io.name} -> ${newState}`);

      if (i < count - 1) {
        await this.delay(delayMs);
      }
    }

    console.log(`[PlcSimulator] Ran sequence of ${changes.length} changes`);
    return changes;
  }

  /**
   * Update IO result (called when test is marked pass/fail)
   */
  updateIOResult(id: number, result: string): void {
    const io = this._ios.get(id);
    if (io) {
      io.result = result;
    }
  }

  /**
   * Dispose the simulator and clean up resources
   */
  dispose(): void {
    this.disable();
    this._ios.clear();
    this.removeAllListeners();
    console.log('[PlcSimulator] Disposed');
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Main simulation loop - randomly pulses untested IOs
   */
  private async simulateTagChanges(): Promise<void> {
    if (!this._isEnabled) {
      return;
    }

    const allIos = Array.from(this._ios.values());
    if (allIos.length === 0) {
      return; // No I/O points to simulate
    }

    // Pick one random untested IO to pulse
    const untestedIos = allIos.filter((io) => !io.result || io.result === '');
    if (untestedIos.length === 0) {
      console.log('[PlcSimulator] All IOs have been tested, nothing to simulate');
      return;
    }

    const io = untestedIos[Math.floor(Math.random() * untestedIos.length)];

    // Pulse: TRUE -> brief delay -> FALSE (simulates button press or sensor trigger)
    const oldState = io.state;
    io.state = 'TRUE';

    this.emit('stateChanged', {
      id: io.id,
      name: io.name,
      oldState,
      newState: 'TRUE',
      timestamp: new Date(),
    } as StateChangeEvent);

    console.log(`[PlcSimulator] Simulated PULSE: ${io.name} -> TRUE`);

    // Brief delay to simulate the pulse duration
    await this.delay(this.PULSE_DURATION_MS);

    // Return to FALSE
    io.state = 'FALSE';

    this.emit('stateChanged', {
      id: io.id,
      name: io.name,
      oldState: 'TRUE',
      newState: 'FALSE',
      timestamp: new Date(),
    } as StateChangeEvent);

    console.log(`[PlcSimulator] Simulated PULSE: ${io.name} -> FALSE`);
  }

  /**
   * Helper to create a delay promise
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let simulatorInstance: PlcSimulatorService | null = null;

/**
 * Get the singleton simulator instance
 */
export function getPlcSimulator(): PlcSimulatorService {
  if (!simulatorInstance) {
    simulatorInstance = new PlcSimulatorService();
  }
  return simulatorInstance;
}

/**
 * Check if a simulator instance exists
 */
export function hasPlcSimulator(): boolean {
  return simulatorInstance !== null;
}

/**
 * Dispose the singleton simulator instance
 */
export function disposePlcSimulator(): void {
  if (simulatorInstance) {
    simulatorInstance.dispose();
    simulatorInstance = null;
  }
}

// ============================================================================
// Type-safe event emitter interface
// ============================================================================

export declare interface PlcSimulatorService {
  on<K extends keyof SimulatorEvents>(event: K, listener: SimulatorEvents[K]): this;
  off<K extends keyof SimulatorEvents>(event: K, listener: SimulatorEvents[K]): this;
  emit<K extends keyof SimulatorEvents>(event: K, ...args: Parameters<SimulatorEvents[K]>): boolean;
}
