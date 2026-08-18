'use strict';

const fetch  = require('node-fetch');
const http2  = require('http2');

const BASE_URL   = 'https://api.aquarea-home.solutiontech.tech/api/';
const GRPC_HOST  = 'grpc.aquarea-home.solutiontech.tech';
const GRPC_PORT  = 443;
const GRPC_RETRY_DELAYS = [500, 1500];

// FancoilValueType
const VALUE_TYPE = {
  POWER_STATE:    1,
  SETPOINT:       2,
  OPERATION_MODE: 3,
  FAN_SPEED:      4,
  FLAP:           5,
};

// FancoilOperationMode
const OPERATION_MODE = {
  AUTO: 0,
  HEAT: 1,
  COOL: 2,
};

// FancoilFanSpeed
const FAN_SPEED = {
  AUTO:  0,
  NIGHT: 1,
  MAX:   2,
};

// ─── Encodage protobuf minimal ────────────────────────────────────────────────
// SetDeviceValueRequest { int32 type = 1; int32 value = 2; }
// Encodage varint protobuf : field_number << 3 | wire_type(0=varint)

function encodeVarint(n) {
  const bytes = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}

function encodeSetDeviceValueRequest(type, value) {
  // field 1 (type): tag = (1 << 3) | 0 = 0x08
  // field 2 (value): tag = (2 << 3) | 0 = 0x10
  const tagType  = encodeVarint(0x08);
  const valType  = encodeVarint(type);
  const tagValue = encodeVarint(0x10);
  const valValue = encodeVarint(value);
  return Buffer.concat([tagType, valType, tagValue, valValue]);
}

// Encode un message gRPC : 1 byte flag (0=non-compressé) + 4 bytes big-endian length + payload
function encodeGrpcFrame(payload) {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0; // non-compressé
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

// ─── Décodage protobuf minimal ────────────────────────────────────────────────
// Décode un varint depuis buf à partir de l'offset, retourne { value, offset }
function decodeVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  while (offset < buf.length) {
    const byte = buf[offset++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result >>> 0, offset };
}

// Réinterprète un uint32 en int32 signé (pour les champs protobuf int32 négatifs)
function toInt32(u) {
  return u | 0;
}

/**
 * Décode GetDeviceStatusResponse (protobuf) pour extraire FancoilStatus.
 *
 * Structure protobuf (extraite de ControlsOuterClass.java) :
 *   GetDeviceStatusResponse : field 2 = MainStatus (message)
 *   MainStatus               : field 6 = FancoilStatus (message)
 *   FancoilStatus            : field 1 = calendar (message)
 *                              field 2 = powerState (bool)
 *                              field 3 = temperatureSetpoint (SetpointStatus message)
 *                              field 4 = roomTemperature (int32, en dixièmes de °C)
 *                              field 5 = operationMode (int32)
 *                              field 6 = fanSpeed (int32)
 *                              field 7 = hasFlap (bool)
 *                              field 8 = flap (int32)
 *   SetpointStatus           : field 1 = value (int32, en dixièmes de °C)
 *                              field 2 = min, field 3 = max, field 4 = step, field 5 = offset
 */
function decodeGetDeviceStatusResponse(buf) {
  function parseMessage(b) {
    const fields = {};
    let i = 0;
    while (i < b.length) {
      if (i >= b.length) break;
      const tag = decodeVarint(b, i);
      if (tag.offset >= b.length && tag.value === 0) break;
      i = tag.offset;
      const fieldNum = tag.value >>> 3;
      const wireType = tag.value & 0x07;
      if (wireType === 0) { // varint
        const v = decodeVarint(b, i);
        i = v.offset;
        if (!fields[fieldNum]) fields[fieldNum] = [];
        fields[fieldNum].push(v.value);
      } else if (wireType === 2) { // length-delimited
        const len = decodeVarint(b, i);
        i = len.offset;
        const sub = b.slice(i, i + len.value);
        i += len.value;
        if (!fields[fieldNum]) fields[fieldNum] = [];
        fields[fieldNum].push(sub);
      } else if (wireType === 1) { // 64-bit
        i += 8;
      } else if (wireType === 5) { // 32-bit
        i += 4;
      } else {
        break;
      }
    }
    return fields;
  }

  // GetDeviceStatusResponse : field 2 = DeviceStatus (message)
  const root = parseMessage(buf);

  const deviceStatusBufs = root[2];
  if (!deviceStatusBufs || !deviceStatusBufs.length) return {};

  // DeviceStatus : field 5 = FancoilStatus (message)
  const deviceStatus = parseMessage(deviceStatusBufs[0]);
  const fancoilBufs = deviceStatus[5];
  if (!fancoilBufs || !fancoilBufs.length) return {};

  const fancoilFields = parseMessage(fancoilBufs[0]);

  // FancoilStatus (d'après analyse du payload réel) :
  //   field 2 = powerState (varint bool)
  //   field 4 = SetpointStatus (message) : field 1=value, field 2=min, field 3=max, field 4=step (dixièmes °C)
  //   field 7 = hasFlap (bool)
  //   field 9 = roomTemperature (varint, en dixièmes de °C)
  //   field 11 = operationMode ou fanSpeed

  let setpoint = null;
  let setpointMin = null;
  let setpointMax = null;
  let setpointStep = null;
  if (fancoilFields[4] && Buffer.isBuffer(fancoilFields[4][0])) {
    const spFields = parseMessage(fancoilFields[4][0]);
    if (spFields[1] && spFields[1][0] !== undefined) setpoint     = toInt32(spFields[1][0]) / 10.0;
    if (spFields[2] && spFields[2][0] !== undefined) setpointMin  = toInt32(spFields[2][0]) / 10.0;
    if (spFields[3] && spFields[3][0] !== undefined) setpointMax  = toInt32(spFields[3][0]) / 10.0;
    if (spFields[4] && spFields[4][0] !== undefined) setpointStep = toInt32(spFields[4][0]) / 10.0;
  }

  // roomTemperature : field 9, en dixièmes de °C → diviser par 10
  let roomTemp = null;
  if (fancoilFields[9] && fancoilFields[9][0] !== undefined) {
    roomTemp = toInt32(fancoilFields[9][0]) / 10.0;
  }

  return {
    powerState:      !!(fancoilFields[2] && fancoilFields[2][0]),
    roomTemperature: roomTemp,
    setpoint:        setpoint,
    setpointMin:     setpointMin,
    setpointMax:     setpointMax,
    setpointStep:    setpointStep,
    operationMode:   fancoilFields[5] ? fancoilFields[5][0] : null,
    fanSpeed:        fancoilFields[6] ? fancoilFields[6][0] : null,
    flap:            fancoilFields[8] ? fancoilFields[8][0] : null,
  };
}

/**
 * Client pour l'API Aquarea Home (Solution Tech Srl).
 *
 * - Authentification REST : POST /users/login { email, password } → { token }
 * - Lecture état : GET /devices/{mac} via REST
 * - Commandes : gRPC device_controls.Controls/SetDeviceValue via HTTP/2 natif
 *   (pas de dépendance @grpc/grpc-js — encodage protobuf minimal intégré)
 */
class AquareaHomeClient {

  constructor({ email, password, log, error } = {}) {
    this.email    = email;
    this.password = password;
    this.log      = log   || (() => {});
    this.error    = error || (() => {});
    this.token    = null;
  }

  // ─── Auth ────────────────────────────────────────────────────────────────

  async login() {
    const res = await this._post('users/login', { email: this.email, password: this.password }, false);
    if (!res.token) throw new Error('Login failed: no token in response');
    this.token = res.token;
    this.log('AquareaHomeClient: logged in');
    return res;
  }

  exportSession() {
    return { token: this.token };
  }

  importSession(session) {
    if (session && session.token) {
      this.token = session.token;
    }
  }

  // ─── Homes & Devices ─────────────────────────────────────────────────────

  async getHomes() {
    return this._get('homes');
  }

  /**
   * Retourne la liste de tous les appareils de type fancoil sur tous les homes.
   * Chaque appareil a : { macAddress, name, deviceType, roomId, homeId, homeName }
   */
  async getDevices() {
    const homes = await this.getHomes();
    const devices = [];

    for (const home of homes) {
      const rooms = home.rooms || [];
      for (const room of rooms) {
        const roomDevices = room.devices || [];
        for (const device of roomDevices) {
          devices.push({
            macAddress: device.macAddress,
            name:       device.name || room.name || home.name,
            deviceType: device.deviceType,
            roomId:     room.id,
            homeId:     home.id,
            homeName:   home.name,
            roomName:   room.name,
          });
        }
      }
    }

    return devices;
  }

  async getDeviceInfo(macAddress) {
    return this._get(`devices/${macAddress}`);
  }

  // ─── Commandes ───────────────────────────────────────────────────────────

  async setPower(macAddress, on) {
    return this._sendOperation(macAddress, VALUE_TYPE.POWER_STATE, on ? 1 : 0);
  }

  async setTemperature(macAddress, celsius) {
    // La consigne est envoyée en dixièmes de °C (ex: 210 pour 21°C)
    return this._sendOperation(macAddress, VALUE_TYPE.SETPOINT, Math.round(celsius * 10));
  }

  async setOperationMode(macAddress, mode) {
    // mode : 'auto' | 'heat' | 'cool'
    const modeMap = { auto: OPERATION_MODE.AUTO, heat: OPERATION_MODE.HEAT, cool: OPERATION_MODE.COOL };
    const value = modeMap[mode];
    if (value === undefined) throw new Error(`Unknown operation mode: ${mode}`);
    return this._sendOperation(macAddress, VALUE_TYPE.OPERATION_MODE, value);
  }

  async setFanSpeed(macAddress, speed) {
    // speed : 'auto' | 'night' | 'max'
    const speedMap = { auto: FAN_SPEED.AUTO, night: FAN_SPEED.NIGHT, max: FAN_SPEED.MAX };
    const value = speedMap[speed];
    if (value === undefined) throw new Error(`Unknown fan speed: ${speed}`);
    return this._sendOperation(macAddress, VALUE_TYPE.FAN_SPEED, value);
  }

  async setFlap(macAddress, open) {
    return this._sendOperation(macAddress, VALUE_TYPE.FLAP, open ? 1 : 0);
  }

  // ─── Interne ─────────────────────────────────────────────────────────────

  /**
   * Envoie une commande via gRPC HTTP/2 natif.
   * Service : device_controls.Controls / SetDeviceValue
   * Headers gRPC : authorization: Bearer <token>, mac_address: <mac>
   */
  async _sendOperation(macAddress, type, value) {
    const payload = encodeSetDeviceValueRequest(type, value);
    const frame   = encodeGrpcFrame(payload);

    return this._withGrpcRetry(() => this._sendOperationOnce(macAddress, frame));
  }

  async _sendOperationOnce(macAddress, frame) {

    return new Promise((resolve, reject) => {
      const client = http2.connect(`https://${GRPC_HOST}:${GRPC_PORT}`);

      client.on('error', err => { client.destroy(); reject(err); });

      const req = client.request({
        ':method':      'POST',
        ':path':        '/device_controls.Controls/SetDeviceValue',
        ':scheme':      'https',
        ':authority':   GRPC_HOST,
        'content-type': 'application/grpc',
        'te':           'trailers',
        'authorization': `Bearer ${this.token}`,
        'mac_address':   macAddress,
      });

      req.on('error', err => { client.destroy(); reject(err); });

      req.on('response', headers => {
        const status = headers[':status'];
        if (status !== 200) {
          client.destroy();
          reject(new Error(`gRPC HTTP status ${status}`));
        }
      });

      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));

      req.on('trailers', trailers => {
        const grpcStatus = trailers['grpc-status'];
        if (grpcStatus !== undefined && String(grpcStatus) !== '0') {
          client.destroy();
          reject(new Error(`gRPC status ${grpcStatus}: ${trailers['grpc-message'] || ''}`));
        }
      });

      req.on('end', () => {
        client.close();
        resolve();
      });

      req.end(frame);
    });
  }

  /**
   * Lit l'état de l'appareil via gRPC GetDeviceStatus.
   * Retourne un objet { powerState, roomTemperature, setpoint, operationMode, fanSpeed, flap }
   */
  async getDeviceStatus(macAddress) {
    return this._withGrpcRetry(() => this._getDeviceStatusOnce(macAddress));
  }

  async _getDeviceStatusOnce(macAddress) {
    const frame = encodeGrpcFrame(Buffer.alloc(0)); // Empty request

    return new Promise((resolve, reject) => {
      const client = http2.connect(`https://${GRPC_HOST}:${GRPC_PORT}`);
      client.on('error', err => { client.destroy(); reject(err); });

      const req = client.request({
        ':method':       'POST',
        ':path':         '/device_controls.Controls/GetDeviceStatus',
        ':scheme':       'https',
        ':authority':    GRPC_HOST,
        'content-type':  'application/grpc',
        'te':            'trailers',
        'authorization': `Bearer ${this.token}`,
        'mac_address':   macAddress,
      });

      req.on('error', err => { client.destroy(); reject(err); });

      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));

      req.on('trailers', trailers => {
        const grpcStatus = trailers['grpc-status'];
        if (grpcStatus !== undefined && String(grpcStatus) !== '0') {
          client.destroy();
          reject(new Error(`gRPC status ${grpcStatus}: ${trailers['grpc-message'] || ''}`));
        }
      });

      req.on('end', () => {
        client.close();
        try {
          const buf = Buffer.concat(chunks);
          // Décoder le frame gRPC : 1 byte flag + 4 bytes length + payload
          if (buf.length < 5) return resolve({});
          const payloadLen = buf.readUInt32BE(1);
          const payload = buf.slice(5, 5 + payloadLen);
          const decoded = decodeGetDeviceStatusResponse(payload);
          // Log lisible de la réponse Aquarea Home
          const modeLabels = { 0: 'auto', 1: 'heat', 2: 'cool', 3: 'fan', 4: 'dry' };
          const fanLabels  = { 0: 'auto', 1: 'night', 2: 'low', 3: 'medium', 4: 'high', 5: 'max' };
          this.log('[AquareaHome] État convecteur :',
            `power=${decoded.powerState ? 'ON' : 'OFF'}`,
            `| temp_ambiante=${decoded.roomTemperature !== null ? decoded.roomTemperature + '°C' : 'N/A'}`,
            `| consigne=${decoded.setpoint !== null ? decoded.setpoint + '°C' : 'N/A'}`,
            `  (min=${decoded.setpointMin}°C max=${decoded.setpointMax}°C pas=${decoded.setpointStep}°C)`,
            `| mode=${modeLabels[decoded.operationMode] || decoded.operationMode}`,
            `| vitesse_ventilateur=${fanLabels[decoded.fanSpeed] || decoded.fanSpeed}`,
            `| volet=${decoded.flap}`
          );
          resolve(decoded);
        } catch (e) {
          reject(e);
        }
      });

      req.end(frame);
    });
  }

  isTransientNetworkError(err) {
    let current = err;
    while (current) {
      if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
        'ERR_HTTP2_STREAM_CANCEL', 'ERR_HTTP2_STREAM_ERROR'].includes(current.code)) {
        return true;
      }

      const message = String(current.message || current);
      if (/ENOTFOUND|EAI_AGAIN|pending stream has been canceled|socket hang up|timed?\s*out/i.test(message)) {
        return true;
      }
      current = current.cause;
    }
    return false;
  }

  async _withGrpcRetry(operation) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (err) {
        if (!this.isTransientNetworkError(err) || attempt >= GRPC_RETRY_DELAYS.length) {
          throw err;
        }

        const delay = GRPC_RETRY_DELAYS[attempt];
        this.log(`AquareaHomeClient: temporary gRPC error, retry ${attempt + 1}/${GRPC_RETRY_DELAYS.length} in ${delay} ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async _get(path, auth = true) {
    return this._request('GET', path, null, auth);
  }

  async _post(path, body, auth = true) {
    return this._request('POST', path, body, auth);
  }

  async _request(method, path, body = null, auth = true) {
    const url = BASE_URL + path;
    const headers = { 'Content-Type': 'application/json' };

    if (auth && this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const opts = { method, headers };
    if (body !== null) opts.body = JSON.stringify(body);

    this.log(`→ ${method} ${url}`);
    const res = await fetch(url, opts);

    // Token expiré → re-login automatique
    if (res.status === 401 && auth) {
      this.log('Token expired, re-logging in...');
      await this.login();
      headers['Authorization'] = `Bearer ${this.token}`;
      const res2 = await fetch(url, { ...opts, headers });
      return this._parseResponse(res2);
    }

    return this._parseResponse(res);
  }

  async _parseResponse(res) {
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (e) {
      return text;
    }
  }

}

AquareaHomeClient.VALUE_TYPE      = VALUE_TYPE;
AquareaHomeClient.OPERATION_MODE  = OPERATION_MODE;
AquareaHomeClient.FAN_SPEED       = FAN_SPEED;

module.exports = AquareaHomeClient;
