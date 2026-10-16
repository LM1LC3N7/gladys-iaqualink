// -----------------------------------------------------------------------------
// Our own request budget towards the iAquaLink cloud, which publishes no
// limit: a sliding minute of LIMITS.requestsPerMinute requests (reads and
// commands together) and a gap between two requests. Pure: the clock is
// injected.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';

const MINUTE = 60_000;

export class RequestBudget {
  constructor({
    now = Date.now,
    perMinute = LIMITS.requestsPerMinute,
    gap = TIMINGS.requestSpacing,
  } = {}) {
    this.now = now;
    this.perMinute = perMinute;
    this.gap = gap;
    /** Send times of the last minute, oldest first. */
    this.sent = [];
  }

  prune() {
    const now = this.now();
    while (this.sent.length > 0 && now - this.sent[0] >= MINUTE) {
      this.sent.shift();
    }
  }

  /** Requests still allowed in the current minute. */
  remaining() {
    this.prune();
    return Math.max(0, this.perMinute - this.sent.length);
  }

  /** Milliseconds until a slot frees up (0 when one is free). */
  untilFree() {
    if (this.remaining() > 0) {
      return 0;
    }
    return this.sent[0] + MINUTE - this.now();
  }

  /** Milliseconds to wait before the next request, to respect the gap. */
  wait() {
    const last = this.sent.at(-1);
    return last === undefined ? 0 : Math.max(0, last + this.gap - this.now());
  }

  /** Records a request; false when the minute is already spent. */
  spend() {
    if (this.remaining() === 0) {
      return false;
    }
    this.sent.push(this.now());
    return true;
  }
}
