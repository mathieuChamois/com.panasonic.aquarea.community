'use strict';

const Homey = require('homey');
const AquareaClient = require('../../lib/AquareaClient');

// Intervalle de polling par defaut : 5 minutes.
// ⚠️  Volontairement eleve pour eviter le rate-limiting / bannissement d'IP
//     par Aquarea Smart Cloud. Ne PAS descendre sous ce plancher sans raison.
const DEFAULT_POLL_INTERVAL_S = 300;
const MIN_POLL_INTERVAL_S = 60;

// Apres une commande acceptee par le cloud, Aquarea continue de renvoyer
// l'ancienne valeur pendant plusieurs minutes (le gateway ne remonte son etat
// que periodiquement). Sans protection, le poll suivant ecrase la valeur
// choisie dans l'app et l'utilisateur voit la tuile "revenir en arriere".
// On fait donc confiance a la commande : la valeur locale prime jusqu'a ce que
// le cloud la confirme, ou au plus pendant OPTIMISTIC_TTL_MS.
const OPTIMISTIC_TTL_MS = 15 * 60 * 1000;

// Rafraichissement de courtoisie apres une commande. Volontairement long :
// interroger le cloud 5 s apres un ordre ne renvoie que des donnees perimees
// et rapproche du rate-limiting.
const POST_COMMAND_REFRESH_MS = 90 * 1000;

// Plages de repli, utilisees uniquement quand l'API ne remonte pas
// heatMin/heatMax. Sans elles, les bornes du manifeste resteraient appliquees a
// une capability qui ne represente pas la meme grandeur.
const FALLBACK_CURVE_OFFSET_RANGE = { min: -5, max: 5, step: 1 };
const FALLBACK_WATER_SETPOINT_RANGE = { min: 20, max: 60, step: 1 };
const FALLBACK_TANK_RANGE = { min: 40, max: 65, step: 1 };

// Capabilities pilotables -> methode de gestion de la commande.
const COMMAND_HANDLERS = {
  'target_temperature': '_onSetTargetTemperature',
  'target_temperature.zone': '_onSetZoneTemperature',
  'thermostat_mode': '_onCapabilityThermostatMode',
  'onoff': '_onSetHeatpumpOnoff',
  'onoff.tank': '_onSetTankOnoff',
  'onoff.zone': '_onSetZoneOnoff',
  'quiet_mode': '_onSetQuietMode',
  'powerful_mode': '_onSetPowerfulMode',
  'holiday_mode': '_onSetHolidayMode',
};

class AquareaDevice extends Homey.Device {

  async onInit() {
    const { id } = this.getData();
    this.deviceId = id;
    this.deviceType = String(this.getStoreValue('deviceType') || '2');
    this._experimentalDiagnosticPending = this.deviceType !== '2';

    this.log(`Aquarea device init: ${this.getName()} (${this.deviceId}, Comfort Cloud type ${this.deviceType})`);

    // Instancie le client a partir des identifiants stockes au pairing.
    const username = this.getStoreValue('username');
    const password = this.getStoreValue('password');

    if (!username || !password) {
      this.setUnavailable(this.homey.__('error.missing_credentials'));
      return;
    }

    // Zone active (mise a jour a chaque poll). Defaut : 1.
    this.zoneId = 1;

    // Cache optimiste : capability -> { value, until }. Voir _commit().
    this._optimistic = new Map();

    // Capabilities dont l'ecouteur de commande est deja enregistre.
    this._listeners = new Set();

    // Disposition deduite du dernier poll (ballon ECS, type de sonde de zone,
    // nature de la consigne). Elle conditionne la liste des capabilities :
    // inutile d'afficher une consigne de ballon sur une PAC qui n'en a pas.
    // Par defaut, l'installation la plus courante : ballon + sonde d'ambiance.
    this._layout = this.getStoreValue('layout')
      || this._computeLayout({ hasTank: true, zoneSensorIsWater: false, zoneIsCurveOffset: false });

    // Le client doit exister avant _syncCapabilities() : celui-ci enregistre les
    // ecouteurs de commande, qui peuvent etre declenches immediatement.
    this.client = new AquareaClient({
      username,
      password,
      log: (...a) => this.log(...a),
      error: (...a) => this.error(...a),
    });

    // Restaure une eventuelle session persistee (tokens + clientId + cookies)
    // pour eviter une re-authentification complete a chaque redemarrage.
    const savedSession = this.getStoreValue('session');
    if (savedSession) this.client.importSession(savedSession);

    await this._syncCapabilities(this._layout);
    await this._refreshUiIndicator();

    // Demarre le moteur de polling.
    this._startPolling();

    // Premier rafraichissement immediat (mais protege).
    this._poll().catch(err => this.error('Initial poll failed:', err.message));
  }

  // =========================================================================
  //  Composition de la carte (capabilities)
  // =========================================================================

  /**
   * Tente de migrer l'indicateur de vignette sans recréer l'appareil. Selon la
   * version de Homey, le setter peut être exposé directement ou via l'API
   * Devices. Le rafraîchissement de classe sert de repli non destructif.
   */
  async _refreshUiIndicator() {
    const migrationKey = 'ui_indicator_refresh_v1';
    if (this.getStoreValue(migrationKey)) return;

    const candidates = [
      'measure_temperature',
      'measure_water_temperature',
      'measure_temperature.zone',
      'measure_temperature.outdoor',
    ];
    const indicator = candidates.find(capability => this.hasCapability(capability));
    if (!indicator) {
      this.error('[UI indicator] Aucune capability de température disponible');
      return;
    }

    try {
      if (typeof this.setUiIndicator === 'function') {
        await this.setUiIndicator(indicator);
        this.log(`[UI indicator] Mis à jour via Device.setUiIndicator: ${indicator}`);
      } else if (this.homey.api && this.homey.api.devices
        && typeof this.homey.api.devices.updateDevice === 'function') {
        await this.homey.api.devices.updateDevice({
          id: typeof this.getId === 'function' ? this.getId() : this.deviceId,
          device: { uiIndicator: indicator },
        });
        this.log(`[UI indicator] Mis à jour via Devices.updateDevice: ${indicator}`);
      } else if (typeof this.setClass === 'function' && typeof this.getClass === 'function') {
        // Force Homey à recalculer les métadonnées UI sans changer l'identité
        // de l'appareil ni les références utilisées dans les Flows.
        await this.setClass(this.getClass());
        this.log(`[UI indicator] Métadonnées UI rafraîchies (indicateur demandé: ${indicator})`);
      } else {
        this.error('[UI indicator] Cette version de Homey ne fournit aucun mécanisme de migration');
        return;
      }

      await this.setStoreValue(migrationKey, true);
    } catch (err) {
      this.error(`[UI indicator] Échec du rafraîchissement: ${err.message}`);
    }
  }

  /**
   * Determine quelle capability recoit quelle grandeur.
   *
   * `measure_temperature` et `target_temperature` sont les capabilities
   * "principales" de Homey : `measure_temperature` alimente la temperature de
   * la piece (et donc les moyennes de zone du foyer), `target_temperature` la
   * carte thermostat. On n'y met une valeur que si elle a vraiment ce sens :
   *
   *  - zoneSensor = 0 => `temperatureNow` est la temperature d'EAU du circuit.
   *    Elle part dans `measure_water_temperature` ; publier 26 °C d'eau comme
   *    temperature ambiante fausserait le climat du foyer.
   *  - heatMin < 0 => `heatSet` est un decalage de loi d'eau en K, pas une
   *    consigne en °C : il part dans `target_temperature.zone`, qui porte son
   *    propre libelle et sa propre plage.
   */
  _computeLayout(data) {
    const hasTank = Boolean(data.hasTank);
    const zoneIsWater = Boolean(data.zoneSensorIsWater);
    const zoneIsOffset = Boolean(data.zoneIsCurveOffset);

    return {
      hasTank,
      hasBivalent: Boolean(data.config && data.config.bivalent),
      zoneIsWater,
      zoneIsOffset,
      // Le ballon ECS, s'il existe, occupe les capabilities principales.
      tankTempCap: hasTank ? 'measure_temperature' : null,
      tankSetpointCap: hasTank ? 'target_temperature' : null,
      zoneTempCap: zoneIsWater
        ? 'measure_water_temperature'
        : (hasTank ? 'measure_temperature.zone' : 'measure_temperature'),
      zoneSetpointCap: (hasTank || zoneIsOffset)
        ? 'target_temperature.zone'
        : 'target_temperature',
    };
  }

  /**
   * Liste ordonnee des capabilities pour ce materiel. L'ordre du tableau =
   * l'ordre des tuiles sur la carte.
   */
  _desiredCapabilities(layout) {
    const { hasTank, hasBivalent } = layout;
    const caps = [];

    caps.push(layout.zoneSetpointCap);
    if (layout.tankSetpointCap) caps.push(layout.tankSetpointCap);
    if (hasTank) caps.push('onoff.tank');
    caps.push('onoff');
    caps.push('onoff.zone');
    if (layout.tankTempCap) caps.push(layout.tankTempCap);
    caps.push(layout.zoneTempCap);

    caps.push('measure_temperature.outdoor');

    // Etats de fonctionnement remontes par le cloud (lecture seule).
    caps.push('operation_direction', 'special_status');
    // Homey Mobile ouvre par defaut le dernier controle de type "picker".
    // thermostat_mode est donc place apres les autres pickers afin que le
    // troisieme onglet s'ouvre sur "Mode de fonctionnement".
    caps.push('quiet_mode', 'powerful_mode', 'thermostat_mode', 'defrost_active', 'force_heater');
    if (hasTank) caps.push('force_dhw', 'electric_anode');
    if (hasBivalent) caps.push('bivalent_active');
    caps.push('holiday_mode', 'measure_water_pressure', 'pump_running');
    caps.push('meter_power.heat', 'meter_power.cool');
    if (hasTank) caps.push('meter_power.tank');
    caps.push('measure_cost.heat', 'measure_cost.cool');
    if (hasTank) caps.push('measure_cost.tank');

    return caps;
  }

  /**
   * Aligne les capabilities de l'appareil sur `_desiredCapabilities()`.
   *
   * Homey fige l'ordre des capabilities au moment de leur ajout : pour changer
   * l'ordre il faut les retirer puis les re-ajouter. On ne le fait que si la
   * liste effective differe reellement, car l'operation remet les valeurs a
   * zero (elles sont repeuplees au poll suivant).
   */
  async _syncCapabilities(layout) {
    const desired = this._desiredCapabilities(layout);
    const current = this.getCapabilities();

    const identical = current.length === desired.length
      && desired.every((cap, i) => current[i] === cap);
    if (identical) {
      this._registerCommandListeners();
      return;
    }

    this.log('Rebuilding capabilities: '
      + `tank=${layout.hasTank} bivalent=${layout.hasBivalent} `
      + `zoneSensor=${layout.zoneIsWater ? 'water' : 'room'} `
      + `zoneSetpoint=${layout.zoneIsOffset ? 'curve offset' : 'absolute'}`);
    this._listeners.clear();
    this._rangesApplied = false;

    for (const cap of current) {
      try { await this.removeCapability(cap); } catch (err) { this.error(`removeCapability(${cap})`, err.message); }
    }
    for (const cap of desired) {
      try { await this.addCapability(cap); } catch (err) { this.error(`addCapability(${cap})`, err.message); }
    }

    this._registerCommandListeners();
  }

  /** Enregistre les ecouteurs de commande des capabilities presentes. */
  _registerCommandListeners() {
    for (const [cap, method] of Object.entries(COMMAND_HANDLERS)) {
      if (!this.hasCapability(cap) || this._listeners.has(cap)) continue;
      this.registerCapabilityListener(cap, this[method].bind(this));
      this._listeners.add(cap);
    }
  }

  // =========================================================================
  //  Moteur de polling
  // =========================================================================

  _resolveInterval() {
    let seconds = Number(this.getSetting('poll_interval'));
    if (!Number.isFinite(seconds)) seconds = DEFAULT_POLL_INTERVAL_S;
    if (seconds < MIN_POLL_INTERVAL_S) seconds = MIN_POLL_INTERVAL_S;
    return seconds * 1000;
  }

  _startPolling() {
    this._stopPolling();
    const ms = this._resolveInterval();
    this.log(`Polling every ${ms / 1000}s`);
    this._pollTimer = this.homey.setInterval(() => {
      this._poll().catch(err => this.error('Poll failed:', err.message));
    }, ms);
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _cancelRefresh() {
    if (this._refreshTimer) {
      this.homey.clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  /** Recupere l'etat depuis le cloud et synchronise les capabilities. */
  async _poll() {
    if (this._polling) return; // evite le chevauchement de deux polls.
    this._polling = true;

    try {
      const diagnostic = this._experimentalDiagnosticPending;
      const data = await this.client.getDeviceData(this.deviceId, {
        diagnostic,
        deviceType: this.deviceType,
      });
      if (diagnostic) this._experimentalDiagnosticPending = false;

      if (data.zoneId != null) this.zoneId = data.zoneId;

      // Le materiel reellement present peut differer de ce qu'on croyait :
      // on recompose la carte avant d'ecrire les valeurs.
      await this._applyLayout(data);

      // Ajuste une seule fois les plages min/max reelles remontees par l'API.
      await this._applyRanges(data);

      const layout = this._layout;
      if (layout.tankTempCap) {
        await this._setCapability(layout.tankTempCap, data.tankTemperature);
        await this._setCapability(layout.tankSetpointCap, data.tankTargetTemperature);
        await this._setCapability('onoff.tank', data.tankOn);
      }
      await this._setCapability(layout.zoneTempCap, data.zoneTemperature);
      await this._setCapability(layout.zoneSetpointCap, data.zoneHeatSet);
      await this._setCapability('onoff.zone', data.zoneOn);

      // Systeme.
      await this._setCapability('measure_temperature.outdoor', data.outdoorTemperature);
      await this._setCapability('measure_water_pressure', data.waterPressure);
      await this._setCapability('pump_running', data.pumpRunning);
      await this._setCapability('thermostat_mode', data.thermostatMode);
      await this._setCapability('onoff', data.thermostatMode !== 'off');

      // Etats de fonctionnement.
      await this._setCapability('operation_direction', data.direction);
      await this._setCapability('special_status', data.specialStatus);
      await this._setCapability('quiet_mode', data.quietMode);
      await this._setCapability('powerful_mode', data.powerfulMode);
      await this._setCapability('defrost_active', data.defrosting);
      await this._setCapability('force_heater', data.forceHeater);
      await this._setCapability('force_dhw', data.forceDhw);
      await this._setCapability('electric_anode', data.electricAnode);
      await this._setCapability('bivalent_active', data.bivalentActive);
      await this._setCapability('holiday_mode', data.holidayMode);

      // Details d'installation (reglages en lecture seule).
      await this._updateInfoSettings(data);

      // Consommation energetique du jour (endpoint separe, erreur non bloquante).
      await this._pollConsumption();

      // Persiste la session rafraichie pour survivre aux redemarrages.
      await this.setStoreValue('session', this.client.exportSession());

      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.error('Polling error:', err.message);
      // On garde l'appareil dispo sauf erreur persistante d'auth.
      if (/identifiants|invalid|2FA|authorization code|access token/i.test(err.message)) {
        await this.setUnavailable(this.homey.__('error.connection_failed', { message: err.message }));
      }
    } finally {
      this._polling = false;
    }
  }

  async _pollConsumption() {
    try {
      const c = await this.client.getConsumptionToday(this.deviceId);
      if (!c) return;

      const kwhCost = Number(this.getSetting('kwh_cost')) || 0;
      const calc = (kwh, cloudCost) => {
        if (kwhCost > 0) return Math.round(kwh * kwhCost * 1000) / 1000;
        return cloudCost;
      };

      await this._setCapability('meter_power.heat', c.heatKwh);
      await this._setCapability('meter_power.cool', c.coolKwh);
      await this._setCapability('measure_cost.heat', calc(c.heatKwh, c.heatCost));
      await this._setCapability('measure_cost.cool', calc(c.coolKwh, c.coolCost));
      if (this._layout.hasTank) {
        await this._setCapability('meter_power.tank', c.tankKwh);
        await this._setCapability('measure_cost.tank', calc(c.tankKwh, c.tankCost));
      }
    } catch (err) {
      this.error('Consumption poll error:', err.message);
    }
  }

  /**
   * Ecrit une capability. Les valeurs venant du cloud (force = false) sont
   * ignorees tant qu'une commande locale recente n'a pas ete confirmee.
   */
  async _setCapability(cap, value, { force = false } = {}) {
    if (value === null || typeof value === 'undefined') return;
    if (!this.hasCapability(cap)) return;
    if (!force && this._isMasked(cap, value)) return;
    try {
      await this.setCapabilityValue(cap, value);
    } catch (err) {
      this.error(`setCapabilityValue(${cap}) failed:`, err.message);
    }
  }

  // =========================================================================
  //  Cache optimiste des commandes
  // =========================================================================

  /**
   * Applique immediatement la valeur commandee et la protege des ecrasements
   * par le cloud. A n'appeler qu'apres l'acquittement de la requete HTTP :
   * hors erreur reseau / applicative, on considere l'ordre comme transmis.
   */
  async _commit(cap, value) {
    if (!this.hasCapability(cap)) return;
    this._optimistic.set(cap, { value, until: Date.now() + OPTIMISTIC_TTL_MS });
    await this._setCapability(cap, value, { force: true });
  }

  /** true si la valeur du cloud doit etre ignoree pour cette capability. */
  _isMasked(cap, incoming) {
    const pending = this._optimistic.get(cap);
    if (!pending) return false;

    if (Date.now() >= pending.until) {
      this.log(`Optimistic value for ${cap} expired, trusting cloud again`);
      this._optimistic.delete(cap);
      return false;
    }
    if (this._sameValue(pending.value, incoming)) {
      // Le cloud a rattrape son retard : le polling reprend la main.
      this._optimistic.delete(cap);
      return false;
    }
    this.log(`Ignoring stale cloud value for ${cap} (${incoming}), keeping ${pending.value}`);
    return true;
  }

  _sameValue(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.01;
    return a === b;
  }

  // =========================================================================
  //  Adaptation a l'installation reelle
  // =========================================================================

  /** Recompose la carte si la disposition deduite a change. */
  async _applyLayout(data) {
    const layout = this._computeLayout(data);
    if (JSON.stringify(layout) === JSON.stringify(this._layout)) return;

    this._layout = layout;
    this._rangesApplied = false;
    await this.setStoreValue('layout', layout);
    await this._syncCapabilities(layout);
  }

  /**
   * Applique (une seule fois) les plages min/max reelles de l'appareil aux
   * capabilities de consigne, d'apres heatMin/heatMax remontes par l'API.
   *
   * La consigne de zone est soit une temperature d'eau absolue, soit un
   * decalage de loi d'eau (plage typique -5..+5) : le libelle suit.
   */
  async _applyRanges(data) {
    if (this._rangesApplied) return;
    const layout = this._layout;

    // Un decalage de loi d'eau s'exprime en kelvins, pas en degres absolus.
    const zoneLabel = layout.zoneIsOffset
      ? { en: 'Zone curve offset', fr: "Decalage loi d'eau zone" }
      : { en: 'Zone water setpoint', fr: "Consigne d'eau zone" };
    const zoneUnits = layout.zoneIsOffset ? { en: 'K', fr: 'K' } : { en: '°C', fr: '°C' };

    // ⚠️  Si l'API ne remonte pas de plage, il FAUT quand meme envoyer min/max :
    //     sinon les bornes du manifeste (40-65 °C, prevues pour le ballon)
    //     restent en place sur une consigne de zone, et `_rangesApplied` fait
    //     qu'on ne repassera jamais corriger. On envoie donc toujours un jeu
    //     complet title + units + min/max/step, ce qui est aussi sur que
    //     setCapabilityOptions remplace ou fusionne les options existantes.
    const zoneRange = data.zoneHeatMin != null && data.zoneHeatMax != null
      ? { min: data.zoneHeatMin, max: data.zoneHeatMax, step: 1 }
      : (layout.zoneIsOffset ? FALLBACK_CURVE_OFFSET_RANGE : FALLBACK_WATER_SETPOINT_RANGE);
    const tankRange = data.tankHeatMin != null && data.tankHeatMax != null
      ? { min: data.tankHeatMin, max: data.tankHeatMax, step: 1 }
      : FALLBACK_TANK_RANGE;

    const jobs = [];
    if (this.hasCapability(layout.zoneSetpointCap)) {
      jobs.push(this.setCapabilityOptions(layout.zoneSetpointCap,
        Object.assign({ title: zoneLabel, units: zoneUnits }, zoneRange)));
    }
    if (layout.tankSetpointCap && this.hasCapability(layout.tankSetpointCap)) {
      jobs.push(this.setCapabilityOptions(layout.tankSetpointCap, Object.assign({
        title: { en: 'Tank setpoint', fr: 'Consigne ballon' },
        units: { en: '°C', fr: '°C' },
      }, tankRange)));
    }
    // Sans ballon, `measure_temperature` porte la zone : il faut corriger le
    // libelle herite du manifeste ("Tank temperature").
    if (!layout.hasTank && layout.zoneTempCap === 'measure_temperature') {
      jobs.push(this.setCapabilityOptions('measure_temperature', {
        title: { en: 'Room temperature', fr: 'Temperature ambiante' },
      }));
    }
    if (this.hasCapability('meter_power.heat')) {
      jobs.push(this.setCapabilityOptions('meter_power.heat', {
        title: { en: 'Heat energy today', fr: "Energie chauffage aujourd'hui" },
      }));
    }
    if (this.hasCapability('meter_power.cool')) {
      jobs.push(this.setCapabilityOptions('meter_power.cool', {
        title: { en: 'Cool energy today', fr: "Energie climatisation aujourd'hui" },
      }));
    }
    if (this.hasCapability('meter_power.tank')) {
      jobs.push(this.setCapabilityOptions('meter_power.tank', {
        title: { en: 'Tank energy today', fr: "Energie ballon aujourd'hui" },
      }));
    }
    if (this.hasCapability('measure_cost.heat')) {
      jobs.push(this.setCapabilityOptions('measure_cost.heat', {
        icon: '/assets/capabilities/cost.svg',
        title: { en: 'Heat cost today', fr: "Cout chauffage aujourd'hui" },
      }));
    }
    if (this.hasCapability('measure_cost.cool')) {
      jobs.push(this.setCapabilityOptions('measure_cost.cool', {
        icon: '/assets/capabilities/cost.svg',
        title: { en: 'Cool cost today', fr: "Cout climatisation aujourd'hui" },
      }));
    }
    if (this.hasCapability('measure_cost.tank')) {
      jobs.push(this.setCapabilityOptions('measure_cost.tank', {
        icon: '/assets/capabilities/cost.svg',
        title: { en: 'Tank cost today', fr: "Cout ballon aujourd'hui" },
      }));
    }

    if (!jobs.length) return;
    try {
      await Promise.all(jobs);
      this._rangesApplied = true;
    } catch (err) {
      this.error('applyRanges failed:', err.message);
    }
  }

  /**
   * Recopie la configuration figee de l'installation dans les reglages en
   * lecture seule. N'ecrit que si quelque chose a change, pour ne pas solliciter
   * le stockage a chaque poll.
   */
  async _updateInfoSettings(data) {
    const t = key => this.homey.__(`info.${key}`);
    const cfg = data.config || {};
    const yesNo = v => (v ? t('yes') : t('no'));

    const zoneNames = (data.zones || []).map(z => z.zoneName).filter(Boolean).join(', ');
    const setpointKind = data.zoneIsCurveOffset ? t('setpoint_offset') : t('setpoint_absolute');
    const unit = data.zoneIsCurveOffset ? 'K' : '°C';
    const range = data.zoneHeatMin != null && data.zoneHeatMax != null
      ? ` (${data.zoneHeatMin} … ${data.zoneHeatMax} ${unit})` : '';
    const sensor = data.zoneSensorKind ? t(`sensor_${data.zoneSensorKind}`) : t('unknown');

    const ecoComfort = [
      `${t('eco_heat')} ${this._fmt(data.zoneEcoHeat)}`,
      `${t('eco_cool')} ${this._fmt(data.zoneEcoCool)}`,
      `${t('comfort_heat')} ${this._fmt(data.zoneComfortHeat)}`,
      `${t('comfort_cool')} ${this._fmt(data.zoneComfortCool)}`,
    ].join(' · ');

    const settings = {
      info_service_type: cfg.serviceType || t('unknown'),
      info_model_series: cfg.modelSeriesSelection != null ? String(cfg.modelSeriesSelection) : t('unknown'),
      info_zones: zoneNames ? `${cfg.zoneCount} — ${zoneNames}` : String(cfg.zoneCount || 0),
      info_zone_control: setpointKind + range,
      info_zone_sensor: sensor,
      // Signification non documentee : on affiche la valeur brute.
      info_cool_mode: cfg.coolMode != null ? String(cfg.coolMode) : t('unknown'),
      info_tank: data.hasTank ? t('present') : t('absent'),
      info_bivalent: yesNo(cfg.bivalent),
      info_external_heater: yesNo(cfg.externalHeater),
      info_control_box: yesNo(cfg.controlBox),
      info_eco_comfort: ecoComfort,
      info_last_update: new Date().toLocaleString('en-GB', { timeZone: this.homey.clock.getTimezone() }),
    };

    // `info_last_update` change a chaque poll : on l'exclut de la comparaison
    // pour ne reecrire que lorsqu'une vraie donnee a bouge.
    const signature = JSON.stringify(Object.assign({}, settings, { info_last_update: null }));
    if (signature === this._infoSignature) return;
    this._infoSignature = signature;

    try {
      await this.setSettings(settings);
    } catch (err) {
      this.error('updateInfoSettings failed:', err.message);
    }
  }

  _fmt(v) {
    if (v === null || typeof v === 'undefined') return '—';
    return `${v > 0 ? '+' : ''}${v}`;
  }

  // =========================================================================
  //  Ecoute des commandes
  // =========================================================================

  /**
   * Rafraichissement de courtoisie apres une commande, debounce : plusieurs
   * ordres rapproches ne declenchent qu'un seul appel au cloud.
   */
  _refreshSoon() {
    this._cancelRefresh();
    this._refreshTimer = this.homey.setTimeout(() => {
      this._refreshTimer = null;
      this._poll().catch(() => {});
    }, POST_COMMAND_REFRESH_MS);
  }

  /**
   * `target_temperature` porte le ballon ECS quand il y en a un, et sinon la
   * consigne d'eau de la zone (jamais un decalage de loi d'eau : celui-ci vit
   * sur `target_temperature.zone`). Voir _computeLayout().
   */
  async _onSetTargetTemperature(value) {
    const rounded = Math.round(Number(value));
    if (this._layout.tankSetpointCap === 'target_temperature') {
      this.log(`Command: tank setpoint -> ${rounded}`);
      await this.client.setTankTemperature(this.deviceId, rounded);
    } else {
      this.log(`Command: zone setpoint -> ${rounded} (zone ${this.zoneId})`);
      await this.client.setZoneTemperature(this.deviceId, rounded, this.zoneId);
    }
    await this._commit('target_temperature', rounded);
    this._refreshSoon();
  }

  async _onSetZoneTemperature(value) {
    this.log(`Command: zone setpoint/offset -> ${value} (zone ${this.zoneId})`);
    await this.client.setZoneTemperature(this.deviceId, value, this.zoneId);
    await this._commit('target_temperature.zone', Math.round(Number(value)));
    this._refreshSoon();
  }

  async _onCapabilityThermostatMode(value) {
    this.log(`Command: thermostat_mode -> ${value}`);
    await this.client.setMode(this.deviceId, value);
    await this._commit('thermostat_mode', value);
    await this._commit('onoff', value !== 'off');

    // setMode() pilote aussi la zone et l'autorisation ECS : on aligne les
    // interrupteurs sur ce qui vient d'etre envoye (cf. AquareaClient.setMode).
    if (value !== 'off') {
      await this._commit('onoff.zone', value !== 'dhw');
      if (value === 'heat_tank' || value === 'cool_tank' || value === 'dhw') await this._commit('onoff.tank', true);
      else if (value === 'heat' || value === 'cool') await this._commit('onoff.tank', false);
    }
    this._refreshSoon();
  }

  async _onSetHeatpumpOnoff(value) {
    const on = Boolean(value);
    const mode = this.getCapabilityValue('thermostat_mode');
    const newMode = on ? (mode === 'off' ? 'heat' : mode) : 'off';
    this.log(`Command: heat pump on/off -> ${on} (mode ${newMode})`);
    await this.client.setMode(this.deviceId, newMode);
    await this._commit('onoff', on);
    await this._commit('thermostat_mode', newMode);
    if (!on) await this._commit('onoff.zone', false);
    this._refreshSoon();
  }

  async _onSetTankOnoff(value) {
    this.log(`Command: tank on/off -> ${value}`);
    const on = Boolean(value);

    // En chauffage ou rafraichissement, l'autorisation ECS distingue le mode simple du mode + ECS.
    // On prefere appeler setMode car cela garantit la coherence cote cloud Panasonic
    // (certains modeles ignorent une commande tankStatus seule si elle contredit le mode).
    const mode = this.getCapabilityValue('thermostat_mode');
    if (mode === 'heat' || mode === 'heat_tank') {
      const newMode = on ? 'heat_tank' : 'heat';
      await this.client.setMode(this.deviceId, newMode);
      await this._commit('thermostat_mode', newMode);
    } else if (mode === 'cool' || mode === 'cool_tank') {
      const newMode = on ? 'cool_tank' : 'cool';
      await this.client.setMode(this.deviceId, newMode);
      await this._commit('thermostat_mode', newMode);
    } else if (mode === 'dhw' && !on) {
      await this.client.setMode(this.deviceId, 'off');
      await this._commit('thermostat_mode', 'off');
      await this._commit('onoff.zone', false);
    } else {
      await this.client.setTankOperation(this.deviceId, on);
    }

    await this._commit('onoff.tank', on);
    this._refreshSoon();
  }

  async _onSetZoneOnoff(value) {
    this.log(`Command: zone on/off -> ${value} (zone ${this.zoneId})`);
    const on = Boolean(value);

    // Si on éteint la zone alors qu'on est en mode chauffage/clim,
    // on passe en mode 'off' global si le ballon est aussi éteint ou absent.
    // Mais Panasonic permet souvent d'éteindre juste la zone.
    // Par sécurité et cohérence avec le reste, on utilise setZoneOperation
    // mais on s'assure que le thermostat_mode reflète l'extinction si c'est global.
    await this.client.setZoneOperation(this.deviceId, on, this.zoneId);
    await this._commit('onoff.zone', on);

    if (!on) {
      const tankOn = this.getCapabilityValue('onoff.tank');
      if (!tankOn) {
        // Si tout est éteint, on s'assure que le mode est 'off'
        await this._commit('thermostat_mode', 'off');
      }
    } else {
      // Si on rallume la zone, on s'assure que le mode n'est pas 'off'
      const mode = this.getCapabilityValue('thermostat_mode');
      if (mode === 'off') {
        await this._commit('thermostat_mode', 'heat'); // Par défaut
      }
    }

    this._refreshSoon();
  }

  async _onSetQuietMode(value) {
    this.log(`Command: quiet mode -> ${value}`);
    await this.client.setQuietMode(this.deviceId, value);
    await this._commit('quiet_mode', value);
    this._refreshSoon();
  }

  async _onSetPowerfulMode(value) {
    this.log(`Command: powerful mode -> ${value}`);
    await this.client.setPowerfulMode(this.deviceId, value);
    await this._commit('powerful_mode', value);
    this._refreshSoon();
  }

  async _onSetHolidayMode(value) {
    const on = Boolean(value);
    this.log(`Command: holiday mode -> ${on}`);
    await this.client.setHolidayMode(this.deviceId, on);
    await this._commit('holiday_mode', on);
    this._refreshSoon();
  }

  // =========================================================================
  //  Cycle de vie
  // =========================================================================

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      this.log('Poll interval changed, restarting poller');
      this._startPolling();
    }
  }

  async onDeleted() {
    this.log(`Aquarea device deleted: ${this.deviceId}`);
    this._stopPolling();
    this._cancelRefresh();
  }

  async onUninit() {
    this._stopPolling();
    this._cancelRefresh();
  }

}

module.exports = AquareaDevice;
