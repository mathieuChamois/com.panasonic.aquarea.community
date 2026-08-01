'use strict';

/**
 * AquareaClient
 * -------------------------------------------------------------------------
 * Client HTTP pour Panasonic Aquarea via le backend "Comfort Cloud"
 * (accsmart.panasonic.com), avec authentification OAuth2/PKCE (Auth0) sur
 * authglb.digital.panasonic.com.
 *
 * ⚠️  API PRIVEE, NON OFFICIELLE, obtenue par retro-ingenierie. Ce client est
 *     un portage fidele du flux de la librairie Python `aioaquarea`
 *     (https://github.com/cjaliaga/aioaquarea). Il peut cesser de fonctionner
 *     a tout moment si Panasonic modifie son service ou son flux d'auth.
 *
 * ⚠️  Historique : l'ancien endpoint direct
 *     POST aquarea-smart.panasonic.com/remote/v1/api/auth/login a ete
 *     supprime par Panasonic (~mars 2024, passage a Auth0 + 2FA). Ce client
 *     utilise donc le flux applicatif mobile (client OAuth de l'app
 *     Comfort Cloud Android), plus stable et qui evite la page 2FA web.
 *
 * ⚠️  Rate-limiting : n'appelez pas ces methodes en rafale. Le polling
 *     appelant doit respecter un intervalle eleve (>= 300 s par defaut).
 * -------------------------------------------------------------------------
 */

const crypto = require('crypto');
const fetch = require('node-fetch');

// --- Constantes (alignees sur aioaquarea/const.py) ------------------------
const BASE_PATH_ACC = 'https://accsmart.panasonic.com';
const BASE_PATH_AUTH = 'https://authglb.digital.panasonic.com';
const APP_CLIENT_ID = 'Xmy6xIYIitMxngjB2rHvlm6HSDNnaMJx';
const AUTH_0_CLIENT = 'eyJuYW1lIjoiQXV0aDAuQW5kcm9pZCIsImVudiI6eyJhbmRyb2lkIjoiMzAifSwidmVyc2lvbiI6IjIuOS4zIn0=';
const REDIRECT_URI = 'panasonic-iot-cfc://authglb.digital.panasonic.com/android/com.panasonic.ACCsmart/callback';
const AUTH_API_USER_AGENT = 'okhttp/4.10.0';
const AUTH_BROWSER_USER_AGENT = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Mobile Safari/537.36';
const X_APP_VERSION = '4.3.0'; // version applicative annoncee (bump si code 4106)
const OAUTH_SCOPE = 'openid offline_access comfortcloud.control a2w.control';
const OAUTH_AUDIENCE = `https://digital.panasonic.com/${APP_CLIENT_ID}/api/v1/`;

// Endpoints Aquarea relatifs a BASE_PATH_ACC.
const AQUAREA_SERVICE_DEVICES = 'remote/v1/api/devices';
const AQUAREA_TRANSFER = 'remote/v1/app/common/transfer';
const AQUAREA_A2W_STATUS_DISPLAY = 'remote/a2wStatusDisplay';

// Sel utilise pour signer la cle d'API (cf. aioaquarea auth.py _get_api_key).
const API_KEY_SALT = '521325fb2dd486bf4831b47644317fca';

// Aquarea considere 99 comme "mode eteint".
const OP_MODE_OFF = 99;

// Enumerations du firmware Aquarea. Valeurs alignees sur aioaquarea/data.py
// (QuietMode, PowerfulTime, SpecialStatus, DeviceDirection, DeviceModeStatus).
const QUIET_LEVELS = { 0: 'off', 1: 'level1', 2: 'level2', 3: 'level3' };
const POWERFUL_LEVELS = { 0: 'off', 1: '30min', 2: '60min', 3: '90min' };
// ⚠️  specialStatus n'est PAS un code d'erreur : c'est le prereglage actif.
const SPECIAL_STATUS = { 0: 'normal', 1: 'eco', 2: 'comfort' };
const DIRECTIONS = { 0: 'idle', 1: 'pump', 2: 'water' };

// Sonde pilotant la zone. Determine ce que represente zone.temperatureNow :
// avec ZONE_SENSOR_WATER c'est la temperature d'EAU du circuit (retour), pas
// une temperature ambiante — il ne faut donc pas la publier en temperature de
// piece dans Homey.
const ZONE_SENSORS = { 0: 'water', 1: 'external', 2: 'internal', 3: 'thermistor' };
const ZONE_SENSOR_WATER = 0;

// Sentinelle renvoyee par l'API quand une sonde est absente ou hors service
// (aioaquarea/const.py : INVALID_TEMPERATURE). Doit etre traitee comme "pas de
// mesure", sinon Homey affiche et enregistre 126 °C.
const INVALID_TEMPERATURE = 126;

// ExtendedOperationMode (statut) -> mode Homey.
const EXT_MODE_TO_HOMEY = { 0: 'off', 1: 'heat', 2: 'cool', 3: 'auto', 4: 'auto' };
// mode Homey -> UpdateOperationMode (commande).
// 'heat' et 'heat_tank' partagent le meme mode climat (chauffage) ; seule
// l'autorisation ECS (tankStatus.operationStatus) les distingue, cf. setMode().
const HOMEY_TO_UPDATE_MODE = { heat: 2, heat_tank: 2, cool: 3, auto: 8 };

// --- Petits utilitaires ---------------------------------------------------

function randomString(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function base64UrlNoPad(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Jointure d'URL facon urljoin (base absolue + chemin relatif ou absolu). */
function joinUrl(base, path) {
  if (/^https?:\/\//i.test(path) || /^[a-z-]+:\/\//i.test(path)) return path;
  const b = base.replace(/\/+$/, '');
  const p = String(path).replace(/^\/+/, '');
  return `${b}/${p}`;
}

/** Recupere un parametre de query depuis une URL (absolue ou relative). */
function queryParam(url, name) {
  const q = String(url).split('?')[1];
  if (!q) return null;
  for (const kv of q.split('&')) {
    const idx = kv.indexOf('=');
    const k = idx >= 0 ? kv.slice(0, idx) : kv;
    if (decodeURIComponent(k) === name) {
      return decodeURIComponent((idx >= 0 ? kv.slice(idx + 1) : '').replace(/\+/g, ' '));
    }
  }
  return null;
}

function decodeEntities(str) {
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Extrait les <input type="hidden"> (name/value) d'un formulaire HTML. */
function parseHiddenInputs(html) {
  const params = {};
  const re = /<input\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    if (!/type\s*=\s*["']?hidden/i.test(tag)) continue;
    const name = (tag.match(/\bname\s*=\s*"([^"]*)"/i) || tag.match(/\bname\s*=\s*'([^']*)'/i) || [])[1];
    const value = (tag.match(/\bvalue\s*=\s*"([^"]*)"/i) || tag.match(/\bvalue\s*=\s*'([^']*)'/i) || [])[1];
    if (name) params[name] = decodeEntities(value || '');
  }
  return params;
}

class AquareaError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AquareaError';
    this.code = code;
  }
}

class AquareaClient {

  /**
   * @param {object} opts
   * @param {string} opts.username
   * @param {string} opts.password
   * @param {function} [opts.log]
   * @param {function} [opts.error]
   * @param {number} [opts.timeout=25000]
   */
  constructor({ username, password, log, error, timeout } = {}) {
    if (!username || !password) throw new Error('AquareaClient: username and password are required');

    this.username = username;
    this.password = password;
    this.timeout = timeout || 25000;
    this.log = typeof log === 'function' ? log : () => {};
    this.error = typeof error === 'function' ? error : () => {};

    // Jeton et session.
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0; // epoch ms
    this.scope = null;
    this.clientId = null; // "acc" client id

    // Cookie jar minimaliste, par hote : host -> Map(name -> value).
    this._jar = new Map();

    // Verrou d'authentification.
    this._authPromise = null;
  }

  // =========================================================================
  //  Persistance de session (tokens + clientId + cookies)
  // =========================================================================

  exportSession() {
    const jar = {};
    for (const [host, cookies] of this._jar) jar[host] = Object.fromEntries(cookies);
    return {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt,
      scope: this.scope,
      clientId: this.clientId,
      jar,
    };
  }

  importSession(s) {
    if (!s || typeof s !== 'object') return;
    this.accessToken = s.accessToken || null;
    this.refreshToken = s.refreshToken || null;
    this.expiresAt = s.expiresAt || 0;
    this.scope = s.scope || null;
    this.clientId = s.clientId || null;
    this._jar = new Map();
    if (s.jar) {
      for (const host of Object.keys(s.jar)) this._jar.set(host, new Map(Object.entries(s.jar[host])));
    }
  }

  // =========================================================================
  //  Cookie jar
  // =========================================================================

  _hostOf(url) {
    try { return new URL(url).host; } catch (e) { return ''; }
  }

  _cookieHeaderFor(url) {
    const jar = this._jar.get(this._hostOf(url));
    if (!jar || jar.size === 0) return '';
    return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _absorbSetCookies(url, res) {
    const host = this._hostOf(url);
    let raw = [];
    if (typeof res.headers.raw === 'function' && res.headers.raw()['set-cookie']) {
      raw = res.headers.raw()['set-cookie'];
    } else {
      const single = res.headers.get('set-cookie');
      if (single) raw = [single];
    }
    if (!raw.length) return;
    if (!this._jar.has(host)) this._jar.set(host, new Map());
    const jar = this._jar.get(host);
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  _getCookie(url, name) {
    const jar = this._jar.get(this._hostOf(url));
    return jar ? jar.get(name) : undefined;
  }

  // =========================================================================
  //  fetch bas niveau (jar + timeout + redirect manuel)
  // =========================================================================

  async _fetch(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const headers = Object.assign({}, options.headers || {});
    const cookie = this._cookieHeaderFor(url);
    if (cookie) headers.Cookie = cookie;
    try {
      const res = await fetch(url, {
        ...options,
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      this._absorbSetCookies(url, res);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  // =========================================================================
  //  Authentification OAuth2 / PKCE (Auth0)
  // =========================================================================

  async authenticate() {
    if (this._authPromise) return this._authPromise;
    this._authPromise = this._doAuthenticate();
    try {
      await this._authPromise;
    } finally {
      this._authPromise = null;
    }
  }

  /** Alias historique. */
  login() {
    return this.authenticate();
  }

  async _doAuthenticate() {
    this.log('AquareaClient: authenticating (OAuth2/PKCE)...');
    // On repart d'un jar propre pour le domaine d'auth.
    this._jar.delete(this._hostOf(BASE_PATH_AUTH));

    const codeVerifier = randomString(43);
    const codeChallenge = base64UrlNoPad(crypto.createHash('sha256').update(codeVerifier, 'utf8').digest());

    const authorizeRes = await this._authorize(codeChallenge);
    const location = authorizeRes.headers.get('location');
    if (!location) throw new AquareaError('authorize: missing Location header');

    let code;
    if (location.startsWith(REDIRECT_URI)) {
      // L'utilisateur a une session valide : le code est deja dans l'URL.
      code = queryParam(location, 'code');
    } else {
      code = await this._loginWithCredentials(location);
    }
    if (!code) throw new AquareaError('login: authorization code not obtained');

    await this._exchangeCodeForToken(code, codeVerifier);
    await this._retrieveAccClientId();
    this.log('AquareaClient: authentication OK');
  }

  async _authorize(codeChallenge) {
    const params = new URLSearchParams({
      scope: OAUTH_SCOPE,
      audience: OAUTH_AUDIENCE,
      protocol: 'oauth2',
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      auth0Client: AUTH_0_CLIENT,
      client_id: APP_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: randomString(20),
    });
    const res = await this._fetch(`${BASE_PATH_AUTH}/authorize?${params.toString()}`, {
      method: 'GET',
      headers: { 'user-agent': AUTH_API_USER_AGENT },
    });
    if (res.status !== 302) {
      throw new AquareaError(`authorize: expected 302, got ${res.status}: ${await this._peek(res)}`);
    }
    return res;
  }

  async _loginWithCredentials(authorizeLocation) {
    const state = queryParam(authorizeLocation, 'state');

    // 1) Charger la page de login (recupere le cookie _csrf).
    const loginPageUrl = joinUrl(BASE_PATH_AUTH, authorizeLocation);
    const pageRes = await this._fetch(loginPageUrl, {
      method: 'GET',
      headers: { 'user-agent': AUTH_BROWSER_USER_AGENT },
    });
    if (pageRes.status !== 200) {
      throw new AquareaError(
        `login page: expected 200, got ${pageRes.status}. Le flux d'auth Panasonic a peut-etre change. Corps: ${await this._peek(pageRes)}`
      );
    }
    const csrf = this._getCookie(BASE_PATH_AUTH, '_csrf');

    // 2) POST usernamepassword/login -> HTML avec formulaire cache (wa/wresult/wctx).
    const loginRes = await this._fetch(`${BASE_PATH_AUTH}/usernamepassword/login`, {
      method: 'POST',
      headers: {
        'Auth0-Client': AUTH_0_CLIENT,
        'user-agent': AUTH_API_USER_AGENT,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        client_id: APP_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        tenant: 'pdpauthglb-a1',
        response_type: 'code',
        scope: OAUTH_SCOPE,
        audience: OAUTH_AUDIENCE,
        _csrf: csrf,
        state,
        _intstate: 'deprecated',
        username: this.username,
        password: this.password,
        lang: 'en',
        connection: 'PanasonicID-Authentication',
      }),
    });
    if (loginRes.status !== 200) {
      throw new AquareaError(
        `usernamepassword/login: expected 200, got ${loginRes.status} (identifiants invalides ou 2FA ?): ${await this._peek(loginRes)}`
      );
    }
    const formParams = parseHiddenInputs(await loginRes.text());
    if (!formParams.wresult) {
      throw new AquareaError('login: formulaire de callback introuvable (identifiants incorrects ou 2FA active ?)');
    }

    // 3) POST login/callback -> 302.
    const cbRes = await this._fetch(`${BASE_PATH_AUTH}/login/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': AUTH_BROWSER_USER_AGENT,
      },
      body: new URLSearchParams(formParams).toString(),
    });
    if (cbRes.status !== 302) {
      throw new AquareaError(`login/callback: expected 302, got ${cbRes.status}: ${await this._peek(cbRes)}`);
    }

    // 4) Suivre le redirect (resume) -> 302 contenant le code.
    const resumeUrl = joinUrl(BASE_PATH_AUTH, cbRes.headers.get('location'));
    const resumeRes = await this._fetch(resumeUrl, {
      method: 'GET',
      headers: { 'user-agent': AUTH_API_USER_AGENT },
    });
    if (resumeRes.status !== 302) {
      throw new AquareaError(`login resume: expected 302, got ${resumeRes.status}: ${await this._peek(resumeRes)}`);
    }
    return queryParam(resumeRes.headers.get('location'), 'code');
  }

  async _exchangeCodeForToken(code, codeVerifier) {
    const res = await this._fetch(`${BASE_PATH_AUTH}/oauth/token`, {
      method: 'POST',
      headers: {
        'Auth0-Client': AUTH_0_CLIENT,
        'user-agent': AUTH_API_USER_AGENT,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        scope: 'openid',
        client_id: APP_CLIENT_ID,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
      }),
    });
    if (res.status !== 200) throw new AquareaError(`oauth/token: got ${res.status}: ${await this._peek(res)}`);
    this._storeToken(await res.json());
  }

  async _refreshAccessToken() {
    if (!this.refreshToken) throw new AquareaError('no refresh token');
    this.log('AquareaClient: refreshing token...');
    const res = await this._fetch(`${BASE_PATH_AUTH}/oauth/token`, {
      method: 'POST',
      headers: {
        'Auth0-Client': AUTH_0_CLIENT,
        'user-agent': AUTH_API_USER_AGENT,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        scope: this.scope || OAUTH_SCOPE,
        client_id: APP_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      }),
    });
    if (res.status !== 200) throw new AquareaError(`refresh token: got ${res.status}: ${await this._peek(res)}`);
    this._storeToken(await res.json());
  }

  _storeToken(tok) {
    if (!tok || !tok.access_token) throw new AquareaError('token response without access_token');
    this.accessToken = tok.access_token;
    if (tok.refresh_token) this.refreshToken = tok.refresh_token;
    if (tok.scope) this.scope = tok.scope;
    const ttl = Number(tok.expires_in) || 3600;
    this.expiresAt = Date.now() + ttl * 1000;
  }

  /** Recupere le "acc" clientId requis par accsmart. */
  async _retrieveAccClientId() {
    const res = await this._fetch(`${BASE_PATH_ACC}/auth/v2/login`, {
      method: 'POST',
      headers: Object.assign(this._panasonicHeaders(false), { 'content-type': 'application/json' }),
      body: JSON.stringify({ language: 0 }),
    });
    if (res.status !== 200) throw new AquareaError(`acc login: got ${res.status}: ${await this._peek(res)}`);
    const body = await res.json();
    if (!body || !body.clientId) throw new AquareaError('acc login: clientId missing');
    this.clientId = body.clientId;
  }

  // =========================================================================
  //  En-tetes signes Comfort Cloud
  // =========================================================================

  /** Calcule la cle x-cfc-api-key (SHA-256 signee) comme aioaquarea. */
  _computeApiKey(timestamp, token) {
    const [d, t] = timestamp.split(' ');
    const [Y, Mo, Da] = d.split('-').map(Number);
    const [H, Mi, S] = t.split(':').map(Number);
    // La lib interprete l'horodatage local comme s'il etait UTC pour le hash.
    const ms = Date.UTC(Y, Mo - 1, Da, H, Mi, S);
    const input = Buffer.concat([
      Buffer.from('Comfort Cloud', 'utf8'),
      Buffer.from(API_KEY_SALT, 'utf8'),
      Buffer.from(String(ms), 'utf8'),
      Buffer.from('Bearer ', 'utf8'),
      Buffer.from(token, 'utf8'),
    ]);
    const hash = crypto.createHash('sha256').update(input).digest('hex');
    return `${hash.slice(0, 9)}cfc${hash.slice(9)}`;
  }

  _localTimestamp() {
    const n = new Date();
    const p = x => String(x).padStart(2, '0');
    return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
  }

  _panasonicHeaders(includeClientId = true) {
    if (!this.accessToken) throw new AquareaError('access token missing');
    const timestamp = this._localTimestamp();
    const headers = {
      accept: 'application/json; charset=utf-8',
      'content-type': 'application/json',
      'user-agent': 'G-RAC',
      'x-app-name': 'Comfort Cloud',
      'x-app-timestamp': timestamp,
      'x-app-type': '1',
      'x-app-version': X_APP_VERSION,
      'x-cfc-api-key': this._computeApiKey(timestamp, this.accessToken),
      'x-user-authorization-v2': `Bearer ${this.accessToken}`,
    };
    if (includeClientId && this.clientId) headers['x-client-id'] = this.clientId;
    return headers;
  }

  // =========================================================================
  //  Session : garantir un token valide
  // =========================================================================

  get isTokenValid() {
    return Boolean(this.accessToken) && Date.now() < this.expiresAt - 60000;
  }

  async ensureLoggedIn() {
    if (this.isTokenValid && this.clientId) return;
    if (this.accessToken && this.refreshToken) {
      try {
        await this._refreshAccessToken();
        if (!this.clientId) await this._retrieveAccClientId();
        return;
      } catch (err) {
        this.log(`AquareaClient: refresh failed (${err.message}), full re-auth`);
      }
    }
    await this.authenticate();
  }

  // =========================================================================
  //  Requetes API accsmart (avec re-login auto)
  // =========================================================================

  /**
   * Requete vers accsmart. Detecte les erreurs applicatives (HTTP 200 +
   * message d'erreur) et re-authentifie une fois si le token a expire.
   * @private
   */
  async _request(method, path, { json, headers, throwOnError = true } = {}, _retried = false) {
    await this.ensureLoggedIn();

    const base = this._panasonicHeaders(true);
    const finalHeaders = headers ? Object.assign(base, headers) : base;

    const res = await this._fetch(joinUrl(BASE_PATH_ACC, path), {
      method,
      headers: finalHeaders,
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });

    if ((res.status === 401 || res.status === 403) && !_retried) {
      this.log(`AquareaClient: HTTP ${res.status}, re-auth and retry`);
      this.accessToken = null;
      await this.authenticate();
      return this._request(method, path, { json, headers, throwOnError }, true);
    }
    if (res.status === 429) {
      throw new AquareaError('Rate-limited (HTTP 429). Augmentez l\'intervalle de polling.', 429);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new AquareaError(`HTTP ${res.status} on ${path}: ${await this._peek(res)}`, res.status);
    }

    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) data = await res.json();

    // Aquarea renvoie parfois 200 + message d'erreur applicatif.
    if (throwOnError && data) {
      const errs = this._collectErrors(data);
      const authErr = errs.find(e => /token expires/i.test(e.message) || e.code === 4106);
      if (authErr && !_retried) {
        this.log('AquareaClient: token expired (app-level), re-auth and retry');
        this.accessToken = null;
        await this.authenticate();
        return this._request(method, path, { json, headers, throwOnError }, true);
      }
      if (errs.length) throw new AquareaError(errs[0].message, errs[0].code);
    }
    return data;
  }

  _collectErrors(data) {
    if (!data || typeof data !== 'object') return [];
    let messages = data.message;
    if (messages === undefined) return [];
    if (!Array.isArray(messages)) messages = [messages];
    const out = [];
    for (const m of messages) {
      if (m && typeof m === 'object' && m.errorMessage) out.push({ code: m.errorCode, message: m.errorMessage });
      else if (typeof m === 'string' && m) out.push({ code: 'error', message: m });
    }
    return out;
  }

  /** Appel via l'API "transfer" (proxy interne d'Aquarea). */
  _transfer(apiName, requestMethod, bodyParam) {
    const payload = { apiName, requestMethod };
    if (bodyParam !== undefined) payload.bodyParam = bodyParam;
    return this._request('POST', AQUAREA_TRANSFER, { json: payload });
  }

  // =========================================================================
  //  API haut niveau
  // =========================================================================

  /**
   * Liste les PAC Aquarea (deviceType "2") rattachees au compte.
   * @returns {Promise<Array<{id:string,name:string,longId:string,hasTank:boolean,raw:object}>>}
   */
  async getDevices() {
    const data = await this._request('GET', 'device/group');
    const devices = [];
    const groups = (data && data.groupList) || [];
    for (const group of groups) {
      const list = group.deviceList || group.deviceIdList || [];
      for (const d of list) {
        if (!d || String(d.deviceType) !== '2') continue; // 2 = Aquarea
        const id = String(d.deviceGuid);
        devices.push({
          id,
          longId: id,
          name: d.deviceName || 'Aquarea Heat Pump',
          hasTank: Boolean(d.tankStatus && Object.keys(d.tankStatus).length),
          raw: d,
        });
      }
    }
    return devices;
  }

  /**
   * Recupere la consommation energetique du jour (kWh), ventilee par heure.
   * Endpoint : POST remote/v1/app/common/transfer -> /remote/v1/api/consumption
   * dataMode 0 = Day (ventilation horaire).
   * @param {string} deviceId
   * @returns {Promise<{heatKwh:number, coolKwh:number, tankKwh:number, totalKwh:number}|null>}
   */
  async getConsumptionToday(deviceId) {
    const n = new Date();
    const p = x => String(x).padStart(2, '0');
    const date = `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}`;
    const off = -n.getTimezoneOffset();
    const tz = `${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;

    const data = await this._transfer('/remote/v1/api/consumption', 'POST', {
      gwid: deviceId,
      dataMode: 0,
      date,
      osTimezone: tz,
    });

    if (!data || !Array.isArray(data.historyDataList)) return null;

    let heat = 0, cool = 0, tank = 0, heatCost = 0, coolCost = 0, tankCost = 0;
    for (const item of data.historyDataList) {
      heat     += Number(item.heatConsumption) || 0;
      cool     += Number(item.coolConsumption) || 0;
      tank     += Number(item.tankConsumption) || 0;
      heatCost += Number(item.heatCost)        || 0;
      coolCost += Number(item.coolCost)        || 0;
      tankCost += Number(item.tankCost)        || 0;
    }
    const r = v => Math.round(v * 1000) / 1000;
    return {
      heatKwh: r(heat), coolKwh: r(cool), tankKwh: r(tank),
      totalKwh: r(heat + cool + tank),
      heatCost: r(heatCost), coolCost: r(coolCost), tankCost: r(tankCost),
      totalCost: r(heatCost + coolCost + tankCost),
    };
  }

  /**
   * Recupere l'etat d'une PAC (temperatures, consigne, mode, ECS).
   * @param {string} deviceId  Le deviceGuid (long id).
   */
  async getDeviceData(deviceId) {
    let data;
    try {
      data = await this._transfer(`/remote/v1/api/devices?gwid=${encodeURIComponent(deviceId)}&deviceDirect=1`, 'GET');
    } catch (err) {
      this.log(`getDeviceData live failed (${err.message}), fallback cached`);
      data = await this._transfer(`/remote/v1/api/devices?gwid=${encodeURIComponent(deviceId)}&deviceDirect=0`, 'GET');
    }

    const status = (data && data.status) || {};
    const zone = Array.isArray(status.zoneStatus) && status.zoneStatus.length ? status.zoneStatus[0] : {};
    const tank = status.tankStatus && typeof status.tankStatus === 'object'
      && Object.keys(status.tankStatus).length ? status.tankStatus : null;

    const opMode = status.operationMode;
    let thermostatMode = opMode === OP_MODE_OFF ? 'off' : (EXT_MODE_TO_HOMEY[opMode] || 'auto');
    // "Chauffage seul" vs "Chauffage + ECS" : on regarde l'autorisation ECS.
    // tankStatus.operationStatus : 1 = ballon autorise, 0 = coupe.
    if (thermostatMode === 'heat' && tank && this._num(tank.operationStatus) === 1) {
      thermostatMode = 'heat_tank';
    }

    // La consigne de zone peut etre :
    //  - une temperature d'eau absolue (heatMax > ~15), ou
    //  - un decalage de loi d'eau (heatMin < 0, plage typique -5..+5).
    // On expose l'info pour que l'appelant choisisse le bon reglage.
    const zoneHeatMin = this._num(zone.heatMin);
    const zoneHeatMax = this._num(zone.heatMax);
    const zoneIsCurveOffset = zoneHeatMin != null && zoneHeatMin < 0;

    return {
      // --- Ballon ECS ---
      hasTank: Boolean(tank),
      tankTemperature: tank ? this._temp(tank.temperatureNow) : null,
      tankTargetTemperature: tank ? this._temp(tank.heatSet) : null,
      tankHeatMin: tank ? this._num(tank.heatMin) : null,
      tankHeatMax: tank ? this._num(tank.heatMax) : null,
      tankOn: tank ? this._num(tank.operationStatus) === 1 : null,

      // --- Zone (chauffage) ---
      zoneId: zone.zoneId !== undefined ? zone.zoneId : null,
      zoneName: zone.zoneName || null,
      zoneTemperature: this._temp(zone.temperatureNow),
      zoneHeatSet: this._temp(zone.heatSet),
      zoneHeatMin,
      zoneHeatMax,
      zoneIsCurveOffset,
      zoneOn: this._num(zone.operationStatus) === 1,

      // --- Zone : consignes secondaires (memes unites que heatSet) ---
      zoneCoolSet: this._num(zone.coolSet),
      zoneCoolMin: this._num(zone.coolMin),
      zoneCoolMax: this._num(zone.coolMax),
      zoneEcoHeat: this._num(zone.ecoHeat),
      zoneEcoCool: this._num(zone.ecoCool),
      zoneComfortHeat: this._num(zone.comfortHeat),
      zoneComfortCool: this._num(zone.comfortCool),
      zoneType: this._num(zone.zoneType),
      zoneSensor: this._num(zone.zoneSensor),
      zoneSensorKind: this._enum(ZONE_SENSORS, zone.zoneSensor),
      // true => temperatureNow est une temperature d'eau, pas d'ambiance.
      zoneSensorIsWater: this._num(zone.zoneSensor) === ZONE_SENSOR_WATER,

      // --- Systeme : mesures live ---
      outdoorTemperature: this._temp(status.outdoorNow),
      waterPressure: this._num(status.waterPressure),
      // pumpDuty est un booleen marche/arret cote cloud (aioaquarea PumpDuty),
      // et non une mesure de debit ou un pourcentage.
      pumpRunning: this._flag(status.pumpDuty),
      operationMode: opMode,
      thermostatMode,

      // --- Systeme : etats booleens live ---
      // Ces champs valent 0/1 dans l'API ; on les expose en booleens.
      defrosting: this._flag(status.deiceStatus),
      forceDhw: this._flag(status.forceDHW),
      forceHeater: this._flag(status.forceHeater),
      holidayMode: this._flag(status.holidayTimer),
      bivalentActive: this._flag(status.bivalentActual),
      electricAnode: this._flag(status.electricAnode),

      // --- Systeme : modes multi-niveaux ---
      quietMode: this._enum(QUIET_LEVELS, status.quietMode),
      quietModeLevel: this._num(status.quietMode),
      powerfulMode: this._enum(POWERFUL_LEVELS, status.powerful),
      powerfulModeLevel: this._num(status.powerful),
      // Prereglage Eco/Confort actif (et non un code de defaut).
      specialStatus: this._enum(SPECIAL_STATUS, status.specialStatus),
      // Ce que la machine est en train de faire : repos / chauffage / ECS.
      direction: this._enum(DIRECTIONS, status.direction),

      // --- Configuration figee de l'installation (pour les reglages) ---
      config: {
        serviceType: status.serviceType || null,
        modelSeriesSelection: this._num(status.modelSeriesSelection),
        coolMode: this._num(status.coolMode),
        standAlone: this._num(status.standAlone),
        controlBox: this._num(status.controlBox),
        externalHeater: this._num(status.externalHeater),
        multiOdConnection: this._num(status.multiOdConnection),
        bivalent: this._num(status.bivalent),
        uncontrollable: Boolean(status.uncontrollableTaw1Flg),
        zoneCount: Array.isArray(status.zoneStatus) ? status.zoneStatus.length : 0,
      },

      // Toutes les zones telles que remontees (utile pour un futur multi-zone).
      zones: Array.isArray(status.zoneStatus) ? status.zoneStatus : [],

      // --- Compat : consigne "principale" = ballon si present, sinon zone ---
      measureTemperature: tank ? this._num(tank.temperatureNow) : this._num(zone.temperatureNow),
      targetTemperature: tank ? this._num(tank.heatSet) : this._num(zone.heatSet),

      raw: data,
    };
  }

  /**
   * Definit la consigne "principale" (°C entier) :
   *  - si un ballon ECS est present -> consigne du ballon (temperature absolue) ;
   *  - sinon -> consigne de la zone principale.
   * @param {string} deviceId
   * @param {number} temp
   */
  async setTargetTemperature(deviceId, temp) {
    const value = Math.round(Number(temp));
    if (Number.isNaN(value)) throw new AquareaError('setTargetTemperature: invalid temperature');

    const current = await this.getDeviceData(deviceId);

    if (current.hasTank) {
      return this.setTankTemperature(deviceId, value);
    }
    const zoneId = current.zoneId != null ? current.zoneId : 1;
    return this._transfer('/remote/v1/api/devices', 'POST', {
      gwid: deviceId,
      zoneStatus: [{ zoneId, heatSet: value }],
    });
  }

  /**
   * Definit la consigne du ballon ECS (temperature d'eau absolue, °C entier).
   * @param {string} deviceId
   * @param {number} temp
   */
  async setTankTemperature(deviceId, temp) {
    const value = Math.round(Number(temp));
    if (Number.isNaN(value)) throw new AquareaError('setTankTemperature: invalid temperature');
    return this._transfer('/remote/v1/api/devices', 'POST', {
      gwid: deviceId,
      tankStatus: { heatSet: value },
    });
  }

  /**
   * Definit la consigne / le decalage de loi d'eau d'une zone.
   * @param {string} deviceId
   * @param {number} value  Temperature absolue OU decalage (-5..+5) selon la zone.
   * @param {number} [zoneId=1]
   */
  async setZoneTemperature(deviceId, value, zoneId = 1) {
    const v = Math.round(Number(value));
    if (Number.isNaN(v)) throw new AquareaError('setZoneTemperature: invalid value');
    return this._transfer('/remote/v1/api/devices', 'POST', {
      gwid: deviceId,
      zoneStatus: [{ zoneId, heatSet: v }],
    });
  }

  /**
   * Definit le mode de fonctionnement.
   * @param {string} deviceId
   * @param {'auto'|'heat'|'heat_tank'|'cool'|'off'} mode
   *   - 'heat'      : chauffage seul (ballon ECS coupe).
   *   - 'heat_tank' : chauffage + eau chaude (ballon ECS autorise).
   *   - 'cool'/'auto' : n'affecte pas l'etat du ballon (preserve).
   */
  async setMode(deviceId, mode) {
    if (mode === 'off') {
      // Extinction : commande directe operationStatus=0.
      return this._request('POST', `${AQUAREA_SERVICE_DEVICES}/${encodeURIComponent(deviceId)}`, {
        headers: {
          'content-type': 'application/json',
          referer: `${BASE_PATH_ACC}/${AQUAREA_A2W_STATUS_DISPLAY}`,
        },
        json: { status: [{ deviceGuid: deviceId, operationStatus: 0 }] },
      });
    }

    const updateMode = HOMEY_TO_UPDATE_MODE[mode];
    if (updateMode === undefined) throw new AquareaError(`setMode: unknown mode "${mode}"`);

    // Allumage + changement de mode, en preservant zone/tank.
    const current = await this.getDeviceData(deviceId);
    const zoneId = current.zoneId != null ? current.zoneId : 1;

    const bodyParam = {
      gwid: deviceId,
      operationMode: updateMode,
      operationStatus: 1,
      zoneStatus: [{ zoneId, operationStatus: 1 }],
    };

    // Autorisation ECS pilotee par le mode choisi :
    //  - 'heat_tank' => ballon autorise (operationStatus = 1)
    //  - 'heat'      => ballon coupe    (operationStatus = 0), soit "chauffage seul"
    //  - 'cool'/'auto' => on ne touche pas au ballon (etat conserve)
    if (current.hasTank) {
      if (mode === 'heat_tank') bodyParam.tankStatus = { operationStatus: 1 };
      else if (mode === 'heat') bodyParam.tankStatus = { operationStatus: 0 };
    }

    return this._transfer('/remote/v1/api/devices', 'POST', bodyParam);
  }

  /**
   * Marche/arret du ballon ECS (independamment de la zone).
   * @param {string} deviceId
   * @param {boolean} on
   */
  async setTankOperation(deviceId, on) {
    return this._transfer('/remote/v1/api/devices', 'POST', {
      gwid: deviceId,
      tankStatus: { operationStatus: on ? 1 : 0 },
    });
  }

  /**
   * Marche/arret d'une zone de chauffage (independamment du ballon).
   * @param {string} deviceId
   * @param {boolean} on
   * @param {number} [zoneId=1]
   */
  async setZoneOperation(deviceId, on, zoneId = 1) {
    return this._transfer('/remote/v1/api/devices', 'POST', {
      gwid: deviceId,
      zoneStatus: [{ zoneId, operationStatus: on ? 1 : 0 }],
    });
  }

  // =========================================================================
  //  Helpers
  // =========================================================================

  _num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }

  /** Champ 0/1 de l'API -> booleen (null si absent, pour ne rien ecraser). */
  _flag(v) {
    const n = this._num(v);
    return n === null ? null : n !== 0;
  }

  /**
   * Valeur numerique -> libelle d'enum.
   *  - champ absent            -> null   (on n'ecrit rien, l'etat est inconnu)
   *  - code present mais inedit -> 'unknown'
   * Renvoyer null dans le second cas laisserait la tuile afficher
   * indefiniment la valeur precedente, ce qui est trompeur.
   */
  _enum(table, v) {
    const n = this._num(v);
    if (n === null) return null;
    if (table[n] !== undefined) return table[n];
    this.log(`AquareaClient: unmapped enum value ${n} (known: ${Object.keys(table).join(',')})`);
    return 'unknown';
  }

  /** Temperature, en filtrant la sentinelle "sonde absente" (126). */
  _temp(v) {
    const n = this._num(v);
    return n === null || n === INVALID_TEMPERATURE ? null : n;
  }

  async _peek(res) {
    try { return (await res.text()).slice(0, 400); } catch (e) { return '<no body>'; }
  }
}

module.exports = AquareaClient;
module.exports.AquareaError = AquareaError;
