import { machineIdSync } from 'node-machine-id';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '@/lib/dataDir';

const MACHINE_ID_FILE = path.join(DATA_DIR, 'machine-id');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const CLI_SECRET_FILE = path.join(AUTH_DIR, 'cli-secret');
const CLI_AUTH_SALT = '9r-cli-auth';
let cachedRawId = null;
let cachedCliSecret = null;

// Persist raw machine ID to file → guarantees CLI/server/middleware see same value
// even when machineIdSync fails or returns inconsistent values across runtimes.
function loadRawMachineId() {
  if (cachedRawId) return cachedRawId;
  try {
    cachedRawId = fs.readFileSync(MACHINE_ID_FILE, 'utf8').trim();
    if (cachedRawId) return cachedRawId;
  } catch {}
  // machineIdSync() shells out to `hostname` / reads /etc/machine-id — both
  // unavailable on Vercel serverless, where /tmp is fresh per cold start and the
  // file-based persistence below only covers the instance lifetime. On Vercel a
  // random UUID per instance is fine for ephemeral deploys, and it avoids a
  // noisy "hostname: command not found" from the shell child process. machineIdSync()
  // is still used on normal hosts where the machine identity is stable.
  if (process.env.VERCEL) {
    cachedRawId = crypto.randomUUID();
  } else {
    try {
      cachedRawId = machineIdSync();
    } catch {
      cachedRawId = crypto.randomUUID();
    }
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MACHINE_ID_FILE, cachedRawId, { mode: 0o600 });
  } catch {}
  return cachedRawId;
}

// Random secret persisted on first run → unpredictable CLI token even when machineId leaks.
function loadCliSecret() {
  if (cachedCliSecret) return cachedCliSecret;
  try {
    cachedCliSecret = fs.readFileSync(CLI_SECRET_FILE, 'utf8').trim();
    if (cachedCliSecret) return cachedCliSecret;
  } catch {}
  cachedCliSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(CLI_SECRET_FILE, cachedCliSecret, { mode: 0o600 });
  } catch {}
  return cachedCliSecret;
}

export async function getConsistentMachineId(salt = null) {
  const saltValue = salt || process.env.MACHINE_ID_SALT || 'endpoint-proxy-salt';
  const raw = loadRawMachineId();
  const extra = saltValue === CLI_AUTH_SALT ? loadCliSecret() : '';
  return crypto.createHash('sha256').update(raw + saltValue + extra).digest('hex').substring(0, 16);
}

export async function getRawMachineId() {
  return loadRawMachineId();
}

/**
 * Check if we're running in browser or server environment
 * @returns {boolean} True if in browser, false if in server
 */
export function isBrowser() {
  return typeof window !== 'undefined';
}
