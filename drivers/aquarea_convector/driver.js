'use strict';

const Homey = require('homey');
const AquareaHomeClient = require('../../lib/AquareaHomeClient');

/**
 * Driver for Aquarea Home convectors / fan coils (Solution Tech Srl).
 *
 * Pairing uses the Homey `login_credentials` template: the user enters their
 * Aquarea Home e-mail / password, the credentials are checked through
 * AquareaHomeClient, then the available devices are listed.
 */
class AquareaConvectorDriver extends Homey.Driver {

  async onInit() {
    this.log('AquareaConvectorDriver initialized');
  }

  onPair(session) {
    let client = null;
    session.setHandler('login', async data => {
      const email    = (data.username || '').trim();
      const password = data.password || '';

      if (!email || !password) {
        throw new Error('E-mail et mot de passe requis.');
      }

      client = new AquareaHomeClient({
        email,
        password,
        log:   (...a) => this.log('[pair]', ...a),
        error: (...a) => this.error('[pair]', ...a),
      });

      try {
        await client.login();
      } catch (err) {
        this.error('Pairing login failed:', err.message);
        client = null;
        return false;
      }

      return true;
    });
    session.setHandler('list_devices', async () => {
      if (!client) {
        throw new Error('Session de pairing invalide : reconnectez-vous.');
      }

      const devices = await client.getDevices();

      if (!devices.length) {
        throw new Error('Aucun convecteur Aquarea Home trouvé sur ce compte.');
      }

      const savedSession = client.exportSession();

      return devices.map(d => ({
        name: d.name,
        data: {
          id: d.macAddress,
        },
        store: {
          macAddress: d.macAddress,
          session:    savedSession,
        },
        settings: {
          poll_interval: 60,
        },
      }));
    });
  }

}

module.exports = AquareaConvectorDriver;
