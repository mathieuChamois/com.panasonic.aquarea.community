'use strict';

const Homey = require('homey');
const AquareaClient = require('../../lib/AquareaClient');

// Default polling interval: 5 minutes.
// ⚠️  Deliberately high, to avoid rate-limiting / IP bans from Aquarea Smart
//     Cloud. Do NOT go below this floor without a good reason.
const DEFAULT_POLL_INTERVAL_S = 300;
const MIN_POLL_INTERVAL_S = 60;

// After a command the cloud has accepted, Aquarea keeps returning the old
// value for several minutes (the gateway only reports its state periodically).
// Unprotected, the next poll overwrites the value chosen in the app and the
// user sees the tile "jump back". So we trust the command: the local value
// wins until the cloud confirms it, or at most for OPTIMISTIC_TTL_MS.
const OPTIMISTIC_TTL_MS = 15 * 60 * 1000;

// Courtesy refresh after a command. Deliberately long: querying the cloud 5 s
// after an order only returns stale data and brings rate-limiting closer.
const POST_COMMAND_REFRESH_MS = 90 * 1000;

// Fallback ranges, used only when the API does not report heatMin/heatMax.
// Without them, the manifest bounds would stay applied to a capability that
// does not represent the same quantity.
const FALLBACK_CURVE_OFFSET_RANGE = { min: -5, max: 5, step: 1 };
const FALLBACK_WATER_SETPOINT_RANGE = { min: 20, max: 60, step: 1 };
const FALLBACK_WATER_COOL_RANGE = { min: 5, max: 25, step: 1 };
const FALLBACK_TANK_RANGE = { min: 40, max: 65, step: 1 };

// Controllable capabilities -> method handling the command.
const COMMAND_HANDLERS = {
  'target_temperature': '_onSetTargetTemperature',
  'target_temperature.zone': '_onSetZoneTemperature',
  'thermostat_mode': '_onCapabilityThermostatMode',
  'cooling_mode': '_onSetCoolingMode',
  'onoff.tank': '_onSetTankOnoff',
  'onoff.zone': '_onSetZoneOnoff',
  'quiet_mode': '_onSetQuietMode',
  'powerful_mode': '_onSetPowerfulMode',
  'holiday_mode': '_onSetHolidayMode',
};

class AquareaDevice extends Homey.Device {

  async onInit() {
    const { id } = this.getData();
    this.deviceId = id;
    this.deviceType = String(this.getStoreValue('deviceType') || '2');
    this._experimentalDiagnosticPending = this.deviceType !== '2';

    this.log(`Aquarea device init: ${this.getName()} (${this.deviceId}, Comfort Cloud type ${this.deviceType})`);

    // Instantiate the client from the credentials stored at pairing time.
    const username = this.getStoreValue('username');
    const password = this.getStoreValue('password');

    if (!username || !password) {
      this.setUnavailable(this.homey.__('error.missing_credentials'));
      return;
    }

    // Active zone (updated on every poll). Default: 1.
    this.zoneId = 1;

    // Current operating direction. It decides which zone setpoint the tile
    // shows and which field a setpoint command writes: heatSet when heating,
    // coolSet when cooling. Kept across restarts, otherwise the tile would show
    // the heating setpoint on a cooling heat pump until the first poll.
    this._cooling = Boolean(this.getStoreValue('cooling'));

    // Optimistic cache: capability -> { value, until }. See _commit().
    this._optimistic = new Map();

    // Capabilities whose command listener is already registered.
    this._listeners = new Set();

    // Layout deduced from the last poll (DHW tank, zone sensor type, nature of
    // the setpoint). It drives the capability list: no point showing a tank
    // setpoint on a heat pump that has no tank. Defaults to the most common
    // installation: tank + room sensor.
    this._layout = this.getStoreValue('layout')
      || this._computeLayout({ hasTank: true, zoneSensorIsWater: false, zoneIsCurveOffset: false });

    // The client must exist before _syncCapabilities(): that one registers the
    // command listeners, which can be triggered immediately.
    this.client = new AquareaClient({
      username,
      password,
      log: (...a) => this.log(...a),
      error: (...a) => this.error(...a),
    });

    // Restore any persisted session (tokens + clientId + cookies), to avoid a
    // full re-authentication on every restart.
    const savedSession = this.getStoreValue('session');
    if (savedSession) this.client.importSession(savedSession);

    await this._syncCapabilities(this._layout);
    await this._refreshUiIndicator();

    // Start the polling engine.
    this._startPolling();

    // First refresh, immediate (but guarded).
    this._poll().catch(err => this.error('Initial poll failed:', err.message));
  }

  // =========================================================================
  //  Device card composition (capabilities)
  // =========================================================================

  /**
   * Tries to migrate the tile indicator without recreating the device.
   * Depending on the Homey version, the setter may be exposed directly or
   * through the Devices API. Refreshing the class is the non-destructive
   * fallback.
   */
  async _refreshUiIndicator() {
    const migrationKey = 'ui_indicator_refresh_v1';
    if (this.getStoreValue(migrationKey)) return;

    const candidates = [
      'measure_temperature',
      'measure_water_temperature',
      'measure_temperature.zone',
      'measure_temperature.outdoor',
    ];
    const indicator = candidates.find(capability => this.hasCapability(capability));
    if (!indicator) {
      this.error('[UI indicator] Aucune capability de température disponible');
      return;
    }

    try {
      if (typeof this.setUiIndicator === 'function') {
        await this.setUiIndicator(indicator);
        this.log(`[UI indicator] Mis à jour via Device.setUiIndicator: ${indicator}`);
      } else if (this.homey.api && this.homey.api.devices
        && typeof this.homey.api.devices.updateDevice === 'function') {
        await this.homey.api.devices.updateDevice({
          id: typeof this.getId === 'function' ? this.getId() : this.deviceId,
          device: { uiIndicator: indicator },
        });
        this.log(`[UI indicator] Mis à jour via Devices.updateDevice: ${indicator}`);
      } else if (typeof this.setClass === 'function' && typeof this.getClass === 'function') {
        // Force Homey to recompute the UI metadata without changing the
        // device identity or the references used in Flows.
        await this.setClass(this.getClass());
        this.log(`[UI indicator] Métadonnées UI rafraîchies (indicateur demandé: ${indicator})`);
      } else {
        this.error('[UI indicator] Cette version de Homey ne fournit aucun mécanisme de migration');
        return;
      }

      await this.setStoreValue(migrationKey, true);
    } catch (err) {
      this.error(`[UI indicator] Échec du rafraîchissement: ${err.message}`);
    }
  }

  /**
   * Decides which capability carries which quantity.
   *
   * `measure_temperature` and `target_temperature` are Homey's "main"
   * capabilities: `measure_temperature` feeds the room temperature (and
   * therefore the home's zone averages), `target_temperature` the thermostat
   * card. We only put a value there when it really has that meaning:
   *
   *  - zoneSensor = 0 => `temperatureNow` is the WATER temperature of the
   *    circuit. It goes to `measure_water_temperature`; publishing 26 °C of
   *    water as a room temperature would skew the home climate.
   *  - heatMin < 0 => `heatSet` is a heating curve offset in K, not a setpoint
   *    in °C: it goes to `target_temperature.zone`, which carries its own label
   *    and its own range.
   */
  _computeLayout(data) {
    const hasTank = Boolean(data.hasTank);
    const zoneIsWater = Boolean(data.zoneSensorIsWater);
    const zoneIsOffset = Boolean(data.zoneIsCurveOffset);

    return {
      hasTank,
      hasBivalent: Boolean(data.config && data.config.bivalent),
      // coolMode = 0 on a heating-only heat pump: no point showing a
      // heat/cool switch that could not control anything.
      hasCooling: Boolean(data.config && data.config.coolMode),
      zoneIsWater,
      zoneIsOffset,
      // The DHW tank, when present, takes the main capabilities.
      tankTempCap: hasTank ? 'measure_temperature' : null,
      tankSetpointCap: hasTank ? 'target_temperature' : null,
      zoneTempCap: zoneIsWater
        ? 'measure_water_temperature'
        : (hasTank ? 'measure_temperature.zone' : 'measure_temperature'),
      zoneSetpointCap: (hasTank || zoneIsOffset)
        ? 'target_temperature.zone'
        : 'target_temperature',
    };
  }

  /**
   * Ordered capability list for this hardware. The array order = the order of
   * the tiles on the device card.
   */
  _desiredCapabilities(layout) {
    const { hasTank, hasBivalent } = layout;
    const caps = [];

    if (layout.hasCooling) caps.push('cooling_mode');
    caps.push(layout.zoneSetpointCap);
    if (layout.tankSetpointCap) caps.push(layout.tankSetpointCap);
    if (hasTank) caps.push('onoff.tank');
    caps.push('onoff.zone');
    if (layout.tankTempCap) caps.push(layout.tankTempCap);
    caps.push(layout.zoneTempCap);

    caps.push('measure_temperature.outdoor');

    // Operating states reported by the cloud (read-only).
    caps.push('operation_direction', 'special_status');
    // Homey Mobile opens the last "picker" control by default. thermostat_mode
    // is therefore placed after the other pickers, so that the third tab opens
    // on "Operation mode".
    caps.push('quiet_mode', 'powerful_mode', 'thermostat_mode', 'defrost_active', 'force_heater');
    if (hasTank) caps.push('force_dhw', 'electric_anode');
    if (hasBivalent) caps.push('bivalent_active');
    caps.push('holiday_mode', 'measure_water_pressure', 'pump_running');
    caps.push('meter_power.heat', 'meter_power.cool');
    if (hasTank) caps.push('meter_power.tank');
    caps.push('measure_cost.heat', 'measure_cost.cool');
    if (hasTank) caps.push('measure_cost.tank');

    return caps;
  }

  /**
   * Aligns the device capabilities with `_desiredCapabilities()`.
   *
   * Homey freezes the capability order at the moment they are added: changing
   * the order means removing then re-adding them. We only do it when the actual
   * list really differs, because the operation clears the values (they are
   * repopulated on the next poll).
   */
  async _syncCapabilities(layout) {
    const desired = this._desiredCapabilities(layout);
    const current = this.getCapabilities();

    const identical = current.length === desired.length
      && desired.every((cap, i) => current[i] === cap);
    if (identical) {
      this._registerCommandListeners();
      return;
    }

    this.log('Rebuilding capabilities: '
      + `tank=${layout.hasTank} bivalent=${layout.hasBivalent} `
      + `zoneSensor=${layout.zoneIsWater ? 'water' : 'room'} `
      + `zoneSetpoint=${layout.zoneIsOffset ? 'curve offset' : 'absolute'}`);
    this._listeners.clear();
    this._rangesSignature = null;

    for (const cap of current) {
      try { await this.removeCapability(cap); } catch (err) { this.error(`removeCapability(${cap})`, err.message); }
    }
    for (const cap of desired) {
      try { await this.addCapability(cap); } catch (err) { this.error(`addCapability(${cap})`, err.message); }
    }

    this._registerCommandListeners();
  }

  /** Registers the command listeners of the capabilities that are present. */
  _registerCommandListeners() {
    for (const [cap, method] of Object.entries(COMMAND_HANDLERS)) {
      if (!this.hasCapability(cap) || this._listeners.has(cap)) continue;
      this.registerCapabilityListener(cap, this[method].bind(this));
      this._listeners.add(cap);
    }
  }

  // =========================================================================
  //  Polling engine
  // =========================================================================

  _resolveInterval() {
    let seconds = Number(this.getSetting('poll_interval'));
    if (!Number.isFinite(seconds)) seconds = DEFAULT_POLL_INTERVAL_S;
    if (seconds < MIN_POLL_INTERVAL_S) seconds = MIN_POLL_INTERVAL_S;
    return seconds * 1000;
  }

  _startPolling() {
    this._stopPolling();
    const ms = this._resolveInterval();
    this.log(`Polling every ${ms / 1000}s`);
    this._pollTimer = this.homey.setInterval(() => {
      this._poll().catch(err => this.error('Poll failed:', err.message));
    }, ms);
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _cancelRefresh() {
    if (this._refreshTimer) {
      this.homey.clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  /** Fetches the state from the cloud and syncs the capabilities. */
  async _poll() {
    if (this._polling) return; // avoids two polls overlapping.
    this._polling = true;

    try {
      const diagnostic = this._experimentalDiagnosticPending;
      const data = await this.client.getDeviceData(this.deviceId, {
        diagnostic,
        deviceType: this.deviceType,
      });
      if (diagnostic) this._experimentalDiagnosticPending = false;

      if (data.zoneId != null) this.zoneId = data.zoneId;

      // Ids of every zone: the Flow cards can target a secondary zone, which
      // the (single-zone) capabilities do not expose.
      this._zoneIds = (data.zones || [])
        .map(z => Number(z.zoneId))
        .filter(n => Number.isFinite(n));

      // The hardware actually present may differ from what we assumed: rebuild
      // the card before writing the values.
      await this._applyLayout(data);

      // Operating direction: drives the zone setpoint (heatSet or coolSet) and
      // therefore the ranges. Must be resolved before _applyRanges().
      await this._applyDirection(data);

      // Apply the real min/max ranges reported by the API.
      await this._applyRanges(data);

      const layout = this._layout;
      if (layout.tankTempCap) {
        await this._setCapability(layout.tankTempCap, data.tankTemperature);
        await this._setCapability(layout.tankSetpointCap, data.tankTargetTemperature);
        await this._setCapability('onoff.tank', data.tankOn);
      }
      await this._setCapability(layout.zoneTempCap, data.zoneTemperature);
      await this._setCapability(layout.zoneSetpointCap,
        this._cooling ? data.zoneCoolSet : data.zoneHeatSet);
      await this._setCapability('onoff.zone', data.zoneOn);

      // System.
      await this._setCapability('measure_temperature.outdoor', data.outdoorTemperature);
      await this._setCapability('measure_water_pressure', data.waterPressure);
      await this._setCapability('pump_running', data.pumpRunning);
      await this._setCapability('thermostat_mode', data.thermostatMode);
      await this._setCapability('cooling_mode', data.isCooling);

      // Operating states.
      await this._setCapability('operation_direction', data.direction);
      await this._setCapability('special_status', data.specialStatus);
      await this._setCapability('quiet_mode', data.quietMode);
      await this._setCapability('powerful_mode', data.powerfulMode);
      await this._setCapability('defrost_active', data.defrosting);
      await this._setCapability('force_heater', data.forceHeater);
      await this._setCapability('force_dhw', data.forceDhw);
      await this._setCapability('electric_anode', data.electricAnode);
      await this._setCapability('bivalent_active', data.bivalentActive);
      await this._setCapability('holiday_mode', data.holidayMode);

      // Installation details (read-only settings).
      await this._updateInfoSettings(data);

      // Today's energy consumption (separate endpoint, errors are non-fatal).
      await this._pollConsumption();

      // Persist the refreshed session so it survives restarts.
      await this.setStoreValue('session', this.client.exportSession());

      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.error('Polling error:', err.message);
      // Keep the device available except on a persistent auth error.
      if (/identifiants|invalid|2FA|authorization code|access token/i.test(err.message)) {
        await this.setUnavailable(this.homey.__('error.connection_failed', { message: err.message }));
      }
    } finally {
      this._polling = false;
    }
  }

  async _pollConsumption() {
    try {
      const c = await this.client.getConsumptionToday(this.deviceId);
      if (!c) return;

      const kwhCost = Number(this.getSetting('kwh_cost')) || 0;
      const calc = (kwh, cloudCost) => {
        if (kwhCost > 0) return Math.round(kwh * kwhCost * 1000) / 1000;
        return cloudCost;
      };

      await this._setCapability('meter_power.heat', c.heatKwh);
      await this._setCapability('meter_power.cool', c.coolKwh);
      await this._setCapability('measure_cost.heat', calc(c.heatKwh, c.heatCost));
      await this._setCapability('measure_cost.cool', calc(c.coolKwh, c.coolCost));
      if (this._layout.hasTank) {
        await this._setCapability('meter_power.tank', c.tankKwh);
        await this._setCapability('measure_cost.tank', calc(c.tankKwh, c.tankCost));
      }
    } catch (err) {
      this.error('Consumption poll error:', err.message);
    }
  }

  /**
   * Writes a capability. Values coming from the cloud (force = false) are
   * ignored until a recent local command has been confirmed.
   */
  async _setCapability(cap, value, { force = false } = {}) {
    if (value === null || typeof value === 'undefined') return;
    if (!this.hasCapability(cap)) return;
    if (!force && this._isMasked(cap, value)) return;

    // Read before writing: this is the single choke point for values, so the
    // right place to fire the Flow cards on a state change.
    const previous = this.getCapabilityValue(cap);

    try {
      await this.setCapabilityValue(cap, value);
    } catch (err) {
      this.error(`setCapabilityValue(${cap}) failed:`, err.message);
      return;
    }

    // `previous === null` = first value known after a (re)start: that is not a
    // hardware state change, so nothing is fired.
    if (previous !== null && typeof previous !== 'undefined' && !this._sameValue(previous, value)) {
      this.homey.app.triggerCapabilityChange(this, cap, value, previous);
    }
  }

  // =========================================================================
  //  Optimistic command cache
  // =========================================================================

  /**
   * Applies the commanded value immediately and protects it from being
   * overwritten by the cloud. Only call it after the HTTP request has been
   * acknowledged: absent a network / application error, the order is considered
   * delivered.
   */
  async _commit(cap, value) {
    if (!this.hasCapability(cap)) return;
    this._optimistic.set(cap, { value, until: Date.now() + OPTIMISTIC_TTL_MS });
    await this._setCapability(cap, value, { force: true });
  }

  /** true when the cloud value must be ignored for this capability. */
  _isMasked(cap, incoming) {
    const pending = this._optimistic.get(cap);
    if (!pending) return false;

    if (Date.now() >= pending.until) {
      this.log(`Optimistic value for ${cap} expired, trusting cloud again`);
      this._optimistic.delete(cap);
      return false;
    }
    if (this._sameValue(pending.value, incoming)) {
      // The cloud has caught up: polling takes over again.
      this._optimistic.delete(cap);
      return false;
    }
    this.log(`Ignoring stale cloud value for ${cap} (${incoming}), keeping ${pending.value}`);
    return true;
  }

  _sameValue(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.01;
    return a === b;
  }

  // =========================================================================
  //  Adaptation to the real installation
  // =========================================================================

  /** Rebuilds the card when the deduced layout has changed. */
  async _applyLayout(data) {
    const layout = this._computeLayout(data);
    if (JSON.stringify(layout) === JSON.stringify(this._layout)) return;

    this._layout = layout;
    this._rangesSignature = null;
    await this.setStoreValue('layout', layout);
    await this._syncCapabilities(layout);
  }

  /**
   * Updates the operating direction (heating / cooling).
   *
   * Aquarea keeps two independent zone setpoints, heatSet and coolSet. Only one
   * is meaningful at any given time: the setpoint tile and the commands must
   * follow the current direction, otherwise the user adjusts the heating
   * setpoint while believing they are adjusting the cooling one.
   *
   * `isCooling` is null when the unit is off: the last known direction is then
   * kept rather than falling back to "heating".
   */
  async _applyDirection(data) {
    if (data.isCooling === null || typeof data.isCooling === 'undefined') return;
    if (data.isCooling === this._cooling) return;

    this.log(`Direction changed: ${this._cooling ? 'cooling' : 'heating'} -> ${data.isCooling ? 'cooling' : 'heating'}`);
    this._cooling = data.isCooling;
    await this.setStoreValue('cooling', this._cooling);

    // The displayed setpoint changes meaning: an optimistic value inherited
    // from the other direction would mask the right value for its whole TTL.
    this._optimistic.delete(this._layout.zoneSetpointCap);
    // Label, units and bounds differ between heating and cooling.
    this._rangesSignature = null;
  }

  /**
   * Applies the device's real min/max ranges to the setpoint capabilities,
   * based on heatMin/heatMax (or coolMin/coolMax) reported by the API.
   *
   * The zone setpoint is either an absolute water temperature or a heating
   * curve offset (typical range -5..+5): the label follows.
   */
  async _applyRanges(data) {
    const layout = this._layout;
    const cooling = this._cooling;

    // A heating curve offset is expressed in kelvin, not in absolute degrees.
    let zoneLabel;
    if (layout.zoneIsOffset) {
      zoneLabel = cooling
        ? { en: 'Zone cooling curve offset', fr: "Decalage loi d'eau froid zone" }
        : { en: 'Zone curve offset', fr: "Decalage loi d'eau zone" };
    } else {
      zoneLabel = cooling
        ? { en: 'Zone cooling setpoint', fr: 'Consigne froid zone' }
        : { en: 'Zone water setpoint', fr: "Consigne d'eau zone" };
    }
    const zoneUnits = layout.zoneIsOffset ? { en: 'K', fr: 'K' } : { en: '°C', fr: '°C' };

    // ⚠️  If the API reports no range, min/max MUST still be sent: otherwise
    //     the manifest bounds (40-65 °C, meant for the tank) stay in place on a
    //     zone setpoint. So we always send a complete title + units +
    //     min/max/step set, which is equally safe whether setCapabilityOptions
    //     replaces or merges the existing options.
    const zoneMin = cooling ? data.zoneCoolMin : data.zoneHeatMin;
    const zoneMax = cooling ? data.zoneCoolMax : data.zoneHeatMax;
    let zoneFallback;
    if (layout.zoneIsOffset) zoneFallback = FALLBACK_CURVE_OFFSET_RANGE;
    else zoneFallback = cooling ? FALLBACK_WATER_COOL_RANGE : FALLBACK_WATER_SETPOINT_RANGE;

    const zoneRange = zoneMin != null && zoneMax != null
      ? { min: zoneMin, max: zoneMax, step: 1 }
      : zoneFallback;
    const tankRange = data.tankHeatMin != null && data.tankHeatMax != null
      ? { min: data.tankHeatMin, max: data.tankHeatMax, step: 1 }
      : FALLBACK_TANK_RANGE;

    // These options only move on a direction or layout change: rewriting them
    // on every poll would make the card flicker for nothing.
    const signature = JSON.stringify({ cooling, zoneLabel, zoneRange, tankRange, layout });
    if (signature === this._rangesSignature) return;

    const jobs = [];
    if (this.hasCapability(layout.zoneSetpointCap)) {
      jobs.push(this.setCapabilityOptions(layout.zoneSetpointCap,
        Object.assign({ title: zoneLabel, units: zoneUnits }, zoneRange)));
    }
    if (layout.tankSetpointCap && this.hasCapability(layout.tankSetpointCap)) {
      jobs.push(this.setCapabilityOptions(layout.tankSetpointCap, Object.assign({
        title: { en: 'Tank setpoint', fr: 'Consigne ballon' },
        units: { en: '°C', fr: '°C' },
      }, tankRange)));
    }
    // Without a tank, `measure_temperature` carries the zone: the label
    // inherited from the manifest ("Tank temperature") must be corrected.
    if (!layout.hasTank && layout.zoneTempCap === 'measure_temperature') {
      jobs.push(this.setCapabilityOptions('measure_temperature', {
        title: { en: 'Room temperature', fr: 'Temperature ambiante' },
      }));
    }
    if (this.hasCapability('meter_power.heat')) {
      jobs.push(this.setCapabilityOptions('meter_power.heat', {
        title: { en: 'Heat energy today', fr: "Energie chauffage aujourd'hui" },
      }));
    }
    if (this.hasCapability('meter_power.cool')) {
      jobs.push(this.setCapabilityOptions('meter_power.cool', {
        title: { en: 'Cool energy today', fr: "Energie climatisation aujourd'hui" },
      }));
    }
    if (this.hasCapability('meter_power.tank')) {
      jobs.push(this.setCapabilityOptions('meter_power.tank', {
        title: { en: 'Tank energy today', fr: "Energie ballon aujourd'hui" },
      }));
    }
    if (this.hasCapability('measure_cost.heat')) {
      jobs.push(this.setCapabilityOptions('measure_cost.heat', {
        icon: '/assets/capabilities/cost.svg',
        title: { en: 'Heat cost today', fr: "Cout chauffage aujourd'hui" },
      }));
    }
    if (this.hasCapability('measure_cost.cool')) {
      jobs.push(this.setCapabilityOptions('measure_cost.cool', {
        icon: '/assets/capabilities/cost.svg',
        title: { en: 'Cool cost today', fr: "Cout climatisation aujourd'hui" },
      }));
    }
    if (this.hasCapability('measure_cost.tank')) {
      jobs.push(this.setCapabilityOptions('measure_cost.tank', {
        icon: '/assets/capabilities/cost.svg',
        title: { en: 'Tank cost today', fr: "Cout ballon aujourd'hui" },
      }));
    }

    if (!jobs.length) return;
    try {
      await Promise.all(jobs);
      this._rangesSignature = signature;
    } catch (err) {
      this.error('applyRanges failed:', err.message);
    }
  }

  /**
   * Copies the installation's fixed configuration into the read-only settings.
   * Only writes when something changed, so that storage is not hit on every
   * poll.
   */
  async _updateInfoSettings(data) {
    const t = key => this.homey.__(`info.${key}`);
    const cfg = data.config || {};
    const yesNo = v => (v ? t('yes') : t('no'));

    const zoneNames = (data.zones || []).map(z => z.zoneName).filter(Boolean).join(', ');
    const setpointKind = data.zoneIsCurveOffset ? t('setpoint_offset') : t('setpoint_absolute');
    const unit = data.zoneIsCurveOffset ? 'K' : '°C';
    const range = data.zoneHeatMin != null && data.zoneHeatMax != null
      ? ` (${data.zoneHeatMin} … ${data.zoneHeatMax} ${unit})` : '';
    const sensor = data.zoneSensorKind ? t(`sensor_${data.zoneSensorKind}`) : t('unknown');

    const ecoComfort = [
      `${t('eco_heat')} ${this._fmt(data.zoneEcoHeat)}`,
      `${t('eco_cool')} ${this._fmt(data.zoneEcoCool)}`,
      `${t('comfort_heat')} ${this._fmt(data.zoneComfortHeat)}`,
      `${t('comfort_cool')} ${this._fmt(data.zoneComfortCool)}`,
    ].join(' · ');

    const settings = {
      info_service_type: cfg.serviceType || t('unknown'),
      info_model_series: cfg.modelSeriesSelection != null ? String(cfg.modelSeriesSelection) : t('unknown'),
      info_zones: zoneNames ? `${cfg.zoneCount} — ${zoneNames}` : String(cfg.zoneCount || 0),
      info_zone_control: setpointKind + range,
      info_zone_sensor: sensor,
      // Undocumented meaning: display the raw value.
      info_cool_mode: cfg.coolMode != null ? String(cfg.coolMode) : t('unknown'),
      info_tank: data.hasTank ? t('present') : t('absent'),
      info_bivalent: yesNo(cfg.bivalent),
      info_external_heater: yesNo(cfg.externalHeater),
      info_control_box: yesNo(cfg.controlBox),
      info_eco_comfort: ecoComfort,
      info_last_update: new Date().toLocaleString('en-GB', { timeZone: this.homey.clock.getTimezone() }),
    };

    // `info_last_update` changes on every poll: exclude it from the comparison
    // so that we only rewrite when real data moved.
    const signature = JSON.stringify(Object.assign({}, settings, { info_last_update: null }));
    if (signature === this._infoSignature) return;
    this._infoSignature = signature;

    try {
      await this.setSettings(settings);
    } catch (err) {
      this.error('updateInfoSettings failed:', err.message);
    }
  }

  _fmt(v) {
    if (v === null || typeof v === 'undefined') return '—';
    return `${v > 0 ? '+' : ''}${v}`;
  }

  // =========================================================================
  //  Command listeners
  // =========================================================================

  /**
   * Courtesy refresh after a command, debounced: several orders in quick
   * succession trigger only one call to the cloud.
   */
  _refreshSoon() {
    this._cancelRefresh();
    this._refreshTimer = this.homey.setTimeout(() => {
      this._refreshTimer = null;
      this._poll().catch(() => {});
    }, POST_COMMAND_REFRESH_MS);
  }

  /**
   * Writes the zone setpoint to the field matching the current direction.
   *
   * heatSet and coolSet are two distinct settings on the Aquarea side: writing
   * heatSet while the heat pump is cooling would change nothing visible, and
   * would silently modify next season's setpoint.
   */
  async _writeZoneSetpoint(value, zoneId) {
    if (this._cooling) return this.client.setZoneCoolTemperature(this.deviceId, value, zoneId);
    return this.client.setZoneTemperature(this.deviceId, value, zoneId);
  }

  /**
   * `target_temperature` carries the DHW tank when there is one, and otherwise
   * the zone water setpoint (never a heating curve offset: that one lives on
   * `target_temperature.zone`). See _computeLayout().
   */
  async _onSetTargetTemperature(value) {
    const rounded = Math.round(Number(value));
    if (this._layout.tankSetpointCap === 'target_temperature') {
      this.log(`Command: tank setpoint -> ${rounded}`);
      await this.client.setTankTemperature(this.deviceId, rounded);
    } else {
      this.log(`Command: zone ${this._cooling ? 'cool' : 'heat'} setpoint -> ${rounded} (zone ${this.zoneId})`);
      await this._writeZoneSetpoint(rounded, this.zoneId);
    }
    await this._commit('target_temperature', rounded);
    this._refreshSoon();
  }

  async _onSetZoneTemperature(value) {
    const rounded = Math.round(Number(value));
    this.log(`Command: zone ${this._cooling ? 'cool' : 'heat'} setpoint/offset -> ${rounded} (zone ${this.zoneId})`);
    await this._writeZoneSetpoint(rounded, this.zoneId);
    await this._commit('target_temperature.zone', rounded);
    this._refreshSoon();
  }

  async _onCapabilityThermostatMode(value) {
    this.log(`Command: thermostat_mode -> ${value}`);
    await this.client.setMode(this.deviceId, value);
    await this._commit('thermostat_mode', value);

    // The heat/cool switch is a view of the mode: it must follow, and so must
    // the direction that decides which zone setpoint is shown and driven.
    const cooling = this._coolingFromMode(value);
    if (cooling !== null) {
      await this._applyDirection({ isCooling: cooling });
      await this._commit('cooling_mode', cooling);
    }

    // setMode() also drives the zone and the DHW permission: align the
    // switches with what was just sent (see AquareaClient.setMode).
    if (value !== 'off') {
      await this._commit('onoff.zone', value !== 'dhw');
      if (value === 'heat_tank' || value === 'cool_tank' || value === 'dhw') await this._commit('onoff.tank', true);
      else if (value === 'heat' || value === 'cool') await this._commit('onoff.tank', false);
    }
    this._refreshSoon();
  }

  async _onSetTankOnoff(value) {
    this.log(`Command: tank on/off -> ${value}`);
    const on = Boolean(value);

    // In heating or cooling, the DHW permission is what separates the plain
    // mode from the mode + DHW. We prefer calling setMode because it guarantees
    // consistency on the Panasonic cloud side (some models ignore a lone
    // tankStatus command when it contradicts the mode).
    const mode = this.getCapabilityValue('thermostat_mode');
    if (mode === 'heat' || mode === 'heat_tank') {
      const newMode = on ? 'heat_tank' : 'heat';
      await this.client.setMode(this.deviceId, newMode);
      await this._commit('thermostat_mode', newMode);
    } else if (mode === 'cool' || mode === 'cool_tank') {
      const newMode = on ? 'cool_tank' : 'cool';
      await this.client.setMode(this.deviceId, newMode);
      await this._commit('thermostat_mode', newMode);
    } else if (mode === 'dhw' && !on) {
      await this.client.setMode(this.deviceId, 'off');
      await this._commit('thermostat_mode', 'off');
      await this._commit('onoff.zone', false);
    } else {
      await this.client.setTankOperation(this.deviceId, on);
    }

    await this._commit('onoff.tank', on);
    this._refreshSoon();
  }

  async _onSetZoneOnoff(value) {
    this.log(`Command: zone on/off -> ${value} (zone ${this.zoneId})`);
    const on = Boolean(value);

    // When the zone is switched off while in heating/cooling mode, we go to
    // the global 'off' mode if the tank is off or absent too. But Panasonic
    // often allows switching off just the zone. For safety and consistency with
    // the rest, we use setZoneOperation but make sure thermostat_mode reflects
    // the shutdown when it is a global one.
    await this.client.setZoneOperation(this.deviceId, on, this.zoneId);
    await this._commit('onoff.zone', on);

    if (!on) {
      const tankOn = this.getCapabilityValue('onoff.tank');
      if (!tankOn) {
        // If everything is off, make sure the mode is 'off'
        await this._commit('thermostat_mode', 'off');
      }
    } else {
      // If the zone is switched back on, make sure the mode is not 'off'
      const mode = this.getCapabilityValue('thermostat_mode');
      if (mode === 'off') {
        await this._commit('thermostat_mode', 'heat'); // Default
      }
    }

    this._refreshSoon();
  }

  /**
   * Heat/cool switch derived from the operating mode.
   *
   * `off` and `auto` are neither one nor the other: we return null, which
   * leaves the switch in its last position instead of forcing it to "heating"
   * (which would suggest the heat pump is about to heat).
   */
  _coolingFromMode(mode) {
    if (mode === 'cool' || mode === 'cool_tank') return true;
    if (mode === 'heat' || mode === 'heat_tank') return false;
    return null;
  }

  /**
   * Switches heating <-> cooling while keeping the current DHW permission:
   * `heat_tank` becomes `cool_tank`, `heat` becomes `cool`.
   *
   * ⚠️  setMode() powers the unit back on (operationStatus = 1): flipping the
   *     switch while the heat pump is off restarts it.
   */
  async _onSetCoolingMode(value) {
    const cooling = Boolean(value);
    // We rely on the tank state rather than the current mode: in 'auto' or
    // 'off', the mode says nothing about the DHW permission.
    const tankOn = this._layout.hasTank && this.getCapabilityValue('onoff.tank') === true;
    const mode = cooling
      ? (tankOn ? 'cool_tank' : 'cool')
      : (tankOn ? 'heat_tank' : 'heat');

    this.log(`Command: cooling_mode -> ${cooling} (mode ${mode})`);
    await this.client.setMode(this.deviceId, mode);

    // The direction changes right away: without this, a setpoint set just
    // after the switch would still go to the old direction's field.
    await this._applyDirection({ isCooling: cooling });

    await this._commit('cooling_mode', cooling);
    await this._commit('thermostat_mode', mode);
    await this._commit('onoff.zone', true);
    this._refreshSoon();
  }

  async _onSetQuietMode(value) {
    this.log(`Command: quiet mode -> ${value}`);
    await this.client.setQuietMode(this.deviceId, value);
    await this._commit('quiet_mode', value);
    this._refreshSoon();
  }

  async _onSetPowerfulMode(value) {
    this.log(`Command: powerful mode -> ${value}`);
    await this.client.setPowerfulMode(this.deviceId, value);
    await this._commit('powerful_mode', value);
    this._refreshSoon();
  }

  async _onSetHolidayMode(value) {
    const on = Boolean(value);
    this.log(`Command: holiday mode -> ${on}`);
    await this.client.setHolidayMode(this.deviceId, on);
    await this._commit('holiday_mode', on);
    this._refreshSoon();
  }

  // =========================================================================
  //  Commands exposed to the Flow cards
  //
  //  The capabilities only cover the main zone and do not expose the "pulse"
  //  commands (forced DHW, backup heater, defrost). These methods are the entry
  //  point of the Flow cards, see app.js. They follow the same discipline as
  //  the capability listeners: command -> _commit -> deferred refresh.
  // =========================================================================

  /**
   * Resolves the "zone" argument of a Flow card.
   * `main` (or absent) = the main zone tracked by the capabilities.
   */
  _resolveZoneId(zone) {
    if (zone === undefined || zone === null || zone === '' || zone === 'main') return this.zoneId;
    const n = Number(zone);
    if (!Number.isFinite(n)) return this.zoneId;
    if (this._zoneIds && this._zoneIds.length && !this._zoneIds.includes(n)) {
      throw new Error(this.homey.__('error.unknown_zone', { zone: n }));
    }
    return n;
  }

  /** A command on a secondary zone must not overwrite the tiles. */
  async _commitIfMainZone(cap, value, zoneId) {
    if (zoneId !== this.zoneId) return;
    await this._commit(cap, value);
  }

  async flowSetOperationMode(mode) {
    return this._onCapabilityThermostatMode(mode);
  }

  /** Heat/cool switch, without having to pick the "+ hot water" variant. */
  async flowSetCoolingMode(cooling) {
    if (!this._layout.hasCooling) throw new Error(this.homey.__('error.no_cooling'));
    return this._onSetCoolingMode(cooling);
  }

  /** General power on/off, without resetting the mode or the DHW permission. */
  async flowSetPower(on) {
    this.log(`Flow: power -> ${on}`);
    await this.client.setOperationStatus(this.deviceId, on);
    if (!on) await this._commit('thermostat_mode', 'off');
    this._refreshSoon();
  }

  async flowSetZoneSetpoint(value, zone) {
    const zoneId = this._resolveZoneId(zone);
    const v = Math.round(Number(value));
    if (!Number.isFinite(v)) throw new Error('Invalid setpoint');
    this.log(`Flow: zone ${zoneId} ${this._cooling ? 'cool' : 'heat'} setpoint -> ${v}`);
    await this._writeZoneSetpoint(v, zoneId);
    await this._commitIfMainZone(this._layout.zoneSetpointCap, v, zoneId);
    this._refreshSoon();
  }

  /**
   * Relative adjustment of the zone setpoint (+1 K, -2 K, ...).
   * Useful for load-shedding / tariff-based curtailment Flows.
   */
  async flowAdjustZoneSetpoint(delta, zone) {
    const zoneId = this._resolveZoneId(zone);
    const cap = this._layout.zoneSetpointCap;
    const current = this.getCapabilityValue(cap);
    if (current === null || typeof current === 'undefined') {
      throw new Error(this.homey.__('error.no_current_setpoint'));
    }
    if (zoneId !== this.zoneId) {
      // With no capability for secondary zones, there is no reliable reference
      // value: better to refuse than to apply a wrong offset.
      throw new Error(this.homey.__('error.relative_main_zone_only'));
    }

    // The real bounds come from _applyRanges(); stick to them so we do not send
    // a setpoint the heat pump would silently refuse.
    let opts = {};
    try { opts = this.getCapabilityOptions(cap) || {}; } catch (err) { /* manifest bounds */ }

    let target = Math.round(Number(current) + Number(delta));
    if (typeof opts.min === 'number') target = Math.max(opts.min, target);
    if (typeof opts.max === 'number') target = Math.min(opts.max, target);

    this.log(`Flow: zone ${zoneId} setpoint ${current} ${delta >= 0 ? '+' : ''}${delta} -> ${target}`);
    await this._writeZoneSetpoint(target, zoneId);
    await this._commit(cap, target);
    this._refreshSoon();
  }

  async flowSetZoneCoolSetpoint(value, zone) {
    const zoneId = this._resolveZoneId(zone);
    const v = Math.round(Number(value));
    if (!Number.isFinite(v)) throw new Error('Invalid setpoint');
    this.log(`Flow: zone ${zoneId} cool setpoint -> ${v}`);
    await this.client.setZoneCoolTemperature(this.deviceId, v, zoneId);
    // The setpoint tile carries coolSet only while the heat pump is cooling;
    // otherwise this card presets the cooling season without displaying it.
    if (this._cooling) await this._commitIfMainZone(this._layout.zoneSetpointCap, v, zoneId);
    this._refreshSoon();
  }

  async flowSetZoneOnoff(on, zone) {
    const zoneId = this._resolveZoneId(zone);
    if (zoneId === this.zoneId) return this._onSetZoneOnoff(on);
    this.log(`Flow: zone ${zoneId} on/off -> ${on}`);
    await this.client.setZoneOperation(this.deviceId, on, zoneId);
    this._refreshSoon();
  }

  async flowSetTankSetpoint(value) {
    if (!this._layout.hasTank) throw new Error(this.homey.__('error.no_tank'));
    const v = Math.round(Number(value));
    if (!Number.isFinite(v)) throw new Error('Invalid setpoint');
    this.log(`Flow: tank setpoint -> ${v}`);
    await this.client.setTankTemperature(this.deviceId, v);
    await this._commit(this._layout.tankSetpointCap, v);
    this._refreshSoon();
  }

  async flowSetTankOnoff(on) {
    if (!this._layout.hasTank) throw new Error(this.homey.__('error.no_tank'));
    return this._onSetTankOnoff(on);
  }

  async flowSetForceDhw(on) {
    if (!this._layout.hasTank) throw new Error(this.homey.__('error.no_tank'));
    this.log(`Flow: force DHW -> ${on}`);
    await this.client.setForceDhw(this.deviceId, on);
    await this._commit('force_dhw', Boolean(on));
    this._refreshSoon();
  }

  async flowSetForceHeater(on) {
    this.log(`Flow: force backup heater -> ${on}`);
    await this.client.setForceHeater(this.deviceId, on);
    await this._commit('force_heater', Boolean(on));
    this._refreshSoon();
  }

  async flowRequestDefrost() {
    this.log('Flow: manual defrost requested');
    await this.client.requestDefrost(this.deviceId);
    this._refreshSoon();
  }

  async flowSetSpecialStatus(status) {
    this.log(`Flow: special status -> ${status}`);
    await this.client.setSpecialStatus(this.deviceId, status);
    await this._commit('special_status', status);
    this._refreshSoon();
  }

  async flowSetQuietMode(mode) {
    return this._onSetQuietMode(mode);
  }

  async flowSetPowerfulMode(mode) {
    return this._onSetPowerfulMode(mode);
  }

  async flowSetHolidayMode(on) {
    return this._onSetHolidayMode(on);
  }

  // =========================================================================
  //  Lifecycle
  // =========================================================================

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      this.log('Poll interval changed, restarting poller');
      this._startPolling();
    }
  }

  async onDeleted() {
    this.log(`Aquarea device deleted: ${this.deviceId}`);
    this._stopPolling();
    this._cancelRefresh();
  }

  async onUninit() {
    this._stopPolling();
    this._cancelRefresh();
  }

}

module.exports = AquareaDevice;
