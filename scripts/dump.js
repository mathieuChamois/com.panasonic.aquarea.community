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

    // 3) Sondage des endpoints de consommation energetique (kWh).
    //    On utilise _fetch() directement avec les headers Panasonic pour eviter
    //    la boucle re-auth declenchee par _request() sur chaque 403.
    //    Un 403 "Missing Authentication Token" = chemin inexistant dans l'API
    //    Gateway ; ca ne signifie pas que le token est mauvais.
    console.log('\n--- Sondage endpoints consommation energetique ---');
    console.log('(HTTP 2xx = succes, 403/404 = chemin inexistant, rien de grave)\n');

    const BASE = 'https://accsmart.panasonic.com';

    async function probe(label, path, postBody = null) {
      const url = `${BASE}/${path.replace(/^\//, '')}`;
      try {
        const headers = client._panasonicHeaders(true);
        const method = postBody ? 'POST' : 'GET';
        if (postBody) headers['content-type'] = 'application/json';
        const res = await client._fetch(url, { method, headers, body: postBody || undefined });
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        console.log(`[HTTP ${res.status}] ${label}`);
        if (res.status >= 200 && res.status < 300) show(label, body);
        else console.log('  ->', typeof body === 'string' ? body.slice(0, 120) : JSON.stringify(body).slice(0, 120));
      } catch (err) {
        console.log(`[ERR] ${label}: ${err.message}`);
      }
    }

    // Date du jour au format YYYY-MM-DD.
    const today = new Date().toISOString().slice(0, 10);

    for (const d of devices) {
      const guid = d.id;
      console.log(`\n== Appareil : ${d.name} (${guid}) ==`);

      // Endpoint decouvert dans bisand/panasonic-comfort-cloud-api :
      //   POST /deviceHistoryData
      //   Body : { deviceGuid, dataMode (0=Day,1=Week,2=Month,4=Year), date, osTimezone }
      // On essaie les 4 modes pour voir ce que l'API renvoie pour une PAC Aquarea.
      // Date au format YYYYMMDD (sans tirets).
      const todayCompact = today.replace(/-/g, '');

      // D'apres cjaliaga/aioaquarea (consumption_manager.py) :
      //   - endpoint Aquarea : POST remote/v1/app/common/transfer
      //   - apiName : /remote/v1/api/consumption
      //   - gwid (pas deviceGuid), dataMode : 0=Day 1=Month 2=Year
      //   - date : YYYYMMDD
      // La reponse contient historyDataList avec heatConsumption/coolConsumption/tankConsumption.
      const consumptionModes = [
        { label: 'Day (0)',   dataMode: 0 },
        { label: 'Month (1)', dataMode: 1 },
        { label: 'Year (2)',  dataMode: 2 },
      ];

      for (const m of consumptionModes) {
        const transferBody = JSON.stringify({
          apiName: '/remote/v1/api/consumption',
          requestMethod: 'POST',
          bodyParam: {
            gwid: guid,
            dataMode: m.dataMode,
            date: todayCompact,
            osTimezone: '+02:00',
          },
        });
        await probe(`/remote/v1/api/consumption via transfer (${m.label})`, 'remote/v1/app/common/transfer', transferBody);
      }
    }

    console.log('\nTermine.');
  } catch (err) {
    console.error('\nERREUR:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
})();
