import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Db, Device } from './db.ts';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const CODE_TTL_MS = 10 * 60_000;
const FAILURE_WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 5;

/** Normalizes user-typed codes: "1234 5678", "1234-5678" → "12345678". */
export const normalizeCode = (code: string) => code.replace(/\D/g, '');

export function createAuth(db: Db) {
  let failures: number[] = [];

  return {
    /** Creates a one-time 8-digit pairing code, valid for 10 minutes. */
    newPairingCode(): { code: string; display: string; expiresAt: number } {
      const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
      const expiresAt = Date.now() + CODE_TTL_MS;
      db.addPairingCode(sha256(code), expiresAt);
      return { code, display: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
    },

    /**
     * Exchanges a pairing code for a long-lived device token.
     * After 5 wrong codes within 10 minutes, every outstanding code is invalidated.
     */
    pair(code: string, deviceName: string): { token: string; device: Device } | null {
      const now = Date.now();
      const normalized = normalizeCode(code);
      if (normalized.length === 8 && db.consumePairingCode(sha256(normalized))) {
        const token = randomBytes(32).toString('base64url');
        const name = deviceName.trim().slice(0, 60) || 'מכשיר';
        const device = db.addDevice(name, sha256(token));
        db.audit('device.paired', { deviceId: device.id, name });
        return { token, device };
      }
      failures = failures.filter((t) => now - t < FAILURE_WINDOW_MS);
      failures.push(now);
      db.audit('device.pair_failed', { attempts: failures.length });
      if (failures.length >= MAX_FAILURES) {
        db.invalidatePairingCodes();
        db.audit('device.pairing_locked', {});
        failures = [];
      }
      return null;
    },

    /** Returns the device for a bearer token, or undefined. */
    verify(authorization: string | undefined): Device | undefined {
      if (!authorization?.startsWith('Bearer ')) return undefined;
      const token = authorization.slice('Bearer '.length).trim();
      if (token.length < 20) return undefined;
      const device = db.deviceByTokenHash(sha256(token));
      if (device && Date.now() - (device.last_seen ?? 0) >= 60_000) db.touchDevice(device.id);
      return device;
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
