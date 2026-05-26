/**
 * Minimal ambient declaration for the untyped `net-snmp` package (v3.x).
 * Lives under lib/ so the server tsconfig (which excludes types/) picks it up.
 * Only the surface we actually use is declared.
 */
declare module 'net-snmp' {
  export const Version1: number;
  export const Version2c: number;

  export interface Varbind {
    oid: string;
    type: number;
    value: Buffer | number | bigint | string | null;
  }

  export interface Session {
    get(oids: string[], callback: (error: Error | null, varbinds: Varbind[]) => void): void;
    subtree(
      oid: string,
      maxRepetitions: number,
      feedCallback: (varbinds: Varbind[]) => void,
      doneCallback: (error: Error | null) => void,
    ): void;
    close(): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
  }

  export interface SessionOptions {
    port?: number;
    version?: number;
    timeout?: number;
    retries?: number;
    transport?: string;
  }

  export function createSession(target: string, community: string, options?: SessionOptions): Session;
  export function isVarbindError(vb: Varbind): boolean;
  export function varbindError(vb: Varbind): string;
}
