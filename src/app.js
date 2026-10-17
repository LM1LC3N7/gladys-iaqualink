// -----------------------------------------------------------------------------
// The integration: the iAquaLink account, a read of every pool system at the
// configured interval (30 s at the fastest), the Gladys devices and their
// states, the commands (each one serialized per system, after reading the
// state again), the backoff on errors and the transport badges. index.js only
// wires the SDK handlers to it.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { RequestBudget } from './budget.js';
import { normalizeConfig } from './config.js';
import { SYSTEM_TYPES, LIMITS, TIMINGS } from './constants.js';
import {
  buildDevice,
  observe,
  parseFeatureId,
  statesOf,
  systemIds,
  systemName,
} from './devices.js';
import { T, age, reasonOf, word } from './i18n.js';
import { AqualinkClient } from './iaqualink/client.js';
import { desiredOf, parseShadow } from './iaqualink/exo.js';
import { AqualinkError, errorReason } from './iaqualink/http.js';
import {
  HEAT_PUMP_SETPOINT,
  RAW_AUX_KINDS,
  SETPOINT_RANGE,
  TOGGLES,
  auxFeature,
  binaryOf,
  convertTemperature,
  lightParams,
  parseDevices,
  parseHome,
  roundBrightness,
  setTempsParams,
} from './iaqualink/iaqua.js';
import { StatePublisher } from './publisher.js';
import { fileStore, memoryOf, normalizeMemory } from './store.js';

/** Errors of one system only: the read goes on with the other systems. */
const SYSTEM_ERRORS = new Set(['http', 'bad_response']);
const SUPPORTED = new Set(Object.values(SYSTEM_TYPES));
/**
 * Failures after which a toggle may have reached the panel (no answer, 5xx,
 * an unreadable answer): it stays guarded. The others were refused or never
 * sent.
 */
const MAY_HAVE_REACHED = new Set(['network', 'unavailable', 'bad_response']);
/**
 * Failures of a sign-in that count towards the long pause: the service
 * answered, but badly (5xx, an unreadable answer). No answer at all
 * (`network`: the internet box still starting after a power cut...) follows
 * the normal backoff, 1 to 15 minutes.
 */
const LOGIN_FAILURES = new Set(['unavailable', 'bad_response']);

const freshSeen = () => ({ features: new Set(), aux: new Map(), heatingRange: undefined });

export class IaqualinkApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'iaqualink' }),
    fetch = globalThis.fetch,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
    requestSpacing = TIMINGS.requestSpacing,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.budget = new RequestBudget({ now, gap: requestSpacing });
    this.client = new AqualinkClient({
      budget: this.budget,
      fetch,
      now,
      sleep: (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms)),
      logger,
    });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    /** serial -> { serial, type, name, unit, seen, home, aux, shadow, failed } */
    this.systems = new Map();
    /** `[{ serial, type }]` of the devices of the account this integration does not read */
    this.unsupported = [];
    /** serial -> { type, unit, seen } read from /data */
    this.memory = {};
    this.systemsReadAt = undefined;
    this.readAt = undefined;
    this.nextReadAt = 0;
    /** Until when iAquaLink asked to slow down: no scan or test read before. */
    this.pausedUntil = 0;
    /** featureId -> { until, from }: a toggle just sent, and the state then */
    this.guards = new Map();
    /** serial -> tail of its command chain: one command at a time per system */
    this.chains = new Map();
    this.published = undefined;
    /** deviceId -> badge last published (JSON) */
    this.transports = new Map();
    this.timer = undefined;
    this.running = undefined;
    this.generation = 0;
    this.refused = false;
    this.offline = false;
    this.failures = 0;
    /** Sign-ins failed in a row (not refused): LIMITS.loginFailures of them pause 6 h. */
    this.loginFailures = 0;
    this.lastTestAt = -Infinity;
    this.started = false;
    this.lastStatus = undefined;
    this.warned = new Set();
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    await this.running;
    this.config = normalizeConfig(raw);
    this.reset();
    this.client.configure({ email: this.config.email, password: this.config.password });
    this.memory = normalizeMemory(await this.store.load().catch(() => null));
    this.publisher.start();
    if (!this.client.hasCredentials) {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    await this.setStatus(false, T.connecting);
    this.timer = this.timers.setInterval(() => {
      this.tick().catch((err) => this.logger.error(`iAquaLink read failed: ${err.message}`));
    }, TIMINGS.tickInterval);
    await this.refresh();
  }

  stop() {
    this.generation += 1;
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.publisher.stop();
  }

  /** Forgets the account and the failures: new credentials, or a restart. */
  reset() {
    this.systems.clear();
    this.unsupported = [];
    this.systemsReadAt = undefined;
    this.readAt = undefined;
    this.nextReadAt = 0;
    this.pausedUntil = 0;
    this.guards.clear();
    this.published = undefined;
    this.transports.clear();
    this.refused = false;
    this.offline = false;
    this.failures = 0;
    this.loginFailures = 0;
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (Discovery list,
   * status, badges) without reading iAquaLink again.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw);
    this.published = undefined;
    this.transports.clear();
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevices();
    await this.publishAllTransports();
  }

  /** New credentials restart; the rest applies at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    if (next.email !== previous.email || next.password !== previous.password) {
      return this.start(raw);
    }
    this.config = next;
    if (next.refreshInterval !== previous.refreshInterval && this.readAt !== undefined) {
      this.nextReadAt = Math.min(this.nextReadAt, this.readAt + next.refreshInterval * 1000);
    }
    if (
      next.language !== previous.language ||
      next.includeUnnamedAux !== previous.includeUnnamedAux
    ) {
      let changed = false;
      for (const system of this.systems.values()) {
        changed = observe(system, this.config) || changed;
      }
      if (changed) {
        await this.saveMemory();
      }
      await this.publishDevices();
      this.queueAll();
      await this.flush();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /**
   * Saves what was seen. A system missing from the last list (a hiccup of the
   * cloud) keeps its entry, so it comes back with its features.
   */
  async saveMemory() {
    for (const system of this.systems.values()) {
      this.memory[system.serial] = { type: system.type, unit: system.unit, seen: system.seen };
    }
    const entries = Object.entries(this.memory).map(([serial, entry]) => ({ serial, ...entry }));
    await this.store
      .save(memoryOf(entries))
      .catch((err) => this.logger.warn(`Saving the state failed: ${err.message}`));
  }

  // --- Reads -------------------------------------------------------------------

  /** Every few seconds: a read when one is due. */
  async tick() {
    if (this.now() >= this.nextReadAt) {
      await this.refresh();
    }
  }

  /** One read at a time: a call during a read joins it. */
  refresh() {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async run() {
    const generation = this.generation;
    if (!this.client.hasCredentials) {
      return;
    }
    try {
      if (
        this.systemsReadAt === undefined ||
        this.now() - this.systemsReadAt >= TIMINGS.systemsInterval
      ) {
        await this.readSystems();
      }
      let changed = false;
      for (const system of this.systems.values()) {
        if (generation !== this.generation) {
          return;
        }
        changed = (await this.readSystem(system)) || changed;
      }
      if (generation !== this.generation) {
        return;
      }
      this.readAt = this.now();
      this.nextReadAt = this.readAt + this.config.refreshInterval * 1000;
      this.failures = 0;
      this.loginFailures = 0;
      this.offline = false;
      this.refused = false;
      if (changed) {
        await this.saveMemory();
      }
      await this.publishDevices();
      this.queueAll();
      await this.setStatus(true, this.statusMessage());
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(err);
    }
    await this.publishAllTransports();
    await this.flush();
  }

  async readSystems() {
    const list = (await this.client.systems())
      .filter((s) => s && typeof s === 'object' && String(s.serial_number ?? '').trim() !== '')
      .slice(0, LIMITS.systems);
    this.systemsReadAt = this.now();
    const serials = new Set();
    this.unsupported = [];
    for (const raw of list) {
      const serial = String(raw.serial_number).trim();
      const type = String(raw.device_type ?? '');
      if (!SUPPORTED.has(type)) {
        this.unsupported.push({ serial, type });
        if (!this.warned.has(serial)) {
          this.warned.add(serial);
          this.logger.info(`iAquaLink device of type "${type}" is not supported yet`);
        }
        continue;
      }
      serials.add(serial);
      const known = this.systems.get(serial);
      if (known && known.type === type) {
        known.name = raw.name;
        continue;
      }
      const memory = this.memory[serial]?.type === type ? this.memory[serial] : undefined;
      this.systems.set(serial, {
        serial,
        type,
        name: raw.name,
        unit: memory?.unit,
        seen: memory?.seen ?? freshSeen(),
        home: undefined,
        aux: undefined,
        shadow: undefined,
        failed: false,
      });
    }
    for (const serial of [...this.systems.keys()]) {
      if (!serials.has(serial)) {
        this.systems.delete(serial);
      }
    }
  }

  /** Reads one system; true when it shows something new. */
  async readSystem(system) {
    try {
      if (system.type === SYSTEM_TYPES.IAQUA) {
        system.home = parseHome(await this.client.iaqua(system.serial, 'get_home'));
        this.checkUnit(system);
        if (system.home.status === 'online') {
          const devices = parseDevices(await this.client.iaqua(system.serial, 'get_devices'));
          if (devices.aux) {
            system.aux = devices.aux;
          }
        }
      } else {
        system.shadow = parseShadow(await this.client.shadow(system.serial));
      }
      system.failed = false;
    } catch (err) {
      if (!SYSTEM_ERRORS.has(err.kind)) {
        throw err;
      }
      system.failed = true;
      this.logger.warn(`${systemName(system)}: not read (${errorReason(err)})`);
      return false;
    }
    this.releaseGuards(system);
    return observe(system, this.config);
  }

  offlineCount() {
    return [...this.systems.values()].filter((s) => this.systemDown(s)).length;
  }

  systemDown(system) {
    const status = system.type === SYSTEM_TYPES.IAQUA ? system.home?.status : system.shadow?.status;
    return system.failed || (status !== undefined && status !== 'online');
  }

  statusMessage() {
    return T.connected(this.systems.size, this.unsupported.length, this.offlineCount());
  }

  async failed(err) {
    const reason = errorReason(err);
    if (err.kind === 'no_credentials') {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    if (err.kind === 'budget') {
      // Our own ceiling (commands took the room): the read waits a little.
      this.nextReadAt = this.now() + Math.max(this.budget.untilFree(), TIMINGS.requestSpacing);
      this.logger.debug('iAquaLink request budget spent: the read waits');
      return;
    }
    if (err.during === 'login' && LOGIN_FAILURES.has(err.kind)) {
      this.loginFailures += 1;
    }
    let wait;
    if (err.kind === 'refused') {
      this.refused = true;
      wait = TIMINGS.refusedRetry;
      await this.setStatus(false, T.refused(age(wait)));
    } else if (err.kind === 'rate_limited') {
      wait = this.pause(err);
      await this.setStatus(this.readAt !== undefined, T.rateLimited(age(wait)));
    } else if (this.loginFailures >= LIMITS.loginFailures) {
      // The sign-in service keeps answering badly: no hammering of it.
      wait = TIMINGS.loginFailurePause;
      this.offline = true;
      await this.setStatus(false, T.loginFailing(age(wait)));
    } else {
      wait = TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)];
      this.offline = true;
      await this.setStatus(false, T.unreachable(reasonOf(err), age(wait)));
    }
    this.failures += 1;
    this.nextReadAt = Math.max(this.nextReadAt, this.now() + wait);
    this.logger.warn(`iAquaLink: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  /** A 429 (read or command): the pause asked, kept between 1 minute and 1 hour. */
  pause(err) {
    const wait = Math.min(
      TIMINGS.rateLimitMax,
      Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitPause),
    );
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    this.nextReadAt = Math.max(this.nextReadAt, this.pausedUntil);
    return wait;
  }

  // --- Gladys ----------------------------------------------------------------

  async publishDevices() {
    if (this.readAt === undefined) {
      return;
    }
    const devices = [...this.systems.values()]
      .map((system) => buildDevice(this.gladys, system, this.config.language))
      .filter(Boolean);
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** Queues the states of one system (the features created in Gladys only). */
  queue(system, created = this.createdFeatures()) {
    const ids = systemIds(this.gladys, system.serial);
    for (const { key, ...value } of statesOf(system, this.config.language)) {
      const id = ids.feature(key);
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  queueAll(created = this.createdFeatures()) {
    for (const system of this.systems.values()) {
      this.queue(system, created);
    }
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  badge(system) {
    if (this.refused || this.offline) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    if (this.systemDown(system)) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE, degraded: true, message: T.systemOffline };
    }
    return { transport: DEVICE_TRANSPORTS.CLOUD };
  }

  async publishAllTransports() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    for (const system of this.systems.values()) {
      const externalId = systemIds(this.gladys, system.serial).device;
      if (!created.has(externalId)) {
        continue;
      }
      const entry = { external_id: externalId, ...this.badge(system) };
      const json = JSON.stringify(entry);
      if (this.transports.get(externalId) !== json) {
        this.transports.set(externalId, json);
        entries.push(entry);
      }
    }
    if (entries.length > 0) {
      await this.gladys
        .publishTransports(entries)
        .catch((err) => this.logger.warn(`Transport badges failed: ${err.message}`));
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.transports.delete(device?.external_id);
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueAll(created);
    await this.flush();
    await this.publishAllTransports();
  }

  async deviceDeleted(device) {
    this.transports.delete(device?.external_id);
    if (device?.external_id) {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: a fresh read if the last one is old enough. */
  async scan() {
    if (
      this.client.hasCredentials &&
      !this.refused &&
      this.now() >= this.pausedUntil &&
      (this.readAt === undefined || this.now() - this.readAt >= TIMINGS.testCooldown)
    ) {
      this.systemsReadAt = undefined;
      await this.refresh();
      return;
    }
    await this.publishDevices();
  }

  // --- Commands --------------------------------------------------------------

  denied(key) {
    return new Error(word(T.denied[key], this.config.language));
  }

  async setValue(_gladysDevice, feature, value) {
    const target = parseFeatureId(this.gladys, feature?.external_id);
    if (!target) {
      throw new Error(`${feature?.external_id} is not an iAquaLink feature`);
    }
    if (!this.config.allowCommands) {
      throw this.denied('commands');
    }
    const system = this.systems.get(target.serial);
    if (!system || this.refused || this.readAt === undefined) {
      throw this.denied('notReady');
    }
    if (this.now() < this.pausedUntil) {
      // iAquaLink asked to slow down: commands wait for the end of the pause too.
      throw new Error(
        word(T.rateLimited(age(this.pausedUntil - this.now())), this.config.language),
      );
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error(`Unexpected value "${value}"`);
    }
    // One command at a time per system: two "turn on" received together must
    // not both read "off" and send two toggles.
    // The 5 s of the ack run from now, also while waiting behind another command.
    const received = this.now();
    return this.serialized(system.serial, () => this.command(system, target.key, number, received));
  }

  /** Runs `task` after the previous task of the same key (a promise chain per key). */
  serialized(key, task) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    this.chains.set(key, tail);
    tail.then(() => {
      if (this.chains.get(key) === tail) {
        this.chains.delete(key);
      }
    });
    return run;
  }

  /** Room for `count` requests now, or a refusal (the command is not queued for later). */
  needRequests(count) {
    if (this.budget.remaining() < count) {
      throw this.denied('budget');
    }
  }

  /** The state read before a command: no gap, at most TIMINGS.commandReadDeadline. */
  readOptions() {
    return { urgent: true, timeout: TIMINGS.commandReadDeadline };
  }

  /** Gladys awaits the ack 5 s: a read that came too late sends nothing. */
  checkDeadline(started) {
    if (this.now() - started > TIMINGS.commandReadDeadline) {
      throw this.denied('slow');
    }
  }

  /** The command request: no gap, what is left of the ack budget. */
  sendOptions(started) {
    return {
      urgent: true,
      timeout: Math.max(TIMINGS.commandSendMin, TIMINGS.commandAckBudget - (this.now() - started)),
    };
  }

  async command(system, key, value, started = this.now()) {
    try {
      if (system.type === SYSTEM_TYPES.IAQUA) {
        await this.iaquaCommand(system, key, value, started);
      } else {
        await this.exoCommand(system, key, value, started);
      }
    } catch (err) {
      if (err.kind === 'rate_limited') {
        // Commands respect the pause asked by iAquaLink, like the reads.
        this.pause(err);
      }
      if (err instanceof AqualinkError) {
        // The ack shows a short reason, never a URL or a token.
        throw new Error(word(reasonOf(err), this.config.language), { cause: err });
      }
      throw err;
    } finally {
      this.queue(system);
      await this.flush();
    }
  }

  binary(value) {
    if (value !== 0 && value !== 1) {
      throw new Error(`Unexpected value "${value}" (0 or 1)`);
    }
    return value;
  }

  /** The active guard of a feature, or undefined (an expired one is dropped). */
  guardOf(system, key) {
    const id = systemIds(this.gladys, system.serial).feature(key);
    const guard = this.guards.get(id);
    if (guard && guard.until !== undefined && this.now() >= guard.until) {
      this.guards.delete(id);
      return undefined;
    }
    return guard;
  }

  /**
   * A guard ends when it expires, or when a reading of the system ONLINE shows
   * the equipment in the expected state (1 - from); never on an unknown state.
   */
  releaseGuards(system, online = system.home?.status === 'online') {
    const prefix = `${systemIds(this.gladys, system.serial).device}:`;
    for (const [id, guard] of this.guards) {
      if (!id.startsWith(prefix)) {
        continue;
      }
      const expired = guard.until !== undefined && this.now() >= guard.until;
      if (expired || (online && this.currentOf(system, guard.key) === 1 - guard.from)) {
        this.guards.delete(id);
      }
    }
  }

  /** The current 0/1 of a toggled feature of a panel, from the last reading. */
  currentOf(system, key) {
    if (TOGGLES[key]) {
      return binaryOf(system.home?.values[TOGGLES[key].home], { heater: key.endsWith('heater') });
    }
    const aux = (system.aux ?? []).find((a) => auxFeature(a) === key);
    return aux ? binaryOf(aux.state) : undefined;
  }

  /**
   * Sends one toggle, or nothing. While the previous toggle of the feature is
   * not reported, the equipment is expected in the other state: asking that
   * one succeeds without sending, asking the old one is refused.
   */
  async toggle(system, key, on, current, send) {
    const guard = this.guardOf(system, key);
    if (guard) {
      if (on === 1 - guard.from) {
        return;
      }
      throw this.denied('moving');
    }
    if (current === undefined) {
      throw this.denied('unknown');
    }
    if (current === on) {
      return;
    }
    const id = systemIds(this.gladys, system.serial).feature(key);
    // `until` is set once the request ended: the guard counts from then.
    const entry = { from: current, key, until: undefined };
    this.guards.set(id, entry);
    try {
      await send();
    } catch (err) {
      if (MAY_HAVE_REACHED.has(err.kind)) {
        entry.until = this.now() + TIMINGS.toggleGuard;
      } else {
        // Refused or never sent: nothing to guard.
        this.guards.delete(id);
      }
      throw err;
    }
    entry.until = this.now() + TIMINGS.toggleGuard;
  }

  /** The panel reports another temperature scale than the frozen unit: logged once. */
  checkUnit(system) {
    const scale = system.home?.tempUnit;
    if (system.unit && scale && scale !== system.unit && !system.unitWarned) {
      system.unitWarned = true;
      this.logger.warn(
        `${systemName(system)}: the panel now reports in °${scale}, the features are in °${system.unit}: values converted`,
      );
    }
  }

  async iaquaCommand(system, key, value, started) {
    const { serial } = system;
    if (key.startsWith('aux-')) {
      return this.iaquaAux(system, key, value, started);
    }
    const toggle = TOGGLES[key];
    const setpoint = /^(pool|spa)-setpoint$/.exec(key)?.[1];
    if (!toggle && !setpoint) {
      throw new Error(`${key} cannot be set`);
    }
    const on = toggle ? this.binary(value) : undefined;
    this.needRequests(2);
    // The state read right now, never an older one.
    const home = parseHome(await this.client.iaqua(serial, 'get_home', {}, this.readOptions()));
    system.home = home;
    this.checkUnit(system);
    this.releaseGuards(system);
    if (home.status !== 'online') {
      throw this.denied('offline');
    }
    this.checkDeadline(started);
    if (toggle) {
      await this.toggle(system, key, on, this.currentOf(system, key), () =>
        this.client.iaqua(serial, toggle.command, {}, this.sendOptions(started)),
      );
      // The answer is not shown: the panel may still report the old state, the
      // next read (or the guard) tells.
      this.logger.info(`${systemName(system)}: ${toggle.command} (${on ? 'on' : 'off'})`);
      return;
    }
    const scale = home.tempUnit;
    const unit = system.unit ?? scale;
    if (!scale) {
      throw this.denied('unit');
    }
    const range = SETPOINT_RANGE[scale];
    // Gladys sends the value in the unit of the feature; the panel takes its own.
    const target = Math.round(convertTemperature(value, unit, scale));
    if (target < range.min || target > range.max) {
      const shown = SETPOINT_RANGE[unit];
      throw new Error(word(T.denied.range(shown.min, shown.max), this.config.language));
    }
    if (home.heatPump) {
      // A paired heat pump owns the set points (iaqualink-py `_set_value`).
      await this.client.iaqua(
        serial,
        'setpoint_hpm_temp',
        { [HEAT_PUMP_SETPOINT[setpoint]]: String(target) },
        this.sendOptions(started),
      );
      system.home.values[`${setpoint}_set_point`] = String(target);
    } else {
      const params = setTempsParams(home.values, setpoint, target);
      if (Object.values(params).some((v) => !/^\d+$/.test(String(v)))) {
        // The other set point is sent again: it must be known.
        throw this.denied('unknown');
      }
      this.applyHome(
        system,
        await this.client.iaqua(serial, 'set_temps', params, this.sendOptions(started)),
      );
    }
    this.logger.info(`${systemName(system)}: ${setpoint} set point ${target} °${scale}`);
  }

  /** A command answer holding the home screen updates the reading. */
  applyHome(system, answer) {
    try {
      const home = parseHome(answer);
      if (home.status === 'online') {
        system.home = home;
      }
    } catch {
      // Not a home screen: the next read shows the result.
    }
  }

  /** Plain auxiliaries and valve actuators can drive anything: their own opt-in. */
  checkAuxAllowed(...kinds) {
    if (kinds.some((kind) => RAW_AUX_KINDS.includes(kind)) && !this.config.allowAuxCommands) {
      throw this.denied('aux');
    }
  }

  async iaquaAux(system, key, value, started) {
    const { serial } = system;
    const brightness = key.endsWith('-brightness');
    const auxKey = brightness ? key.slice(0, -'-brightness'.length) : key;
    const seenKind = [...system.seen.aux.values()].find((a) => auxFeature(a) === auxKey)?.kind;
    this.checkAuxAllowed(seenKind);
    const on = brightness ? undefined : this.binary(value);
    this.needRequests(2);
    const devices = parseDevices(
      await this.client.iaqua(serial, 'get_devices', {}, this.readOptions()),
    );
    if (devices.status !== 'online') {
      throw this.denied('offline');
    }
    if (!devices.aux) {
      throw this.denied('unknown');
    }
    system.aux = devices.aux;
    // The devices screen just said "online": the guards may end on it.
    this.releaseGuards(system, true);
    const aux = devices.aux.find((a) => auxFeature(a) === auxKey);
    if (!aux) {
      throw new Error(`${key} is not an auxiliary of this panel`);
    }
    this.checkAuxAllowed(aux.kind);
    this.checkDeadline(started);
    if (!brightness && (RAW_AUX_KINDS.includes(aux.kind) || aux.kind === 'light')) {
      // Plain auxiliaries, valve actuators and on/off lights only toggle; the
      // answer is not shown.
      const command = `set_aux_${aux.suffix}`;
      await this.toggle(system, auxKey, on, binaryOf(aux.state), () =>
        this.client.iaqua(serial, command, {}, this.sendOptions(started)),
      );
      this.logger.info(`${systemName(system)}: ${command} (${on ? 'on' : 'off'})`);
      return;
    }
    let params;
    if (brightness) {
      if (aux.kind !== 'dimmer') {
        throw new Error(`${key} cannot be set`);
      }
      const level = roundBrightness(Math.max(0, Math.min(100, value)));
      params = lightParams(aux, { on: level > 0, brightness: level });
    } else {
      const current = binaryOf(aux.state);
      if (current === undefined) {
        throw this.denied('unknown');
      }
      if (current === on) {
        return;
      }
      params = lightParams(aux, { on: on === 1 });
    }
    // Lights take an absolute value: their answer can be shown.
    const answer = await this.client.iaqua(serial, 'set_light', params, this.sendOptions(started));
    this.logger.info(`${systemName(system)}: set_light ${aux.key}`);
    try {
      const after = parseDevices(answer);
      if (after.status === 'online' && after.aux) {
        system.aux = after.aux;
      }
    } catch {
      // Not a devices screen: the next read shows the result.
    }
  }

  async exoCommand(system, key, value, started) {
    if (!desiredOf(key, 0)) {
      throw new Error(`${key} cannot be set`);
    }
    if (/^aux-\d+$/.test(key)) {
      this.checkAuxAllowed('switch');
    }
    const target = key === 'heating-setpoint' ? Math.round(value) : this.binary(value);
    this.needRequests(2);
    const shadow = parseShadow(await this.client.shadow(system.serial, this.readOptions()));
    system.shadow = shadow;
    if (shadow.status !== 'online') {
      throw this.denied('offline');
    }
    let current;
    if (key === 'heating-setpoint') {
      if (!shadow.heating) {
        throw new Error(`${key} cannot be set`);
      }
      const min = shadow.heating.min ?? SETPOINT_RANGE.C.min;
      const max = shadow.heating.max ?? SETPOINT_RANGE.C.max;
      if (target < min || target > max) {
        throw new Error(word(T.denied.range(min, max), this.config.language));
      }
      current = shadow.heating.sp;
    } else {
      current = this.exoCurrent(shadow, key);
    }
    if (current === undefined) {
      // Not reported just now: nothing is decided on an unknown state.
      throw this.denied('unknown');
    }
    if (current === target) {
      return;
    }
    this.checkDeadline(started);
    await this.client.desire(system.serial, desiredOf(key, target), this.sendOptions(started));
    this.logger.info(`${systemName(system)}: ${key} -> ${target}`);
    // Shown at once; the next read of the shadow confirms it.
    this.setExoValue(shadow, key, target);
  }

  exoCurrent(shadow, key) {
    const v = shadow.values;
    const aux = /^aux-(\d+)$/.exec(key);
    if (aux) {
      return shadow.aux.find((a) => a.key === `aux_${aux[1]}`)?.state;
    }
    return {
      production: v.production,
      boost: v.boost,
      low: v.low,
      'filter-pump': v.filterPump,
      heating: shadow.heating?.enabled,
    }[key];
  }

  setExoValue(shadow, key, target) {
    const aux = /^aux-(\d+)$/.exec(key);
    if (aux) {
      const entry = shadow.aux.find((a) => a.key === `aux_${aux[1]}`);
      if (entry) {
        entry.state = target;
      }
    } else if (key === 'heating' && shadow.heating) {
      shadow.heating.enabled = target;
    } else if (key === 'heating-setpoint' && shadow.heating) {
      shadow.heating.sp = target;
    } else {
      const field = {
        production: 'production',
        boost: 'boost',
        low: 'low',
        'filter-pump': 'filterPump',
      }[key];
      shadow.values[field] = target;
    }
  }

  // --- "Test the connection" button -----------------------------------------

  async testConnection() {
    if (!this.client.hasCredentials) {
      return T.noCredentials;
    }
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      const summary = this.summary();
      return {
        en: `${T.test.cooldown.en} ${summary.en}`,
        fr: `${T.test.cooldown.fr} ${summary.fr}`,
      };
    }
    if (this.now() < this.pausedUntil) {
      // iAquaLink asked to slow down: the button does not read before the pause ends.
      return T.rateLimited(age(this.pausedUntil - this.now()));
    }
    this.lastTestAt = this.now();
    // One sign-in per click: the button is how refused credentials are retried at once.
    this.client.allowLogin();
    this.refused = false;
    this.loginFailures = 0;
    this.nextReadAt = 0;
    this.systemsReadAt = undefined;
    await this.running;
    await this.refresh();
    const [connected, message] = JSON.parse(this.lastStatus ?? '[false,null]');
    if (!connected || this.readAt === undefined) {
      return message ?? T.noCredentials;
    }
    return this.summary();
  }

  summary() {
    return T.test.summary(this.systems.size, this.unsupported.length, this.offlineCount());
  }
}
