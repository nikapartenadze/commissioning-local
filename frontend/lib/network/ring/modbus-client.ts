/**
 * Minimal read-only Modbus/TCP client (Function Code 4 — Read Input Registers).
 *
 * Hand-rolled over a raw TCP socket to avoid pulling a Modbus dependency (and
 * any transitive native serialport build) into the portable bundle. One
 * request per connection keeps framing trivial — no transaction multiplexing.
 *
 * Used only as the ring-status fallback when SNMP doesn't expose ring state.
 */

import net from 'net';

export interface ModbusReadOptions {
  port: number;
  unitId: number;
  timeoutMs: number;
}

/**
 * Read `quantity` 16-bit input registers starting at `startAddr` (the raw
 * register offset, e.g. 0x3600). Resolves an array of unsigned 16-bit words.
 * Rejects on timeout, socket error, or a Modbus exception response.
 */
export function readInputRegisters(
  ip: string,
  opts: ModbusReadOptions,
  startAddr: number,
  quantity: number,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const chunks: Buffer[] = [];

    const finish = (err: Error | null, regs?: number[]) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(regs!);
    };

    socket.setTimeout(opts.timeoutMs);
    socket.on('timeout', () => finish(new Error(`Modbus timeout ${ip}:${opts.port}`)));
    socket.on('error', (e) => finish(e instanceof Error ? e : new Error(String(e))));
    socket.on('close', () => finish(new Error(`Modbus connection closed by ${ip}:${opts.port}`)));

    socket.on('data', (d) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      // MBAP header (7) + function code (1) + (byteCount | exceptionCode) (1)
      if (buf.length < 9) return;
      const func = buf.readUInt8(7);
      if ((func & 0x80) !== 0) {
        return finish(new Error(`Modbus exception 0x${buf.readUInt8(8).toString(16)} from ${ip}`));
      }
      const byteCount = buf.readUInt8(8);
      if (buf.length < 9 + byteCount) return; // wait for the rest of the payload
      const regs: number[] = [];
      for (let i = 0; i + 1 < byteCount; i += 2) regs.push(buf.readUInt16BE(9 + i));
      finish(null, regs);
    });

    socket.connect(opts.port, ip, () => {
      const pdu = Buffer.alloc(5);
      pdu.writeUInt8(0x04, 0); // FC4 — Read Input Registers
      pdu.writeUInt16BE(startAddr & 0xffff, 1);
      pdu.writeUInt16BE(quantity & 0xffff, 3);

      const mbap = Buffer.alloc(7);
      mbap.writeUInt16BE(1, 0); // transaction id (single request, fixed)
      mbap.writeUInt16BE(0, 2); // protocol id = Modbus
      mbap.writeUInt16BE(1 + pdu.length, 4); // length = unitId + PDU
      mbap.writeUInt8(opts.unitId & 0xff, 6);

      socket.write(Buffer.concat([mbap, pdu]));
    });
  });
}
