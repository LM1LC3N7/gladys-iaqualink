// -----------------------------------------------------------------------------
// What goes to Gladys, within its limit of 300 states per minute.
//
// - push(): the current value of a feature (temperature, pump, status text…).
//   The last one wins; unchanged values are skipped by publishChangedStates
//   and sent again every 30 minutes.
// - pushEvent(): a value that is a moment of its own, all sent even when
//   equal (unused by iAquaLink so far, kept from LM1LC3N7/gladys-yolink).
// Everything left over (budget spent, Gladys unreachable) waits for the next
// flush, every second.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';

const MINUTE = 60_000;

export class StatePublisher {
  constructor({
    gladys,
    logger,
    now = Date.now,
    timers = globalThis,
    statesPerMinute = LIMITS.statesPerMinute,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.statesPerMinute = statesPerMinute;
    /** featureId -> { state } */
    this.pending = new Map();
    /** Moments, in order. */
    this.events = [];
    /** Send times of the last minute. */
    this.window = [];
    this.timer = undefined;
    this.flushing = undefined;
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  push(featureId, value) {
    this.pending.set(featureId, value);
  }

  pushEvent(featureId, value) {
    // The moment supersedes a pending current value of the same feature.
    this.pending.delete(featureId);
    this.events.push({ device_feature_external_id: featureId, ...value });
    if (this.events.length > LIMITS.queuedEvents) {
      this.events.shift();
    }
  }

  /** Forgets what is pending for a deleted device: `ext:…:yolink:id` and its features. */
  forget(deviceId) {
    const owned = (id) => id === deviceId || id.startsWith(`${deviceId}:`);
    this.events = this.events.filter((e) => !owned(e.device_feature_external_id));
    for (const id of [...this.pending.keys()]) {
      if (owned(id)) {
        this.pending.delete(id);
      }
    }
  }

  get idle() {
    return this.pending.size === 0 && this.events.length === 0;
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async doFlush() {
    const now = this.now();
    this.window = this.window.filter((t) => now - t < MINUTE);
    let room = this.statesPerMinute - this.window.length;
    const spend = (count) => {
      for (let i = 0; i < count; i += 1) {
        this.window.push(now);
      }
      room -= count;
    };
    while (room > 0 && this.events.length > 0) {
      // publishStates, not publishChangedStates: equal values are distinct moments.
      const batch = this.events.splice(0, Math.min(room, LIMITS.statesPerRequest));
      try {
        await this.gladys.publishStates(batch);
      } catch (err) {
        this.events.unshift(...batch);
        throw err;
      }
      // publishChangedStates did not see these values: the next current value
      // of the feature must not be skipped as "unchanged".
      for (const id of new Set(batch.map((e) => e.device_feature_external_id))) {
        this.gladys.forgetPublishedStates?.(id);
      }
      spend(batch.length);
    }
    if (room <= 0 || this.pending.size === 0) {
      return;
    }
    const batch = [];
    for (const [featureId, value] of this.pending) {
      if (batch.length >= room) {
        break;
      }
      this.pending.delete(featureId);
      batch.push({ device_feature_external_id: featureId, ...value });
    }
    try {
      const result = await this.gladys.publishChangedStates(batch, {
        heartbeat: TIMINGS.stateHeartbeat,
      });
      spend(result?.count ?? batch.length);
    } catch (err) {
      // Kept for the next round, unless a newer value arrived meanwhile.
      for (const { device_feature_external_id: id, ...value } of batch) {
        if (!this.pending.has(id)) {
          this.pending.set(id, value);
        }
      }
      throw err;
    }
  }
}
