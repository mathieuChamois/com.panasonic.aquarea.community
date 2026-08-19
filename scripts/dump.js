'use strict';

/**
 * Diagnostic script: logs in to Aquarea Smart Cloud and prints the RAW JSON
 * returned by the API (device list + detailed state of each heat pump).
 *
 * Purpose: see exactly what Panasonic exposes (DHW tank / tankStatus, outdoor
 * unit / outdoorNow, zones, etc.) in order to decide what to surface in Homey.
 *
 * Usage:
 *   AQUAREA_USER="my.email@example.com" AQUAREA_PASS="password" \
 *     node scripts/dump.js
 *
 * or by passing the credentials as arguments:
 *   node scripts/dump.js "my.email@example.com" "password"
 *
 * ⚠️  Preferably use the DEDICATED ACCOUNT (see README §2). Every login may
 *     invalidate the mobile app session.
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

    // 1) Raw device list (device/group).
    const devices = await client.getDevices();
    show('APPAREILS (getDevices, vue simplifiee)', devices.map(d => ({
      id: d.id, name: d.name, hasTank: d.hasTank,
    })));
    show('APPAREILS (raw device/group)', devices.map(d => d.raw));

    // 2) Raw detailed state of each device.
    for (const d of devices) {
      // getDeviceData returns a mapped object + the .raw field = full response.
      const data = await client.getDeviceData(d.id);
      // Everything the app surfaces in Homey, minus the raw response.
      const { raw, ...mapped } = data;
      show(`ETAT MAPPE — ${d.name} (${d.id})`, mapped);
      show(`ETAT BRUT (reponse API complete) — ${d.name}`, data.raw);
    }

    // 3) Probe the energy consumption endpoints (kWh).
    //    We call _fetch() directly with the Panasonic headers, to avoid the
    //    re-auth loop that _request() triggers on every 403.
    //    A 403 "Missing Authentication Token" = path that does not exist in the
    //    API Gateway; it does not mean the token is bad.
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

    // Today's date in YYYY-MM-DD format.
    const today = new Date().toISOString().slice(0, 10);

    for (const d of devices) {
      const guid = d.id;
      console.log(`\n== Appareil : ${d.name} (${guid}) ==`);

      // Endpoint found in bisand/panasonic-comfort-cloud-api:
      //   POST /deviceHistoryData
      //   Body: { deviceGuid, dataMode (0=Day,1=Week,2=Month,4=Year), date, osTimezone }
      // We try all 4 modes to see what the API returns for an Aquarea heat pump.
      // Date in YYYYMMDD format (no dashes).
      const todayCompact = today.replace(/-/g, '');

      // Based on cjaliaga/aioaquarea (consumption_manager.py):
      //   - Aquarea endpoint: POST remote/v1/app/common/transfer
      //   - apiName: /remote/v1/api/consumption
      //   - gwid (not deviceGuid), dataMode: 0=Day 1=Month 2=Year
      //   - date: YYYYMMDD
      // The response holds historyDataList with heat/cool/tankConsumption.
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
