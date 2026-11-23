'use strict';

const Homey = require('homey');
const AquareaClient = require('../../lib/AquareaClient');

/**
 * Driver de la PAC Aquarea.
 *
 * Le pairing utilise le template Homey `login_credentials` : l'utilisateur
 * saisit son e-mail / mot de passe Aquarea Smart Cloud, on teste les
 * identifiants via AquareaClient, puis on liste les equipements rattaches.
 *
 * ⚠️  Recommandation : utiliser un COMPTE DEDIE partage depuis le compte
 *     principal, pour eviter les conflits de session (une seule session
 *     active par compte cote Aquarea Smart Cloud).
 */
class AquareaDriver extends Homey.Driver {

  async onInit() {
    this.log('AquareaDriver initialized');
  }

  onPair(session) {
    // Identifiants saisis pendant cette session de pairing + client authentifie.
    let credentials = { username: null, password: null };
    let client = null;

    // Etape 1 : validation des identifiants (template login_credentials).
    session.setHandler('login', async data => {
      const username = (data.username || '').trim();
      const password = data.password || '';

      if (!username || !password) {
        throw new Error(this.homey.__('error.pair_credentials_required'));
      }

      client = new AquareaClient({
        username,
        password,
        log: (...a) => this.log('[pair]', ...a),
        error: (...a) => this.error('[pair]', ...a),
      });

      // Test reel des identifiants.
      try {
        await client.login();
      } catch (err) {
        this.error('Pairing login failed:', err.message);
        client = null;
        // Retourner false => Homey affiche "identifiants invalides".
        return false;
      }

      credentials = { username, password };
      return true;
    });

    // Etape 2 : lister les equipements a ajouter.
    session.setHandler('list_devices', async () => {
      if (!credentials.username || !client) {
        throw new Error(this.homey.__('error.pair_session_invalid'));
      }

      const devices = await client.getDevices();

      if (!devices.length) {
        throw new Error(this.homey.__('error.pair_no_heatpump'));
      }

      // Session (tokens + clientId + cookies) reutilisable par le device pour
      // eviter une re-authentification complete au premier demarrage.
      const savedSession = client.exportSession();

      return devices.map(d => ({
        name: d.name,
        // Valeur affichee par defaut sur la vignette. L'utilisateur peut
        // ensuite choisir une autre capability dans les reglages de Homey.
        uiIndicator: 'measure_temperature',
        data: {
          id: d.id,
        },
        store: {
          // Le couple e-mail/mot de passe reste indispensable pour cette API
          // (re-authentification OAuth). Homey chiffre le store au repos.
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
