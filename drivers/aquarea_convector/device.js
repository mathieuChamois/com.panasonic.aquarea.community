'use strict';

const Homey = require('homey');
const AquareaHomeClient = require('../../lib/AquareaHomeClient');

// Default polling interval: 60 seconds.
const DEFAULT_POLL_INTERVAL = 60;
const MIN_POLL_INTERVAL     = 30;
const TRANSIENT_FAILURES_BEFORE_UNAVAILABLE = 3;

// Mapping operationMode int -> thermostat_mode string
const MODE_INT_TO_STR = { 0: 'auto', 1: 'heat', 2: 'cool' };
const MODE_STR_TO_INT = { auto: 0, heat: 1, cool: 2 };

const FAN_INT_TO_STR = { 0: 'auto', 1: 'night', 2: 'max' };

/**
 * Homey device for an Aquarea Home convector / fan coil.
 *
 * Capabilities:
 *   - onoff                  (power on / off)
 *   - target_temperature     (temperature setpoint, 5-40 °C)
 *   - measure_temperature    (measured room temperature)
 *   - thermostat_mode        (auto / heat / cool)
 *   - convector_fan_speed    (auto / night / max)
 *   - convector_flap         (flap open/closed)
 */
class AquareaConvectorDevice extends Homey.Device {

  async onInit() {
    this.log('AquareaConvectorDevice init:', this.getName());

    this._client = null;
    this._pollTimer = null;
    this._transientPollFailures = 0;

    // Removes the old experimental alarm capabilities from already installed
    // devices, without recreating the device or affecting its Flows.
    for (const capability of ['alarm_generic', 'convector_alarm_codes']) {
      if (this.hasCapability(capability)) {
        try {
          await this.removeCapability(capability);
        } catch (err) {
          // A custom capability removed from the manifest may still be present
          // on an older device. Homey then answers 404 to its removal; that
          // must not prevent the device from starting.
          this.error(`Unable to remove legacy capability ${capability}: ${err.message}`);
        }
      }
    }

    await this._initClient();
    this._registerCapabilityListeners();
    await this._poll();
    this._startPolling();
  }

  // ─── Client ────────────────────────────────────────────────────────────────

  async _initClient() {
    const store = this.getStore();
    this._client = new AquareaHomeClient({
      email:    store.email,
      password: store.password,
      log:      (...a) => this.log(...a),
      error:    (...a) => this.error(...a),
    });

    if (store.session) {
      this._client.importSession(store.session);
    } else {
      await this._client.login();
    }
  }

  _getMacAddress() {
    return this.getStore().macAddress || this.getData().id;
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  _startPolling() {
    this._stopPolling();
    const interval = Math.max(
      MIN_POLL_INTERVAL,
      (this.getSetting('poll_interval') || DEFAULT_POLL_INTERVAL)
    ) * 1000;

    this._pollTimer = this.homey.setInterval(() => this._poll(), interval);
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _poll() {
    try {
      const mac    = this._getMacAddress();
      const status = await this._client.getDeviceStatus(mac);

      if (!status || Object.keys(status).length === 0) return;

      this._transientPollFailures = 0;

      // onoff
      if (status.powerState !== undefined) {
        await this.setCapabilityValue('onoff', !!status.powerState).catch(() => {});
      }

      // measure_temperature (room temperature)
      if (status.roomTemperature !== null && status.roomTemperature !== undefined) {
        await this.setCapabilityValue('measure_temperature', status.roomTemperature).catch(() => {});
      }

      // target_temperature (setpoint) - refresh the dynamic bounds if available
      if (status.setpointMin !== null && status.setpointMin !== undefined &&
          status.setpointMax !== null && status.setpointMax !== undefined) {
        const opts = { min: status.setpointMin, max: status.setpointMax };
        if (status.setpointStep !== null && status.setpointStep !== undefined) {
          opts.step = status.setpointStep;
        }
        await this.setCapabilityOptions('target_temperature', opts).catch(() => {});
      }
      if (status.setpoint !== null && status.setpoint !== undefined) {
        await this.setCapabilityValue('target_temperature', status.setpoint).catch(() => {});
      }

      // thermostat_mode
      if (status.operationMode !== null && status.operationMode !== undefined) {
        const modeStr = MODE_INT_TO_STR[status.operationMode] || 'auto';
        await this.setCapabilityValue('thermostat_mode', modeStr).catch(() => {});
      }

      // convector_fan_speed
      if (status.fanSpeed !== null && status.fanSpeed !== undefined) {
        const speedStr = FAN_INT_TO_STR[status.fanSpeed] || 'auto';
        await this.setCapabilityValue('convector_fan_speed', speedStr).catch(() => {});
      }

      // convector_flap
      if (status.flap !== null && status.flap !== undefined) {
        await this.setCapabilityValue('convector_flap', !!status.flap).catch(() => {});
      }

      this.setAvailable();
    } catch (err) {
      this.error('Poll error:', err.message);
      if (this._client.isTransientNetworkError(err)) {
        this._transientPollFailures += 1;
        this.log(`Temporary network failure ${this._transientPollFailures}/${TRANSIENT_FAILURES_BEFORE_UNAVAILABLE}; keeping device available`);
        if (this._transientPollFailures < TRANSIENT_FAILURES_BEFORE_UNAVAILABLE) return;
      } else {
        this._transientPollFailures = 0;
      }
      this.setUnavailable(err.message).catch(() => {});
    }
  }

  // ─── Capability listeners ──────────────────────────────────────────────────

  _registerCapabilityListeners() {
    const mac = this._getMacAddress();

    this.registerCapabilityListener('onoff', async value => {
      await this._client.setPower(mac, value);
    });

    this.registerCapabilityListener('target_temperature', async value => {
      await this._client.setTemperature(mac, value);
    });

    this.registerCapabilityListener('thermostat_mode', async value => {
      await this._client.setOperationMode(mac, value);
    });

    this.registerCapabilityListener('convector_fan_speed', async value => {
      await this._client.setFanSpeed(mac, value);
    });

    this.registerCapabilityListener('convector_flap', async value => {
      await this._client.setFlap(mac, value);
    });
  }

  // ─── Settings ──────────────────────────────────────────────────────────────

  async onSettings({ newSettings }) {
    this._startPolling();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onDeleted() {
    this._stopPolling();
    this.log('AquareaConvectorDevice deleted:', this.getName());
  }

}

module.exports = AquareaConvectorDevice;
