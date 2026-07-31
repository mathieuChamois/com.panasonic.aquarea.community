'use strict';

/**
 * Script de diagnostic : se connecte a Aquarea Smart Cloud et affiche le JSON
 * BRUT renvoye par l'API (liste des appareils + etat detaille de chaque PAC).
 *
 * But : voir exactement ce que Panasonic expose (ballon ECS / tankStatus,
 * unite exterieure / outdoorNow, zones, etc.) pour decider quoi remonter
 * dans Homey.
 *
 * Utilisation :
 *   AQUAREA_USER="mon.email@exemple.fr" AQUAREA_PASS="motdepasse" \
 *     node scripts/dump.js
 *
 * ou en passant les identifiants en arguments :
 *   node scripts/dump.js "mon.email@exemple.fr" "motdepasse"
 *
 * ⚠️  Utilise de preference le COMPTE DEDIE (cf. README §2). Chaque connexion
 *     peut invalider la session de l'app mobile.
 */

const AquareaClient = require('../lib/AquareaClient');

const username = process.env.AQUAREA_USER || process.argv[2];
const password = process.env.AQUAREA_PASS || process.argv[3];

if (!username || !password) {
  console.error('Usage: AQUAREA_USER=... AQUAREA_PASS=... node scripts/dump.js');
  console.error('   ou: node scripts/dump.js "email" "motdepasse"');
  process.exit(1);
}

function show(title, obj) {
  console.log('\n' + '='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
  console.log(JSON.stringify(obj, null, 2));
}

(async () => {
  const client = new AquareaClient({
    username,
    password,
    log: (...a) => console.log('[client]', ...a),
    error: (...a) => console.error('[client]', ...a),
  });

  try {
    console.log('Connexion en cours...');
    await client.login();
    console.log('Connexion OK. clientId =', client.clientId);

    // 1) Liste brute des appareils (device/group).
    const devices = await client.getDevices();
    show('APPAREILS (getDevices, vue simplifiee)', devices.map(d => ({
      id: d.id, name: d.name, hasTank: d.hasTank,
    })));
    show('APPAREILS (raw device/group)', devices.map(d => d.raw));

    // 2) Etat detaille brut de chaque appareil.
    for (const d of devices) {
      // getDeviceData renvoie un objet mappe + le champ .raw = reponse complete.
      const data = await client.getDeviceData(d.id);
      // Tout ce que l'app remonte dans Homey, sauf la reponse brute.
      const { raw, ...mapped } = data;
      show(`ETAT MAPPE — ${d.name} (${d.id})`, mapped);
      show(`ETAT BRUT (reponse API complete) — ${d.name}`, data.raw);
    }

    console.log('\nTermine.');
  } catch (err) {
    console.error('\nERREUR:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
})();
