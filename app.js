'use strict';

const Homey = require('homey');

/**
 * Panasonic Aquarea (Community) - point d'entree de l'application Homey.
 *
 * ⚠️  Application NON OFFICIELLE, sans lien avec Panasonic Corporation.
 *     Elle s'appuie sur une API privee (Aquarea Smart Cloud) obtenue par
 *     retro-ingenierie et peut cesser de fonctionner a tout moment.
 */
class AquareaApp extends Homey.App {

  async onInit() {
    this.log('====================================================');
    this.log(' Panasonic Aquarea (Community) - starting');
    this.log(' UNOFFICIAL app. Not affiliated with Panasonic Corp.');
    this.log(' Uses a private, undocumented cloud API. Use at your own risk.');
    this.log(' Please respect the polling interval to avoid rate-limiting.');
    this.log('====================================================');

    // Journalisation globale des rejets non captures, pour faciliter le debug.
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
   * Cartes de declenchement generiques.
   *
   * Plutot qu'une carte par etat (degivrage, circulateur, appoint...), on
   * expose quatre cartes qui prennent la capability en argument : la liste des
   * etats remontes par Aquarea est longue et evolue, et le selecteur Homey
   * reste lisible. Le filtrage se fait au declenchement via l'etat `state`.
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
   * Declenche les cartes concernees par un changement de valeur.
   * Appele par le device a chaque ecriture de capability effective.
   *
   * @param {Homey.Device} device
   * @param {string} capability
   * @param {*} value      Nouvelle valeur.
   * @param {*} previous   Valeur precedente (jamais null : cf. appelant).
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
        // Capability jamais alimentee (sonde absente, poll pas encore passe) :
        // comparer null renverrait "0 < seuil" et declencherait a tort.
        if (current === null || typeof current === 'undefined') return false;
        const compare = COMPARE[operator];
        if (!compare) throw new Error(`Unknown operator "${operator}"`);
        return compare(Number(current), Number(value));
      });
  }

  _registerActions() {
    const on = state => state === 'on';

    const actions = {
      // --- Marche / arret et mode ---
      set_operation_mode: ({ device, mode }) => device.flowSetOperationMode(mode),
      set_power: ({ device, state }) => device.flowSetPower(on(state)),
      set_cooling_mode: ({ device, mode }) => device.flowSetCoolingMode(mode === 'cool'),

      // --- Zone de chauffage ---
      set_zone_setpoint: ({ device, value, zone }) => device.flowSetZoneSetpoint(value, zone),
      adjust_zone_setpoint: ({ device, delta, zone }) => device.flowAdjustZoneSetpoint(delta, zone),
      set_zone_cool_setpoint: ({ device, value, zone }) => device.flowSetZoneCoolSetpoint(value, zone),
      set_zone_onoff: ({ device, state, zone }) => device.flowSetZoneOnoff(on(state), zone),

      // --- Ballon d'eau chaude sanitaire ---
      set_tank_setpoint: ({ device, value }) => device.flowSetTankSetpoint(value),
      set_tank_onoff: ({ device, state }) => device.flowSetTankOnoff(on(state)),
      set_force_dhw: ({ device, state }) => device.flowSetForceDhw(on(state)),

      // --- Confort / appoints ---
      set_quiet_mode: ({ device, mode }) => device.flowSetQuietMode(mode),
      set_powerful_mode: ({ device, mode }) => device.flowSetPowerfulMode(mode),
      set_holiday_mode: ({ device, state }) => device.flowSetHolidayMode(on(state)),
      set_special_status: ({ device, status }) => device.flowSetSpecialStatus(status),
      set_force_heater: ({ device, state }) => device.flowSetForceHeater(on(state)),
      request_defrost: ({ device }) => device.flowRequestDefrost(),

      // --- Convecteur (pilote par capability, pas d'API dediee) ---
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
