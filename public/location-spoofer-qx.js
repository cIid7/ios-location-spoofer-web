/**
 * iOS Location Spoofer - Quantumult X / 圈叉专用版
 *
 * 适配 Quantumult X 的 binary response API：
 *   $response.bodyBytes -> ArrayBuffer
 *   $done({ bodyBytes: ArrayBuffer })
 *
 * 坐标从 configUrl 动态读取。
 */

(function () {
  "use strict";

  var DEFAULT_CONFIG = {
    enabled: true,
    latitude: 37.3349,
    longitude: -122.00902,
    horizontalAccuracy: 39,
    verticalAccuracy: 1000,
    altitude: 530,
    unknownValue4: 3,
    motionActivityType: 63,
    motionActivityConfidence: 467,
    failOpen: true,
    debug: true
  };

  var APPLE_WLOC_PREFIX = new Uint8Array([
    0x00, 0x01, 0x00, 0x00,
    0x00, 0x01, 0x00, 0x00
  ]);

  var APPLE_WLOC_MARKER = new Uint8Array([
    0x00, 0x00, 0x00, 0x01,
    0x00, 0x00
  ]);

  var CELL_RESPONSE_FIELDS = {
    22: true,
    24: true
  };

  function log(msg) {
    try {
      console.log("[wloc-qx] " + msg);
    } catch (e) {}
  }

  function concatBytes(parts) {
    var total = 0;
    var i;

    for (i = 0; i < parts.length; i++) {
      total += parts[i].length;
    }

    var out = new Uint8Array(total);
    var offset = 0;

    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], offset);
      offset += parts[i].length;
    }

    return out;
  }

  function hexPreview(bytes, limit) {
    if (!bytes) return "<none>";

    var out = [];
    var max = Math.min(bytes.length, limit || 32);

    for (var i = 0; i < max; i++) {
      out.push(("0" + bytes[i].toString(16)).slice(-2));
    }

    return out.join("");
  }

  function encodeVarintUnsigned(value) {
    var v = typeof value === "bigint" ? value : BigInt(value);

    if (v < 0n) {
      throw new Error("negative unsigned varint");
    }

    var out = [];

    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }

    out.push(Number(v));

    return new Uint8Array(out);
  }

  function encodeVarintSignedInt64(value) {
    var v = typeof value === "bigint"
      ? value
      : BigInt(Math.trunc(value));

    if (v < 0n) {
      v = BigInt.asUintN(64, v);
    }

    return encodeVarintUnsigned(v);
  }

  function decodeVarint(bytes, offset) {
    var result = 0n;
    var shift = 0n;
    var current = offset;

    while (current < bytes.length) {
      var b = bytes[current++];

      result |= BigInt(b & 0x7f) << shift;

      if ((b & 0x80) === 0) {
        return {
          value: result,
          offset: current
        };
      }

      shift += 7n;

      if (shift > 70n) {
        throw new Error("varint too long");
      }
    }

    throw new Error("unterminated varint");
  }

  function makeKey(fieldNumber, wireType) {
    return encodeVarintUnsigned(
      (BigInt(fieldNumber) << 3n) | BigInt(wireType)
    );
  }

  function makeVarintField(fieldNumber, value) {
    return concatBytes([
      makeKey(fieldNumber, 0),
      encodeVarintSignedInt64(value)
    ]);
  }

  function makeLengthDelimitedField(fieldNumber, payload) {
    return concatBytes([
      makeKey(fieldNumber, 2),
      encodeVarintUnsigned(payload.length),
      payload
    ]);
  }

  function parseFields(bytes) {
    var fields = [];
    var offset = 0;

    while (offset < bytes.length) {
      var keyStart = offset;
      var key = decodeVarint(bytes, offset);

      offset = key.offset;

      var fieldNumber = Number(key.value >> 3n);
      var wireType = Number(key.value & 0x7n);

      if (fieldNumber === 0) {
        throw new Error("protobuf field number 0");
      }

      var valueStart = offset;
      var valueEnd;

      if (wireType === 0) {
        valueEnd = decodeVarint(bytes, offset).offset;
      } else if (wireType === 1) {
        valueEnd = offset + 8;
      } else if (wireType === 2) {
        var lenInfo = decodeVarint(bytes, offset);
        valueStart = lenInfo.offset;
        valueEnd = valueStart + Number(lenInfo.value);
      } else if (wireType === 5) {
        valueEnd = offset + 4;
      } else {
        throw new Error("unsupported protobuf wire type: " + wireType);
      }

      if (valueEnd > bytes.length) {
        throw new Error("protobuf field exceeds buffer");
      }

      fields.push({
        fieldNumber: fieldNumber,
        wireType: wireType,
        raw: bytes.slice(keyStart, valueEnd),
        valueBytes: bytes.slice(valueStart, valueEnd)
      });

      offset = valueEnd;
    }

    return fields;
  }

  function firstFieldByNumber(fields, fieldNumber) {
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].fieldNumber === fieldNumber) {
        return fields[i];
      }
    }

    return null;
  }

  function signedVarintFieldValue(field) {
    if (!field || field.wireType !== 0) {
      return null;
    }

    return BigInt.asIntN(
      64,
      decodeVarint(field.valueBytes, 0).value
    );
  }

  function coordToInt(value) {
    return Math.trunc(Number(value) * 100000000);
  }

  function patchLocation(locationPayload, config) {
    var fields = parseFields(locationPayload);
    var parts = [];

    var hasLat = false;
    var hasLon = false;

    for (var i = 0; i < fields.length; i++) {
      if (fields[i].fieldNumber === 1 && fields[i].wireType === 0) {
        hasLat = true;
      }

      if (fields[i].fieldNumber === 2 && fields[i].wireType === 0) {
        hasLon = true;
      }
    }

    /*
     * 必须已经存在经纬度字段才修改。
     * 不凭空创建 Location，降低 iOS 判定响应非法的概率。
     */
    if (!hasLat || !hasLon) {
      return locationPayload;
    }

    for (i = 0; i < fields.length; i++) {
      var field = fields[i];

      if (field.fieldNumber === 1 && field.wireType === 0) {
        parts.push(
          makeVarintField(
            1,
            coordToInt(config.latitude)
          )
        );
      } else if (field.fieldNumber === 2 && field.wireType === 0) {
        parts.push(
          makeVarintField(
            2,
            coordToInt(config.longitude)
          )
        );
      } else if (field.fieldNumber === 3 && field.wireType === 0) {
        parts.push(
          makeVarintField(
            3,
            config.horizontalAccuracy
          )
        );
      } else {
        parts.push(field.raw);
      }
    }

    return concatBytes(parts);
  }

  function patchWifiDevice(wifiPayload, config) {
    var fields = parseFields(wifiPayload);
    var parts = [];

    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];

      if (field.fieldNumber === 2 && field.wireType === 2) {
        parts.push(
          makeLengthDelimitedField(
            2,
            patchLocation(field.valueBytes, config)
          )
        );
      } else {
        parts.push(field.raw);
      }
    }

    return concatBytes(parts);
  }

  function patchCellTower(cellPayload, config) {
    var fields = parseFields(cellPayload);
    var parts = [];

    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];

      if (field.fieldNumber === 5 && field.wireType === 2) {
        parts.push(
          makeLengthDelimitedField(
            5,
            patchLocation(field.valueBytes, config)
          )
        );
      } else {
        parts.push(field.raw);
      }
    }

    return concatBytes(parts);
  }

  function patchAppleWLocPayload(payload, config) {
    var fields = parseFields(payload);
    var parts = [];

    var wifiCount = 0;
    var cellCount = 0;

    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];

      if (field.fieldNumber === 2 && field.wireType === 2) {
        parts.push(
          makeLengthDelimitedField(
            2,
            patchWifiDevice(field.valueBytes, config)
          )
        );

        wifiCount++;
      } else if (
        CELL_RESPONSE_FIELDS[field.fieldNumber] &&
        field.wireType === 2
      ) {
        parts.push(
          makeLengthDelimitedField(
            field.fieldNumber,
            patchCellTower(field.valueBytes, config)
          )
        );

        cellCount++;
      } else {
        parts.push(field.raw);
      }
    }

    return {
      payload: concatBytes(parts),
      wifiCount: wifiCount,
      cellCount: cellCount
    };
  }

  function readUInt16BE(bytes, offset) {
    if (offset + 2 > bytes.length) {
      throw new Error("uint16 out of range");
    }

    return (
      (bytes[offset] << 8) |
      bytes[offset + 1]
    );
  }

  function readUInt32BE(bytes, offset) {
    if (offset + 4 > bytes.length) {
      throw new Error("uint32 out of range");
    }

    return (
      bytes[offset] * 0x1000000 +
      ((bytes[offset + 1] << 16) |
       (bytes[offset + 2] << 8) |
       bytes[offset + 3])
    ) >>> 0;
  }

  function writeUInt16BE(value) {
    return new Uint8Array([
      (value >> 8) & 0xff,
      value & 0xff
    ]);
  }

  function writeUInt32BE(value) {
    return new Uint8Array([
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff
    ]);
  }

  function asciiBytes(value) {
    var out = new Uint8Array(value.length);

    for (var i = 0; i < value.length; i++) {
      out[i] = value.charCodeAt(i) & 0x7f;
    }

    return out;
  }

  function readPascalString(bytes, state) {
    var length = readUInt16BE(bytes, state.offset);

    state.offset += 2;

    if (state.offset + length > bytes.length) {
      throw new Error("ARPC string exceeds buffer");
    }

    var chars = [];

    for (var i = 0; i < length; i++) {
      chars.push(
        String.fromCharCode(
          bytes[state.offset + i]
        )
      );
    }

    state.offset += length;

    return chars.join("");
  }

  function writePascalString(value) {
    return concatBytes([
      writeUInt16BE(value.length),
      asciiBytes(value)
    ]);
  }

  function parseArpc(bytes) {
    var state = {
      offset: 0
    };

    var version = readUInt16BE(bytes, state.offset);
    state.offset += 2;

    var locale = readPascalString(bytes, state);
    var appIdentifier = readPascalString(bytes, state);
    var osVersion = readPascalString(bytes, state);

    var functionId = readUInt32BE(bytes, state.offset);
    state.offset += 4;

    var payloadLength = readUInt32BE(bytes, state.offset);
    state.offset += 4;

    if (state.offset + payloadLength > bytes.length) {
      throw new Error("ARPC payload exceeds buffer");
    }

    return {
      version: version,
      locale: locale,
      appIdentifier: appIdentifier,
      osVersion: osVersion,
      functionId: functionId,
      payload: bytes.slice(
        state.offset,
        state.offset + payloadLength
      )
    };
  }

  function serializeArpc(arpc) {
    return concatBytes([
      writeUInt16BE(arpc.version),
      writePascalString(arpc.locale),
      writePascalString(arpc.appIdentifier),
      writePascalString(arpc.osVersion),
      writeUInt32BE(arpc.functionId),
      writeUInt32BE(arpc.payload.length),
      arpc.payload
    ]);
  }

  function findBytes(bytes, marker) {
    for (
      var i = 0;
      i <= bytes.length - marker.length;
      i++
    ) {
      var match = true;

      for (var j = 0; j < marker.length; j++) {
        if (bytes[i + j] !== marker[j]) {
          match = false;
          break;
        }
      }

      if (match) {
        return i;
      }
    }

    return -1;
  }

  function tryParseFields(bytes) {
    try {
      var fields = parseFields(bytes);
      return fields.length ? fields : null;
    } catch (e) {
      return null;
    }
  }

  function extractPrefixedAppleWLocPayload(bytes) {
    if (!bytes || bytes.length < 10) {
      return null;
    }

    if (
      bytes[0] !== 0x00 ||
      bytes[1] !== 0x01 ||
      bytes[6] !== 0x00 ||
      bytes[7] !== 0x00
    ) {
      return null;
    }

    var length = readUInt16BE(bytes, 8);
    var offset = 10;

    if (
      length <= 0 ||
      offset + length > bytes.length
    ) {
      return null;
    }

    var payload = bytes.slice(
      offset,
      offset + length
    );

    if (!tryParseFields(payload)) {
      return null;
    }

    return {
      kind: "synthetic",
      payload: payload,
      prefix: bytes.slice(0, 8),
      suffix: bytes.slice(offset + length)
    };
  }

  function extractAppleWLocPayload(bytes) {
    if (!bytes || bytes.length < 2) {
      throw new Error("WLOC response too short");
    }

    var prefixed =
      extractPrefixedAppleWLocPayload(bytes);

    if (prefixed) {
      return prefixed;
    }

    try {
      var arpc = parseArpc(bytes);

      if (
        arpc.payload.length > 0 &&
        tryParseFields(arpc.payload)
      ) {
        return {
          kind: "arpc",
          payload: arpc.payload,
          arpc: arpc
        };
      }
    } catch (e) {}

    var markerIdx =
      findBytes(bytes, APPLE_WLOC_MARKER);

    if (markerIdx >= 0) {
      var lenOffset =
        markerIdx + APPLE_WLOC_MARKER.length;

      if (lenOffset + 2 <= bytes.length) {
        var length =
          readUInt16BE(bytes, lenOffset);

        var payloadOffset =
          lenOffset + 2;

        if (
          length > 0 &&
          payloadOffset + length <= bytes.length
        ) {
          var payload = bytes.slice(
            payloadOffset,
            payloadOffset + length
          );

          if (tryParseFields(payload)) {
            return {
              kind: "marker",
              payload: payload,
              prefix: bytes.slice(0, markerIdx),
              markerAndLen: bytes.slice(
                markerIdx,
                payloadOffset
              ),
              suffix: bytes.slice(
                payloadOffset + length
              )
            };
          }
        }
      }
    }

    /*
     * 最后的 bare protobuf 判断。
     */
    var tag = bytes[0];
    var fieldNumber = tag >> 3;
    var wireType = tag & 7;

    if (
      fieldNumber > 0 &&
      (wireType === 0 || wireType === 2)
    ) {
      return {
        kind: "bare",
        payload: bytes
      };
    }

    throw new Error(
      "missing Apple WLoc response payload"
    );
  }

  function buildAppleWLocResponse(
    payload,
    prefix
  ) {
    return concatBytes([
      prefix || APPLE_WLOC_PREFIX,
      writeUInt16BE(payload.length),
      payload
    ]);
  }

  function spoofAppleResponse(bytes, config) {
    var extraction =
      extractAppleWLocPayload(bytes);

    var patched =
      patchAppleWLocPayload(
        extraction.payload,
        config
      );

    if (
      patched.wifiCount === 0 &&
      patched.cellCount === 0
    ) {
      throw new Error(
        "no patchable WiFi/Cell location fields"
      );
    }

    var response;

    if (extraction.kind === "arpc") {
      response = serializeArpc({
        version: extraction.arpc.version,
        locale: extraction.arpc.locale,
        appIdentifier:
          extraction.arpc.appIdentifier,
        osVersion:
          extraction.arpc.osVersion,
        functionId:
          extraction.arpc.functionId,
        payload: patched.payload
      });
    } else if (extraction.kind === "marker") {
      response = concatBytes([
        extraction.prefix,
        APPLE_WLOC_MARKER,
        writeUInt16BE(patched.payload.length),
        patched.payload,
        extraction.suffix
      ]);
    } else {
      response = buildAppleWLocResponse(
        patched.payload,
        extraction.prefix
      );
    }

    return {
      response: response,
      payload: patched.payload,
      wifiCount: patched.wifiCount,
      cellCount: patched.cellCount,
      kind: extraction.kind
    };
  }

  function parseArgument() {
    var result = {};

    if (
      typeof $argument === "undefined" ||
      !$argument
    ) {
      return result;
    }

    var pairs = String($argument).split("&");

    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];

      if (!p) continue;

      var eq = p.indexOf("=");

      var key =
        eq >= 0
          ? p.slice(0, eq)
          : p;

      var value =
        eq >= 0
          ? p.slice(eq + 1)
          : "true";

      try {
        result[decodeURIComponent(key)] =
          decodeURIComponent(value);
      } catch (e) {
        result[key] = value;
      }
    }

    return result;
  }

  function normalizeConfig(input) {
    var cfg = {};

    for (var key in DEFAULT_CONFIG) {
      cfg[key] = DEFAULT_CONFIG[key];
    }

    for (key in input) {
      cfg[key] = input[key];
    }

    cfg.enabled =
      cfg.enabled !== false &&
      String(cfg.enabled).toLowerCase() !== "false";

    cfg.latitude = Number(cfg.latitude);
    cfg.longitude = Number(cfg.longitude);

    cfg.horizontalAccuracy =
      Math.trunc(Number(cfg.horizontalAccuracy));

    cfg.verticalAccuracy =
      Math.trunc(Number(cfg.verticalAccuracy));

    cfg.altitude =
      Math.trunc(Number(cfg.altitude));

    cfg.debug =
      cfg.debug === true ||
      String(cfg.debug).toLowerCase() === "true";

    if (
      !Number.isFinite(cfg.latitude) ||
      cfg.latitude < -90 ||
      cfg.latitude > 90
    ) {
      throw new Error("invalid latitude");
    }

    if (
      !Number.isFinite(cfg.longitude) ||
      cfg.longitude < -180 ||
      cfg.longitude > 180
    ) {
      throw new Error("invalid longitude");
    }

    return cfg;
  }

  function loadConfig(callback) {
    var args = parseArgument();

    var config = {};

    for (var key in DEFAULT_CONFIG) {
      config[key] = DEFAULT_CONFIG[key];
    }

    /*
     * 支持 Argument 中直接传入坐标。
     */
    for (
      var i = 0;
      i < [
        "enabled",
        "latitude",
        "longitude",
        "horizontalAccuracy",
        "verticalAccuracy",
        "altitude",
        "debug"
      ].length;
      i++
    ) {
      var k = [
        "enabled",
        "latitude",
        "longitude",
        "horizontalAccuracy",
        "verticalAccuracy",
        "altitude",
        "debug"
      ][i];

      if (
        Object.prototype.hasOwnProperty.call(
          args,
          k
        )
      ) {
        config[k] = args[k];
      }
    }

    var configUrl =
      args.configUrl || "";

    if (
      configUrl &&
      typeof $task !== "undefined" &&
      $task.fetch
    ) {
      log("读取 configUrl");

      $task.fetch({
        url: configUrl,
        method: "GET"
      }).then(function (resp) {
        try {
          var remote =
            JSON.parse(resp.body || "{}");

          for (var key in remote) {
            config[key] = remote[key];
          }

          log(
            "loc.json = " +
            Number(config.latitude) +
            "," +
            Number(config.longitude)
          );

          callback(
            normalizeConfig(config)
          );
        } catch (e) {
          log(
            "loc.json 解析失败: " +
            e.message
          );

          callback(
            normalizeConfig(config)
          );
        }
      }).catch(function (err) {
        log(
          "loc.json 请求失败: " +
          err
        );

        callback(
          normalizeConfig(config)
        );
      });

      return;
    }

    log(
      "未使用 configUrl，使用 Argument 坐标"
    );

    callback(
      normalizeConfig(config)
    );
  }

  function runQX() {
    log("脚本启动");

    if (
      typeof $response === "undefined"
    ) {
      log("$response 不存在");
      $done({});
      return;
    }

    var bodyBytes =
      $response.bodyBytes;

    if (!bodyBytes) {
      log("$response.bodyBytes 不存在");
      $done({});
      return;
    }

    var bytes =
      bodyBytes instanceof Uint8Array
        ? bodyBytes
        : new Uint8Array(bodyBytes);

    log(
      "收到 WLOC 响应: " +
      bytes.length +
      " bytes"
    );

    log(
      "响应头: " +
      hexPreview(bytes, 24)
    );

    loadConfig(function (config) {
      try {
        if (!config.enabled) {
          log("脚本已禁用");
          $done({});
          return;
        }

        log(
          "目标坐标: " +
          config.latitude +
          "," +
          config.longitude
        );

        var result =
          spoofAppleResponse(
            bytes,
            config
          );

        log(
          "PATCH 成功: wifi=" +
          result.wifiCount +
          ", cell=" +
          result.cellCount +
          ", kind=" +
          result.kind
        );

        log(
          "输出长度: " +
          result.response.length
        );

        /*
         * Quantumult X 必须使用 ArrayBuffer
         * 写回二进制响应。
         */
        var buffer =
          result.response.buffer.slice(
            result.response.byteOffset,
            result.response.byteOffset +
            result.response.byteLength
          );

        $done({
          bodyBytes: buffer
        });

      } catch (err) {
        log(
          "PATCH 失败: " +
          (
            err &&
            err.message
              ? err.message
              : String(err)
          )
        );

        if (
          config.failOpen !== false
        ) {
          $done({});
        } else {
          $done({});
        }
      }
    });
  }

  runQX();

})();