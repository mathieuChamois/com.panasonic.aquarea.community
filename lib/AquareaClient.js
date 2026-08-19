'use strict';

/**
 * AquareaClient
 * -------------------------------------------------------------------------
 * HTTP client for Panasonic Aquarea through the "Comfort Cloud" backend
 * (accsmart.panasonic.com), with OAuth2/PKCE authentication (Auth0) on
 * authglb.digital.panasonic.com.
 *
 * ⚠️  PRIVATE, UNOFFICIAL API, obtained by reverse engineering. This client is
 *     a faithful port of the flow used by the Python library `aioaquarea`
 *     (https://github.com/cjaliaga/aioaquarea). It may stop working at any
 *     time if Panasonic changes its service or its auth flow.
 *
 * ⚠️  History: the old direct endpoint
 *     POST aquarea-smart.panasonic.com/remote/v1/api/auth/login was removed
 *     by Panasonic (~March 2024, move to Auth0 + 2FA). This client therefore
 *     uses the mobile app flow (OAuth client of the Comfort Cloud Android
 *     app), which is more stable and avoids the web 2FA page.
 *
 * ⚠️  Rate-limiting: do not call these methods in bursts. The calling poller
 *     must respect a high interval (>= 300 s by default).
 * -------------------------------------------------------------------------
 */

const crypto = require('crypto');
const fetch = require('node-fetch');

// --- Constants (aligned with aioaquarea/const.py) -------------------------
const BASE_PATH_ACC = 'https://accsmart.panasonic.com';
const BASE_PATH_AUTH = 'https://authglb.digital.panasonic.com';
const APP_CLIENT_ID = 'Xmy6xIYIitMxngjB2rHvlm6HSDNnaMJx';
const AUTH_0_CLIENT = 'eyJuYW1lIjoiQXV0aDAuQW5kcm9pZCIsImVudiI6eyJhbmRyb2lkIjoiMzAifSwidmVyc2lvbiI6IjIuOS4zIn0=';
const REDIRECT_URI = 'panasonic-iot-cfc://authglb.digital.panasonic.com/android/com.panasonic.ACCsmart/callback';
const AUTH_API_USER_AGENT = 'okhttp/4.10.0';
const AUTH_BROWSER_USER_AGENT = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Mobile Safari/537.36';
const X_APP_VERSION = '4.3.0'; // advertised app version (bump it on code 4106)
const OAUTH_SCOPE = 'openid offline_access comfortcloud.control a2w.control';
const OAUTH_AUDIENCE = `https://digital.panasonic.com/${APP_CLIENT_ID}/api/v1/`;

// Aquarea endpoints, relative to BASE_PATH_ACC.
const AQUAREA_SERVICE_DEVICES = 'remote/v1/api/devices';
const AQUAREA_TRANSFER = 'remote/v1/app/common/transfer';
const AQUAREA_A2W_STATUS_DISPLAY = 'remote/a2wStatusDisplay';

// Salt used to sign the API key (see aioaquarea auth.py _get_api_key).
const API_KEY_SALT = '521325fb2dd486bf4831b47644317fca';

// Aquarea treats 99 as "powered off" mode.
const OP_MODE_OFF = 99;

// Aquarea firmware enums. Values aligned with aioaquarea/data.py
// (QuietMode, PowerfulTime, SpecialStatus, DeviceDirection, DeviceModeStatus).
const QUIET_LEVELS = { 0: 'off', 1: 'level1', 2: 'level2', 3: 'level3' };
const POWERFUL_LEVELS = { 0: 'off', 1: '30min', 2: '60min', 3: '90min' };
const QUIET_LEVEL_CODES = { off: 0, level1: 1, level2: 2, level3: 3 };
const POWERFUL_LEVEL_CODES = { off: 0, '30min': 1, '60min': 2, '90min': 3 };
// ⚠️  specialStatus is NOT an error code: it is the active preset.
const SPECIAL_STATUS = { 0: 'normal', 1: 'eco', 2: 'comfort' };
const SPECIAL_STATUS_CODES = { normal: 0, eco: 1, comfort: 2 };
// `direction` only says WHERE the energy goes: nowhere (0), the heating /
// cooling circuit (1), or the DHW tank (2). The direction itself (hot/cold)
// comes from the extended mode, see EXT_MODE_COOLING / EXT_MODE_HEATING.
const DIRECTIONS = { 0: 'idle', 1: 'active', 2: 'hot_water' };

// ExtendedOperationMode: 3 = auto currently heating, 4 = auto currently
// cooling. The extended mode therefore always says what the unit is really
// doing, including in auto - unlike the requested mode.
const EXT_MODE_COOLING = [2, 4];
const EXT_MODE_HEATING = [1, 3];

// Sensor driving the zone. Determines what zone.temperatureNow means: with
// ZONE_SENSOR_WATER it is the WATER temperature of the circuit (return), not
// a room temperature - so it must not be published as a room temperature in
// Homey.
const ZONE_SENSORS = { 0: 'water', 1: 'external', 2: 'internal', 3: 'thermistor' };
const ZONE_SENSOR_WATER = 0;

// Sentinel returned by the API when a probe is missing or broken
// (aioaquarea/const.py: INVALID_TEMPERATURE). Must be treated as "no
// reading", otherwise Homey displays and records 126 °C.
const INVALID_TEMPERATURE = 126;

// ExtendedOperationMode (status) -> Homey mode.
const EXT_MODE_TO_HOMEY = { 0: 'off', 1: 'heat', 2: 'cool', 3: 'auto', 4: 'auto' };
// Homey mode -> UpdateOperationMode (command).
// 'heat', 'heat_tank' and 'dhw' share the same climate mode (heating);
// 'cool' and 'cool_tank' share the same climate mode (cooling);
// only the DHW permission (tankStatus.operationStatus) tells them apart,
// see setMode().
const HOMEY_TO_UPDATE_MODE = { heat: 2, heat_tank: 2, dhw: 2, cool: 3, cool_tank: 3, auto: 8 };

// --- Small utilities ------------------------------------------------------

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

/** URL join, urljoin-style (absolute base + relative or absolute path). */
function joinUrl(base, path) {
  if (/^https?:\/\//i.test(path) || /^[a-z-]+:\/\//i.test(path)) return path;
  const b = base.replace(/\/+$/, '');
  const p = String(path).replace(/^\/+/, '');
  return `${b}/${p}`;
}

/** Reads a query parameter from a URL (absolute or relative). */
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

/** Extracts the <input type="hidden"> (name/value) pairs of an HTML form. */
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

    // Token and session.
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0; // epoch ms
    this.scope = null;
    this.clientId = null; // "acc" client id

    // Minimal cookie jar, per host: host -> Map(name -> value).
    this._jar = new Map();

    // Authentication lock.
    this._authPromise = null;
  }

  // =========================================================================
  //  Session persistence (tokens + clientId + cookies)
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
  //  Low-level fetch (jar + timeout + manual redirect)
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
  //  OAuth2 / PKCE authentication (Auth0)
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

  /** Legacy alias. */
  login() {
    return this.authenticate();
  }

  async _doAuthenticate() {
    this.log('AquareaClient: authenticating (OAuth2/PKCE)...');
    // Start from a clean jar for the auth domain.
    this._jar.delete(this._hostOf(BASE_PATH_AUTH));

    const codeVerifier = randomString(43);
    const codeChallenge = base64UrlNoPad(crypto.createHash('sha256').update(codeVerifier, 'utf8').digest());

    const authorizeRes = await this._authorize(codeChallenge);
    const location = authorizeRes.headers.get('location');
    if (!location) throw new AquareaError('authorize: missing Location header');

    let code;
    if (location.startsWith(REDIRECT_URI)) {
      // The user has a valid session: the code is already in the URL.
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

    // 1) Load the login page (picks up the _csrf cookie).
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

    // 2) POST usernamepassword/login -> HTML with a hidden form (wa/wresult/wctx).
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

    // 4) Follow the redirect (resume) -> 302 holding the code.
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

  /** Fetches the "acc" clientId required by accsmart. */
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
  //  Signed Comfort Cloud headers
  // =========================================================================

  /** Computes the x-cfc-api-key key (signed SHA-256) like aioaquarea does. */
  _computeApiKey(timestamp, token) {
    const [d, t] = timestamp.split(' ');
    const [Y, Mo, Da] = d.split('-').map(Number);
    const [H, Mi, S] = t.split(':').map(Number);
    // The library reads the local timestamp as if it were UTC for the hash.
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
  //  Session: guarantee a valid token
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
  //  accsmart API requests (with automatic re-login)
  // =========================================================================

  /**
   * Request to accsmart. Detects application-level errors (HTTP 200 + error
   * message) and re-authenticates once if the token has expired.
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

    // Aquarea sometimes answers 200 + an application-level error message.
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

  /** Call through the "transfer" API (Aquarea's internal proxy). */
  _transfer(apiName, requestMethod, bodyParam) {
    const payload = { apiName, requestMethod };
    if (bodyParam !== undefined) payload.bodyParam = bodyParam;
    return this._request('POST', AQUAREA_TRANSFER, { json: payload });
  }

  /**
   * Direct write to `remote/v1/api/devices/{guid}`, `status[]` form.
   *
   * Some commands (forceDHW, forceHeater, specialStatus, general power off) do
   * not go through the "transfer" proxy but through this endpoint, with the
   * `deviceGuid` field repeated inside the status element. Shape aligned with
   * aioaquarea (post_device_force_dhw / _force_heater / _set_special_status).
   *
   * @param {string} deviceId
   * @param {object} patch  Status fields to write (excluding deviceGuid).
   */
  _directStatus(deviceId, patch) {
    return this._request('POST', `${AQUAREA_SERVICE_DEVICES}/${encodeURIComponent(deviceId)}`, {
      headers: {
        'content-type': 'application/json',
        referer: `${BASE_PATH_ACC}/${AQUAREA_A2W_STATUS_DISPLAY}`,
      },
      json: { status: [Object.assign({ deviceGuid: deviceId }, patch)] },
    });
  }

  // =========================================================================
  //  High-level API
  // =========================================================================

  /**
   * Lists the devices linked to the Comfort Cloud account.
   * Type 2 is an Aquarea heat pump. Other types are exposed experimentally, so
   * that their structure can be collected through the diagnostics.
   * @returns {Promise<Array<{id:string,name:string,longId:string,deviceType:string,hasTank:boolean,raw:object}>>}
   */
  async getDevices() {
    const data = await this._request('GET', 'device/group');
    const devices = [];
    const groups = (data && data.groupList) || [];
    for (const group of groups) {
      const list = group.deviceList || group.deviceIdList || [];
      for (const d of list) {
        if (!d || d.deviceGuid == null) continue;
        const id = String(d.deviceGuid);
        const deviceType = d.deviceType == null ? 'unknown' : String(d.deviceType);
        if (deviceType !== '2') {
          this.log(`AquareaClient: experimental Comfort Cloud device discovered (type=${deviceType}): ${JSON.stringify(d)}`);
        }
        devices.push({
          id,
          longId: id,
          name: d.deviceName || (deviceType === '2' ? 'Aquarea Heat Pump' : `Comfort Cloud device (type ${deviceType})`),
          deviceType,
          hasTank: Boolean(d.tankStatus && Object.keys(d.tankStatus).length),
          raw: d,
        });
      }
    }
    return devices;
  }

  /**
   * Fetches today's energy consumption (kWh), broken down by hour.
   * Endpoint: POST remote/v1/app/common/transfer -> /remote/v1/api/consumption
   * dataMode 0 = Day (hourly breakdown).
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
   * Fetches the state of a heat pump (temperatures, setpoint, mode, DHW).
   * @param {string} deviceId  The deviceGuid (long id).
   */
  async getDeviceData(deviceId, { diagnostic = false, deviceType = '2' } = {}) {
    let data;
    try {
      data = await this._transfer(`/remote/v1/api/devices?gwid=${encodeURIComponent(deviceId)}&deviceDirect=1`, 'GET');
    } catch (err) {
      this.log(`getDeviceData live failed (${err.message}), fallback cached`);
      data = await this._transfer(`/remote/v1/api/devices?gwid=${encodeURIComponent(deviceId)}&deviceDirect=0`, 'GET');
    }

    if (diagnostic) {
      this.log(`AquareaClient: experimental device status (type=${deviceType}, gwid=${deviceId}): ${JSON.stringify(data)}`);
    }

    const status = (data && data.status) || {};
    const zone = Array.isArray(status.zoneStatus) && status.zoneStatus.length ? status.zoneStatus[0] : {};
    const tank = status.tankStatus && typeof status.tankStatus === 'object'
      && Object.keys(status.tankStatus).length ? status.tankStatus : null;

    const opMode = status.operationMode;
    let thermostatMode = opMode === OP_MODE_OFF ? 'off' : (EXT_MODE_TO_HOMEY[opMode] || 'auto');

    // "Heating only" vs "Heating + DHW", or "Cooling only" vs "Cooling + DHW":
    // look at the DHW permission.
    // tankStatus.operationStatus: 1 = tank allowed, 0 = disabled.
    if (tank && this._num(tank.operationStatus) === 1) {
      if (this._num(zone.operationStatus) !== 1) thermostatMode = 'dhw';
      else if (thermostatMode === 'heat') thermostatMode = 'heat_tank';
      else if (thermostatMode === 'cool') thermostatMode = 'cool_tank';
    }

    // The zone setpoint can be either:
    //  - an absolute water temperature (heatMax > ~15), or
    //  - a heating curve offset (heatMin < 0, typical range -5..+5).
    // We expose the information so the caller can pick the right setting.
    // Real operating direction. null = undetermined (unit off): the caller
    // then keeps the last known value rather than arbitrarily falling back to
    // "heating".
    let isCooling = null;
    if (EXT_MODE_COOLING.includes(opMode)) isCooling = true;
    else if (EXT_MODE_HEATING.includes(opMode)) isCooling = false;

    // What the unit is doing, with the direction when it can be determined:
    // 'active' (hot or cold, direction unknown) becomes 'heating' / 'cooling'.
    let direction = this._enum(DIRECTIONS, status.direction);
    if (direction === 'active' && isCooling !== null) {
      direction = isCooling ? 'cooling' : 'heating';
    }

    const zoneHeatMin = this._num(zone.heatMin);
    const zoneHeatMax = this._num(zone.heatMax);
    const zoneIsCurveOffset = zoneHeatMin != null && zoneHeatMin < 0;

    return {
      // --- DHW tank ---
      hasTank: Boolean(tank),
      tankTemperature: tank ? this._temp(tank.temperatureNow) : null,
      tankTargetTemperature: tank ? this._temp(tank.heatSet) : null,
      tankHeatMin: tank ? this._num(tank.heatMin) : null,
      tankHeatMax: tank ? this._num(tank.heatMax) : null,
      tankOn: tank ? this._num(tank.operationStatus) === 1 : null,

      // --- Zone (heating) ---
      zoneId: zone.zoneId !== undefined ? zone.zoneId : null,
      zoneName: zone.zoneName || null,
      zoneTemperature: this._temp(zone.temperatureNow),
      zoneHeatSet: this._temp(zone.heatSet),
      zoneHeatMin,
      zoneHeatMax,
      zoneIsCurveOffset,
      zoneOn: this._num(zone.operationStatus) === 1,

      // --- Zone: secondary setpoints (same units as heatSet) ---
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
      // true => temperatureNow is a water temperature, not a room one.
      zoneSensorIsWater: this._num(zone.zoneSensor) === ZONE_SENSOR_WATER,

      // --- System: live measurements ---
      outdoorTemperature: this._temp(status.outdoorNow),
      waterPressure: this._num(status.waterPressure),
      // pumpDuty is an on/off boolean on the cloud side (aioaquarea PumpDuty),
      // not a flow rate or a percentage.
      pumpRunning: this._flag(status.pumpDuty),
      operationMode: opMode,
      thermostatMode,
      // true = cooling, false = heating, null = undetermined. Also set in 'auto'.
      isCooling,

      // --- System: live boolean states ---
      // These fields are 0/1 in the API; we expose them as booleans.
      defrosting: this._flag(status.deiceStatus),
      forceDhw: this._flag(status.forceDHW),
      forceHeater: this._flag(status.forceHeater),
      holidayMode: this._flag(status.holidayTimer),
      bivalentActive: this._flag(status.bivalentActual),
      electricAnode: this._flag(status.electricAnode),

      // --- System: multi-level modes ---
      quietMode: this._enum(QUIET_LEVELS, status.quietMode),
      quietModeLevel: this._num(status.quietMode),
      powerfulMode: this._enum(POWERFUL_LEVELS, status.powerful),
      powerfulModeLevel: this._num(status.powerful),
      // Active Eco/Comfort preset (not a fault code).
      specialStatus: this._enum(SPECIAL_STATUS, status.specialStatus),
      // What the unit is currently doing:
      // idle / heating / cooling / hot water.
      direction,

      // --- Fixed configuration of the installation (for the settings) ---
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

      // All zones as reported (useful for a future multi-zone support).
      zones: Array.isArray(status.zoneStatus) ? status.zoneStatus : [],

      // --- Compat: "main" setpoint = tank when present, otherwise zone ---
      measureTemperature: tank ? this._num(tank.temperatureNow) : this._num(zone.temperatureNow),
      targetTemperature: tank ? this._num(tank.heatSet) : this._num(zone.heatSet),

      raw: data,
    };
  }

  /**
   * Sets the "main" setpoint (whole °C):
   *  - if a DHW tank is present -> tank setpoint (absolute temperature);
   *  - otherwise -> setpoint of the main zone.
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
   * Sets the DHW tank setpoint (absolute water temperature, whole °C).
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
   * Sets the setpoint / heating curve offset of a zone.
   * @param {string} deviceId
   * @param {number} value  Absolute temperature OR offset (-5..+5), per zone.
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
   * Sets the operating mode.
   * @param {string} deviceId
   * @param {'auto'|'heat'|'heat_tank'|'dhw'|'cool'|'cool_tank'|'off'} mode
   *   - 'heat'      : heating only (DHW tank disabled).
   *   - 'heat_tank' : heating + hot water (DHW tank allowed).
   *   - 'dhw'       : hot water only (zone disabled, DHW tank allowed).
   *   - 'cool'      : cooling only (DHW tank disabled).
   *   - 'cool_tank' : cooling + hot water (DHW tank allowed).
   *   - 'auto'      : does not touch the tank state (preserved).
   */
  async setMode(deviceId, mode) {
    if (mode === 'off') {
      // Power off: direct operationStatus=0 command.
      return this._directStatus(deviceId, { operationStatus: 0 });
    }

    const updateMode = HOMEY_TO_UPDATE_MODE[mode];
    if (updateMode === undefined) throw new AquareaError(`setMode: unknown mode "${mode}"`);

    // Power on + mode change, preserving zone/tank.
    const current = await this.getDeviceData(deviceId);
    if (mode === 'dhw' && !current.hasTank) {
      throw new AquareaError('setMode: DHW-only mode requires a hot-water tank');
    }
    const zoneId = current.zoneId != null ? current.zoneId : 1;

    const bodyParam = {
      gwid: deviceId,
      operationMode: updateMode,
      operationStatus: 1,
      zoneStatus: [{ zoneId, operationStatus: mode === 'dhw' ? 0 : 1 }],
    };

    // DHW permission driven by the chosen mode:
    //  - 'heat_tank' / 'cool_tank' => tank allowed  (operationStatus = 1)
    //  - 'dhw'                     => tank allowed and zone disabled
    //  - 'heat' / 'cool'           => tank disabled (operationStatus = 0)
    //  - 'auto'                    => tank left untouched (state preserved)
    if (current.hasTank) {
      if (mode === 'heat_tank' || mode === 'cool_tank' || mode === 'dhw') bodyParam.tankStatus = { operationStatus: 1 };
      else if (mode === 'heat' || mode === 'cool') bodyParam.tankStatus = { operationStatus: 0 };
    }

    return this._transfer('/remote/v1/api/devices', 'POST', bodyParam);
  }

  /**
   * Turns the DHW tank on/off (independently of the zone).
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
   * Turns a heating zone on/off (independently of the tank).
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

  /** Sets the quiet mode level. */
  async setQuietMode(deviceId, mode) {
    const quietMode = QUIET_LEVEL_CODES[mode];
    if (quietMode === undefined) throw new AquareaError(`setQuietMode: unknown mode "${mode}"`);
    return this._transfer('/remote/v1/api/devices', 'POST', {
      gwid: deviceId,
      quietMode,
    });
  }

  /** Enables powerful mode for the requested duration, or disables it. */
  async setPowerfulMode(deviceId, mode) {
    const powerfulRequest = POWERFUL_LEVEL_CODES[mode];
    if (powerfulRequest === undefined) throw new AquareaError(`setPowerfulMode: unknown mode "${mode}"`);
    return this._transfer('/remote/v1/api/devices', 'POST', {
      gwid: deviceId,
      powerfulRequest,
    });
  }

  /** Enables or disables holiday mode. */
  async setHolidayMode(deviceId, on) {
    return this._transfer('/remote/v1/api/devices', 'POST', {
      gwid: deviceId,
      holidayTimer: on ? 1 : 0,
    });
  }

  /**
   * Sets the cooling setpoint of a zone (coolSet).
   *
   * Same unit as the zone's heatSet: absolute water temperature, or heating
   * curve offset if the zone is driven that way.
   * @param {string} deviceId
   * @param {number} value
   * @param {number} [zoneId=1]
   */
  async setZoneCoolTemperature(deviceId, value, zoneId = 1) {
    const v = Math.round(Number(value));
    if (Number.isNaN(v)) throw new AquareaError('setZoneCoolTemperature: invalid value');
    return this._transfer('/remote/v1/api/devices', 'POST', {
      gwid: deviceId,
      zoneStatus: [{ zoneId, coolSet: v }],
    });
  }

  /**
   * General power on/off of the unit, without touching the operating mode.
   * Unlike setMode('off') / setMode('heat'), powering on resets neither the
   * zone nor the DHW permission: the unit resumes on its last mode.
   * @param {string} deviceId
   * @param {boolean} on
   */
  async setOperationStatus(deviceId, on) {
    return this._directStatus(deviceId, { operationStatus: on ? 1 : 0 });
  }

  /**
   * Forces a domestic hot water cycle (the "forced hot water" button).
   *
   * ⚠️  The heat pump clears the forcing by itself once the tank setpoint is
   *     reached: this is a pulse, not a permanent switch.
   * @param {string} deviceId
   * @param {boolean} on
   */
  async setForceDhw(deviceId, on) {
    return this._directStatus(deviceId, { forceDHW: on ? 1 : 0 });
  }

  /**
   * Forces the electric backup heater.
   *
   * ⚠️  Direct electric consumption, with no COP: use it only occasionally
   *     (severe cold, anti-legionella temperature rise).
   * @param {string} deviceId
   * @param {boolean} on
   */
  async setForceHeater(deviceId, on) {
    return this._directStatus(deviceId, { forceHeater: on ? 1 : 0 });
  }

  /**
   * Triggers a manual defrost.
   * @param {string} deviceId
   */
  async requestDefrost(deviceId) {
    return this._directStatus(deviceId, { forcedefrost: 1 });
  }

  /**
   * Applies the Eco / Comfort / Normal preset.
   *
   * The offsets that get applied (ecoHeat, comfortHeat, ...) are the ones
   * configured on the remote control; the API only selects which one is active.
   * @param {string} deviceId
   * @param {'normal'|'eco'|'comfort'} status
   */
  async setSpecialStatus(deviceId, status) {
    const specialStatus = SPECIAL_STATUS_CODES[status];
    if (specialStatus === undefined) throw new AquareaError(`setSpecialStatus: unknown status "${status}"`);
    return this._directStatus(deviceId, { specialStatus });
  }

  // =========================================================================
  //  Helpers
  // =========================================================================

  _num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }

  /** 0/1 API field -> boolean (null when absent, so nothing gets overwritten). */
  _flag(v) {
    const n = this._num(v);
    return n === null ? null : n !== 0;
  }

  /**
   * Numeric value -> enum label.
   *  - missing field           -> null   (nothing is written, state unknown)
   *  - present but unseen code -> 'unknown'
   * Returning null in the second case would leave the tile showing the
   * previous value forever, which is misleading.
   */
  _enum(table, v) {
    const n = this._num(v);
    if (n === null) return null;
    if (table[n] !== undefined) return table[n];
    this.log(`AquareaClient: unmapped enum value ${n} (known: ${Object.keys(table).join(',')})`);
    return 'unknown';
  }

  /** Temperature, filtering out the "missing probe" sentinel (126). */
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
