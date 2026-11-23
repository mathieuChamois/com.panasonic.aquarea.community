'use strict';

const Homey = require('homey');
const AquareaHomeClient = require('../../lib/AquareaHomeClient');

/**
 * Driver pour les convecteurs / fan coils Aquarea Home (Solution Tech Srl).
 *
 * Le pairing utilise le template Homey `login_credentials` : l'utilisateur
 * saisit son e-mail / mot de passe Aquarea Home, on teste les identifiants
 * via AquareaHomeClient, puis on liste les appareils disponibles.
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
        throw new Error(this.homey.__('error.pair_credentials_required'));
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
        throw new Error(this.homey.__('error.pair_session_invalid'));
      }

      const devices = await client.getDevices();

      if (!devices.length) {
        throw new Error(this.homey.__('error.pair_no_convector'));
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
