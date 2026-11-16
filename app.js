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
    this.homey.flow.getConditionCard('capability_is_true')
      .registerRunListener(({ device, capability }) => (
        device.hasCapability(capability) && device.getCapabilityValue(capability) === true
      ));

    this.homey.flow.getConditionCard('capability_equals')
      .registerRunListener(({ device, capability, value }) => (
        device.hasCapability(capability)
        && String(device.getCapabilityValue(capability)) === String(value).trim()
      ));

    const actions = {
      set_zone_setpoint: ({ device, value }) => (
        device.triggerCapabilityListener('target_temperature.zone', Number(value))
      ),
      set_tank_onoff: ({ device, state }) => device.triggerCapabilityListener('onoff.tank', state === 'on'),
      set_tank_setpoint: ({ device, value }) => {
        // La consigne ballon est portee par target_temperature quand un ballon est present.
        const cap = device._layout && device._layout.tankSetpointCap;
        if (!cap || !device.hasCapability(cap)) throw new Error('No DHW tank on this device');
        // On borne a la plage reelle du ballon remontee par Panasonic (cf. setCapabilityOptions).
        const { min, max } = device.getCapabilityOptions(cap) || {};
        let target = Number(value);
        if (typeof min === 'number') target = Math.max(min, target);
        if (typeof max === 'number') target = Math.min(max, target);
        return device.triggerCapabilityListener(cap, target);
      },
      set_force_dhw: ({ device, state }) => device.triggerCapabilityListener('force_dhw', state === 'on'),
      set_quiet_mode: ({ device, mode }) => device.triggerCapabilityListener('quiet_mode', mode),
      set_powerful_mode: ({ device, mode }) => device.triggerCapabilityListener('powerful_mode', mode),
      set_holiday_mode: ({ device, state }) => device.triggerCapabilityListener('holiday_mode', state === 'on'),
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
