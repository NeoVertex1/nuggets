import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import pino from "pino";
import {
  SESSIONS_DIR,
  PROJECT_ROOT,
  PI_PROVIDER,
  PI_MODEL,
  PI_IDLE_TIMEOUT_MS,
  MAX_PI_PROCESSES,
  jidHash,
} from "./config.js";
import { PiRpc } from "./pi-rpc.js";

const log = pino({ name: "pi-pool" });

interface PiSession {
  jid: string;
  rpc: PiRpc;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastActive: number;
}

export class PiPool {
  private sessions = new Map<string, PiSession>();

  getOrCreate(jid: string): PiRpc {
    let session = this.sessions.get(jid);

    if (session && session.rpc.alive) {
      return session.rpc;
    }

    // Evict dead session if exists
    if (session) {
      this.sessions.delete(jid);
    }

    // Enforce max processes — evict oldest idle
    if (this.sessions.size >= MAX_PI_PROCESSES) {
      this.evictOldestIdle();
    }

    const sessionDir = resolve(SESSIONS_DIR, jidHash(jid));
    mkdirSync(sessionDir, { recursive: true });

    const rpc = new PiRpc(
      sessionDir,
      PROJECT_ROOT,
      PI_PROVIDER,
      PI_MODEL || undefined,
    );

    rpc.on("exit", (code: number, signal: string) => {
      log.info({ jid, code, signal }, "Pi process exited");
      const s = this.sessions.get(jid);
      if (s?.idleTimer) clearTimeout(s.idleTimer);
      this.sessions.delete(jid);
    });

    rpc.start();
    log.info({ jid, sessionDir }, "Pi process started");

    session = { jid, rpc, idleTimer: null, lastActive: Date.now() };
    this.sessions.set(jid, session);

    return rpc;
  }

  markBusy(jid: string): void {
    const session = this.sessions.get(jid);
    if (!session) return;
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    session.lastActive = Date.now();
  }

  markIdle(jid: string): void {
    const session = this.sessions.get(jid);
    if (!session) return;
    session.lastActive = Date.now();
    session.idleTimer = setTimeout(() => {
      log.info({ jid }, "Idle timeout — stopping Pi");
      session.rpc.stop();
      this.sessions.delete(jid);
    }, PI_IDLE_TIMEOUT_MS);
  }

  /** Force-kill a Pi process so the next getOrCreate() spawns fresh */
  kill(jid: string): void {
    const session = this.sessions.get(jid);
    if (!session) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.rpc.stop();
    this.sessions.delete(jid);
    log.info({ jid }, "Pi process killed (error recovery)");
  }

  stopAll(): void {
    for (const [jid, session] of this.sessions) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.rpc.stop();
      log.info({ jid }, "Pi process stopped (shutdown)");
    }
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }

  private evictOldestIdle(): void {
    let oldest: PiSession | null = null;
    for (const session of this.sessions.values()) {
      // Prefer evicting sessions that have idle timers (not busy)
      if (session.idleTimer && (!oldest || session.lastActive < oldest.lastActive)) {
        oldest = session;
      }
    }

    // If no idle sessions, evict the least recently active
    if (!oldest) {
      for (const session of this.sessions.values()) {
        if (!oldest || session.lastActive < oldest.lastActive) {
          oldest = session;
        }
      }
    }

    if (oldest) {
      log.info({ jid: oldest.jid }, "Evicting session (max processes)");
      if (oldest.idleTimer) clearTimeout(oldest.idleTimer);
      oldest.rpc.stop();
      this.sessions.delete(oldest.jid);
    }
  }
}
