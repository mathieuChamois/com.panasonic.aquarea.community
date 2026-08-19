'use strict';

const Homey = require('homey');

/**
 * Panasonic Aquarea (Community) - entry point of the Homey app.
 *
 * ⚠️  UNOFFICIAL app, not affiliated with Panasonic Corporation.
 *     It relies on a private API (Aquarea Smart Cloud) obtained by reverse
 *     engineering and may stop working at any time.
 */
class AquareaApp extends Homey.App {

  async onInit() {
    this.log('====================================================');
    this.log(' Panasonic Aquarea (Community) - starting');
    this.log(' UNOFFICIAL app. Not affiliated with Panasonic Corp.');
    this.log(' Uses a private, undocumented cloud API. Use at your own risk.');
    this.log(' Please respect the polling interval to avoid rate-limiting.');
    this.log('====================================================');

    // Global logging of unhandled rejections, to make debugging easier.
    process.on('unhandledRejection', reason => {
      this.error('Unhandled promise rejection:', reason);
    });

    this._registerFlowCards();
  }

  _registerFlowCards() {
    this._registerTriggers();
    this._registerConditions();
    this._registerActions();
  }

  /**
   * Generic trigger cards.
   *
   * Rather than one card per state (defrost, pump, backup heater...), we expose
   * four cards that take the capability as an argument: the list of states
   * reported by Aquarea is long and keeps changing, and the Homey picker stays
   * readable this way. Filtering happens at trigger time via the `state` arg.
   */
  _registerTriggers() {
    this._triggerCards = {};
    for (const id of ['state_became_true', 'state_became_false', 'mode_changed', 'measurement_changed']) {
      const card = this.homey.flow.getDeviceTriggerCard(id);
      card.registerRunListener((args, state) => args.capability === state.capability);
      this._triggerCards[id] = card;
    }
  }

  /**
   * Fires the cards affected by a value change.
   * Called by the device on every effective capability write.
   *
   * @param {Homey.Device} device
   * @param {string} capability
   * @param {*} value      New value.
   * @param {*} previous   Previous value (never null: see caller).
   */
  triggerCapabilityChange(device, capability, value, previous) {
    if (!this._triggerCards) return;

    let id;
    let tokens = {};
    if (typeof value === 'boolean') {
      id = value ? 'state_became_true' : 'state_became_false';
    } else if (typeof value === 'number') {
      id = 'measurement_changed';
      tokens = { value, previous: Number(previous) };
    } else {
      id = 'mode_changed';
      tokens = { value: String(value), previous: String(previous) };
    }

    const card = this._triggerCards[id];
    if (!card) return;
    card.trigger(device, tokens, { capability })
      .catch(err => this.error(`trigger ${id} (${capability}) failed:`, err.message));
  }

  _registerConditions() {
    this.homey.flow.getConditionCard('capability_is_true')
      .registerRunListener(({ device, capability }) => (
        device.hasCapability(capability) && device.getCapabilityValue(capability) === true
      ));

    this.homey.flow.getConditionCard('capability_equals')
      .registerRunListener(({ device, capability, value }) => (
        device.hasCapability(capability)
        && String(device.getCapabilityValue(capability)) === String(value).trim()
      ));

    const COMPARE = {
      gt: (a, b) => a > b,
      lt: (a, b) => a < b,
      gte: (a, b) => a >= b,
      lte: (a, b) => a <= b,
    };

    this.homey.flow.getConditionCard('measurement_compare')
      .registerRunListener(({
        device, capability, operator, value,
      }) => {
        if (!device.hasCapability(capability)) return false;
        const current = device.getCapabilityValue(capability);
        // Capability never populated (missing probe, poll has not run yet):
        // comparing null would read as "0 < threshold" and match wrongly.
        if (current === null || typeof current === 'undefined') return false;
        const compare = COMPARE[operator];
        if (!compare) throw new Error(`Unknown operator "${operator}"`);
        return compare(Number(current), Number(value));
      });
  }

  _registerActions() {
    const on = state => state === 'on';

    const actions = {
      // --- Power and mode ---
      set_operation_mode: ({ device, mode }) => device.flowSetOperationMode(mode),
      set_power: ({ device, state }) => device.flowSetPower(on(state)),
      set_cooling_mode: ({ device, mode }) => device.flowSetCoolingMode(mode === 'cool'),

      // --- Heating zone ---
      set_zone_setpoint: ({ device, value, zone }) => device.flowSetZoneSetpoint(value, zone),
      adjust_zone_setpoint: ({ device, delta, zone }) => device.flowAdjustZoneSetpoint(delta, zone),
      set_zone_cool_setpoint: ({ device, value, zone }) => device.flowSetZoneCoolSetpoint(value, zone),
      set_zone_onoff: ({ device, state, zone }) => device.flowSetZoneOnoff(on(state), zone),

      // --- Domestic hot water tank ---
      set_tank_setpoint: ({ device, value }) => device.flowSetTankSetpoint(value),
      set_tank_onoff: ({ device, state }) => device.flowSetTankOnoff(on(state)),
      set_force_dhw: ({ device, state }) => device.flowSetForceDhw(on(state)),

      // --- Comfort / backup heat ---
      set_quiet_mode: ({ device, mode }) => device.flowSetQuietMode(mode),
      set_powerful_mode: ({ device, mode }) => device.flowSetPowerfulMode(mode),
      set_holiday_mode: ({ device, state }) => device.flowSetHolidayMode(on(state)),
      set_special_status: ({ device, status }) => device.flowSetSpecialStatus(status),
      set_force_heater: ({ device, state }) => device.flowSetForceHeater(on(state)),
      request_defrost: ({ device }) => device.flowRequestDefrost(),

      // --- Convector (driven by capability, no dedicated API) ---
      set_convector_fan_speed: ({ device, speed }) => device.triggerCapabilityListener('convector_fan_speed', speed),
      set_convector_flap: ({ device, state }) => device.triggerCapabilityListener('convector_flap', state === 'open'),
    };

    for (const [id, listener] of Object.entries(actions)) {
      this.homey.flow.getActionCard(id).registerRunListener(listener);
    }
  }

  async onUninit() {
    this.log('Panasonic Aquarea (Community) - stopping');
  }

}

module.exports = AquareaApp;
