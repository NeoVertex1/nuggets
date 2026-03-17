import pino from "pino";
import { PiPool } from "./pi-pool.js";
import { EventQueue, type ProactiveEvent } from "./event-queue.js";
import { HeartbeatManager } from "./heartbeat.js";

const log = pino({ name: "router" });
const WA_MAX_LENGTH = 4000;

export type SendFn = (jid: string, text: string) => Promise<unknown>;

/** Per-JID message queue to serialize concurrent messages */
const queues = new Map<string, Promise<void>>();

function enqueue(jid: string, fn: () => Promise<void>): void {
  const prev = queues.get(jid) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run even if previous failed
  queues.set(jid, next);
  next.then(() => {
    // Clean up if this was the last in the queue
    if (queues.get(jid) === next) queues.delete(jid);
  });
}

export function createRouter(
  getSend: () => SendFn,
  pool: PiPool,
  eventQueue: EventQueue,
  heartbeat: HeartbeatManager,
) {
  // Subscribe to proactive events from cron/heartbeat/timers
  eventQueue.on("event", (event: ProactiveEvent) => {
    enqueue(event.jid, () =>
      handleProactiveEvent(getSend(), pool, event),
    );
  });

  // Return the WhatsApp message handler
  return async (jid: string, text: string): Promise<void> => {
    // Touch heartbeat on every incoming message
    heartbeat.register(jid);
    enqueue(jid, () => handleMessage(getSend(), pool, jid, text));
  };
}

async function handleMessage(
  send: SendFn,
  pool: PiPool,
  jid: string,
  text: string,
): Promise<void> {
  try {
    const rpc = pool.getOrCreate(jid);
    pool.markBusy(jid);

    const result = await rpc.promptAndWait(text);
    let response = result.text.trim();

    if (!response) {
      // Fallback: look for text in agent_end or message events
      for (const event of result.events) {
        if (typeof event.message === "string" && event.message.trim()) {
          response = event.message.trim();
          break;
        }
      }
    }

    if (!response) {
      response = "(No response from Pi)";
    }

    // Split long messages for WhatsApp readability
    const chunks = splitMessage(response, WA_MAX_LENGTH);
    for (const chunk of chunks) {
      await send(jid, chunk);
    }

    log.info({ jid, responseLen: response.length }, "Reply sent");
  } catch (err) {
    log.error({ jid, err }, "Error handling message");
    // Kill the Pi process so next message gets a clean one
    pool.kill(jid);
    return;
  } finally {
    pool.markIdle(jid);
  }
}

async function handleProactiveEvent(
  send: SendFn,
  pool: PiPool,
  event: ProactiveEvent,
): Promise<void> {
  try {
    const rpc = pool.getOrCreate(event.jid);
    pool.markBusy(event.jid);

    const result = await rpc.promptAndWait(event.prompt);
    let response = result.text.trim();

    // For heartbeats, Pi responds "NOTHING" if there's nothing to say
    if (event.type === "heartbeat") {
      if (!response || response.toUpperCase().includes("NOTHING")) {
        log.info({ jid: event.jid }, "Heartbeat — nothing to say");
        return;
      }
    }

    if (!response) {
      log.info({ jid: event.jid, type: event.type }, "Proactive event — no response");
      return;
    }

    const chunks = splitMessage(response, WA_MAX_LENGTH);
    for (const chunk of chunks) {
      await send(event.jid, chunk);
    }

    log.info({ jid: event.jid, type: event.type, responseLen: response.length }, "Proactive reply sent");
  } catch (err) {
    log.error({ jid: event.jid, type: event.type, err }, "Error handling proactive event");
  } finally {
    pool.markIdle(event.jid);
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.3) {
      // No good newline — split at space
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      // No good space either — hard split
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
