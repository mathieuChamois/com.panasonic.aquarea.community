'use strict';

const Homey = require('homey');
const AquareaClient = require('../../lib/AquareaClient');

/**
 * Aquarea heat pump driver.
 *
 * Pairing uses the Homey `login_credentials` template: the user enters their
 * Aquarea Smart Cloud e-mail / password, the credentials are checked through
 * AquareaClient, then the devices linked to the account are listed.
 *
 * ⚠️  Recommended: use a DEDICATED ACCOUNT shared from the main account, to
 *     avoid session conflicts (Aquarea Smart Cloud only allows a single
 *     active session per account).
 */
class AquareaDriver extends Homey.Driver {

  async onInit() {
    this.log('AquareaDriver initialized');
  }

  onPair(session) {
    // Credentials entered during this pairing session + authenticated client.
    let credentials = { username: null, password: null };
    let client = null;

    // Step 1: validate the credentials (login_credentials template).
    session.setHandler('login', async data => {
      const username = (data.username || '').trim();
      const password = data.password || '';

      if (!username || !password) {
        throw new Error('E-mail et mot de passe requis.');
      }

      client = new AquareaClient({
        username,
        password,
        log: (...a) => this.log('[pair]', ...a),
        error: (...a) => this.error('[pair]', ...a),
      });

      // Actually test the credentials.
      try {
        await client.login();
      } catch (err) {
        this.error('Pairing login failed:', err.message);
        client = null;
        // Returning false => Homey shows "invalid credentials".
        return false;
      }

      credentials = { username, password };
      return true;
    });

    // Step 2: list the devices available to add.
    session.setHandler('list_devices', async () => {
      if (!credentials.username || !client) {
        throw new Error('Session de pairing invalide : reconnectez-vous.');
      }

      const devices = await client.getDevices();

      if (!devices.length) {
        throw new Error('Aucun appareil Comfort Cloud trouve sur ce compte.');
      }

      // Session (tokens + clientId + cookies) reusable by the device, to avoid
      // a full re-authentication on first start.
      const savedSession = client.exportSession();

      return devices.map(d => ({
        name: d.name,
        // Value shown by default on the device tile. The user can then pick
        // another capability in the Homey settings.
        uiIndicator: 'measure_temperature',
        data: {
          id: d.id,
        },
        store: {
          // The e-mail/password pair stays required for this API (OAuth
          // re-authentication). Homey encrypts the store at rest.
          username: credentials.username,
          password: credentials.password,
          session: savedSession,
          deviceType: d.deviceType,
        },
        settings: {
          poll_interval: 300,
        },
      }));
    });
  }

}

module.exports = AquareaDriver;
