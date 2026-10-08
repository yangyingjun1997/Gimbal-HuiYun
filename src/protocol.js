"use strict";

// ============== 消息 ID 定义（基于厂家 hy_gimbal.py 库） ==============
const MSG = {
  HEARTBEAT: 0,
  COMMAND_LONG: 76,
  COMMAND_ACK: 77,
  CAMERA_SETTINGS: 260,
  STORAGE_INFORMATION: 261,
  CAMERA_CAPTURE_STATUS: 262,
  HY_REQUEST: 11047,
  HY_GIMBAL_ACTIVE_MODE: 11049,
  HY_GIMBAL_CONTROL: 11050,
  HY_GIMBAL_CALIBRATION: 11051,
  HY_GIMBAL_REPORT: 11052,
  HY_GIMBAL_CHANNEL_CONFIG: 11053,
  HY_GIMBAL_DATA: 11054,
  HY_LASER_RANGING: 11055,
  HY_GIMBAL_CALIBRATION_FEEDBACK: 11056,
  HY_CAMERA_CONFIG: 11060,
  HY_CAMERA_REPORT: 11061,
  HY_CAMERA_TRACK_SELECTION: 11062,
  HY_CAMERA_TRACK_INFO: 11063,
  HY_CAMERA_GUIDE_MOVEMENT: 11064,
  CAMERA_NET_CONFIG: 11065,
  HY_CAMERA_GENERAL_ACK: 11066,
  HY_IR_TEMP_REGION_CONFIG: 11067,
  HY_IR_CAMERA_STATUS: 11068, // V1.0.7 新增：红外相机状态与测温上报
};

// ============== HY_REQUEST 请求类型枚举 ==============
const REQUEST_TYPES = {
  NONE_REQUEST: 0,
  CONNECT_REQUEST: 1,
  UPGRADE_REQUEST: 2,
  VERSION_REQUEST: 3,
  CHANNEL_REQUEST: 4,
  CALI_FEEDBACK_REQUEST: 5,
  REBOOT_REQUEST: 6,
};

// ============== 云台活动模式枚举 ==============
const GIMBAL_ACTIVE_MODE = {
  GIMBAL_ACTIVE_FOLLOW: 1,
  GIMBAL_ACTIVE_GLOBAL: 2,
  GIMBAL_STANDUP_FOLLOW: 3,
  GIMBAL_STANDUP_GLOBAL: 4,
};

// ============== 云台控制模式枚举 ==============
const GIMBAL_CONTROL_MODE = {
  GIMBAL_RATE_CONTROL: 1,
  GIMBAL_ANGLE_CONTROL: 2,
};

// ============== 云台状态枚举 ==============
const GIMBAL_STATUS = {
  STATE_UNINIT: 0,
  STATE_BOOTING: 1,
  STATE_STANDBY: 2,
  STATE_NO_IMU: 3,
  STATE_NO_YAW_MOTOR: 4,
  STATE_NO_ROLL_MOTOR: 5,
  STATE_NO_PITCH_MOTOR: 6,
  STATE_MOTOR_BLOCK: 7,
  STATE_START: 10,
  STATE_YAW_CALIBRATING: 11,
  STATE_YAW_CALIBRATION_FINISHED: 12,
  STATE_ROLL_CALIBRATING: 13,
  STATE_ROLL_CALIBRATION_FINISHED: 14,
  STATE_PITCH_CALIBRATING: 15,
  STATE_PITCH_CALIBRATION_FINISHED: 16,
  STATE_ACTIVE_FOLLOW: 20,
  STATE_ACTIVE_GLOBAL: 21,
  STATE_ENUM_END: 22,
};

// ============== 相机配置类型枚举（CAMERA_CONFIG_TYPE） ==============
const CAMERA_CONFIG_TYPE = {
  CAMERA_HEARTBEAT_FUNCTION: 0,
  CAMERA_ZOOM: 1,
  CAMERA_TAKE_PHOTO: 2,
  CAMERA_VIDEO_RECORD: 3,
  CAMERA_IMAGE_FLIP: 4,
  CAMERA_OSD_DISPLAY: 5,
  CAMERA_RAW_RESOLUTION: 6,
  CAMERA_RECORD_RESOLUTION: 7,
  CAMERA_TRANSMISSION_RESOLUTION: 8,
  CAMERA_RECOGNITION_SCAN: 9,
  CAMERA_TRACKER_SELECTION: 10,
  CAMERA_SD_FORMAT: 11,
  CAMERA_FOCUS_VALUE: 12,
  CAMERA_APERTURE_VALUE: 13,
  CAMERA_IMAGE_STABILIZATION: 14,
  CAMERA_SET_DEFOG: 15,
  CAMERA_DISTORTION_COMPENSATION: 16,
  CAMERA_BITRATE: 17,
  CAMERA_ENCODING_FORMAT: 18,
  CAMERA_DIGITAL_ZOOM: 19,
  CAMERA_PSEUDO_COLOR: 20,
  CAMERA_IR_TEMP_DISPLAY: 21,
  CAMERA_BACKLIGHT_COMPENSATION: 22,
  CAMERA_DAY_NIGHT_SWITCH: 23,
  CAMERA_ZOOM_TELE_CONTINUOUS: 24,
  CAMERA_ZOOM_WIDE_CONTINUOUS: 25,
  CAMERA_ZOOM_STOP: 26,
  // V1.0.7 新增 3 项
  CAMERA_REBOOT: 27,            // 相机重启
  CAMERA_IR_ZOOM: 28,           // 红外相机变焦
  CAMERA_SD_READONLY_REPAIR: 29,// 修复 SD 卡只读状态
};

// ============== 红外相机状态标志（IR_CAMERA_STATUS_FLAGS，V1.0.7 新增） ==============
const IR_CAMERA_STATUS_FLAGS = {
  IR_CAMERA_GLOBAL_TEMP_VALID: 1, // 全局最高/最低温数据有效
  IR_CAMERA_REGION_VALID: 2,      // 测温区域坐标与温度数据有效
};

// ============== 码率对应表 ==============
const BITRATE_TABLE = {
  1: "1 Mbps", 2: "1.5 Mbps", 3: "2 Mbps", 4: "2.5 Mbps", 5: "3 Mbps",
  6: "3.5 Mbps", 7: "4 Mbps", 8: "4.5 Mbps", 9: "5 Mbps", 10: "5.5 Mbps", 11: "6 Mbps",
};

// ============== 图传分辨率对应表 ==============
const TRANSMISSION_RESOLUTION_TABLE = {
  0: "4K", 1: "2K", 2: "1080P", 3: "720P", 4: "480P",
};

// ============== CRC_EXTRA 校验值 ==============
// 大部分直接从厂家 hy_gimbal.py 库提取
// HY_CAMERA_CONFIG: CRC_EXTRA=167 已通过 hy_camera_tester.py crcscan 暴力扫描严格确认
//   （2026-08-14 下午：扫 0-255 每个 ce，在 167 时 type=4 val=1 发送后 CAM_REPORT.imageFlip False→True）
//   同一会话中 camera 5 2 (CRC=167) 也让 osdDisplay True→False，双通道验证。
//   厂家库 hy_gimbal.py 原先写 164，与实际设备固件不符；另外 "CRC=36 生效" 的结论来自
//   历史日志中时间巧合（设备自发切换 flip 状态刚好发生在 type=1 val=2 CRC=36 之后 470ms）。
const CRC_EXTRA = {
  [MSG.HEARTBEAT]: 50,
  [MSG.COMMAND_LONG]: 152,
  [MSG.COMMAND_ACK]: 143,
  [MSG.CAMERA_SETTINGS]: 146,
  [MSG.STORAGE_INFORMATION]: 179,
  [MSG.CAMERA_CAPTURE_STATUS]: 12,
  [MSG.HY_REQUEST]: 74,
  [MSG.HY_GIMBAL_ACTIVE_MODE]: 86,
  [MSG.HY_GIMBAL_CONTROL]: 148,
  [MSG.HY_GIMBAL_CALIBRATION]: 66,
  [MSG.HY_GIMBAL_REPORT]: 61,
  [MSG.HY_GIMBAL_CHANNEL_CONFIG]: 9,
  [MSG.HY_GIMBAL_DATA]: 156,
  [MSG.HY_LASER_RANGING]: 133,
  [MSG.HY_GIMBAL_CALIBRATION_FEEDBACK]: 203,
  [MSG.HY_CAMERA_CONFIG]: 167,
  [MSG.HY_CAMERA_REPORT]: 41,
  [MSG.HY_CAMERA_TRACK_SELECTION]: 8,
  [MSG.HY_CAMERA_TRACK_INFO]: 152,
  [MSG.HY_CAMERA_GUIDE_MOVEMENT]: 148,
  [MSG.CAMERA_NET_CONFIG]: 184,
  [MSG.HY_CAMERA_GENERAL_ACK]: 63,
  [MSG.HY_IR_TEMP_REGION_CONFIG]: 79,
  [MSG.HY_IR_CAMERA_STATUS]: 132, // V1.0.7 新增，来自厂家库 crc_extra
};

const MESSAGE_NAMES = Object.fromEntries(Object.entries(MSG).map(([key, id]) => [id, key]));

// ============== MAVLink X25 CRC 计算 ==============
function x25Crc(buffer, seed = 0xffff) {
  let crc = seed;
  for (const byte of buffer) {
    let tmp = byte ^ (crc & 0xff);
    tmp = (tmp ^ (tmp << 4)) & 0xff;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
  }
  return crc;
}

function trimPayload(payload) {
  let end = payload.length;
  while (end > 1 && payload[end - 1] === 0) end -= 1;
  return payload.subarray(0, end);
}

function padPayload(payload, size) {
  if (payload.length >= size) return payload;
  return Buffer.concat([payload, Buffer.alloc(size - payload.length)]);
}

// ============== 构造 MAVLink 2 包（按厂家 hy_gimbal.py 的 _pack 方法） ==============
function mavlink2Packet({ msgId, payload, seq, sysId = 1, compId = 25, incompatFlags = 0, compatFlags = 0, crcExtra }) {
  const usedPayload = trimPayload(payload);

  // Build header (9 bytes without marker, matching struct.pack("<BBBBBBBHB"))
  const headerWithoutMagic = Buffer.alloc(9);
  headerWithoutMagic.writeUInt8(usedPayload.length, 0);   // mlen
  headerWithoutMagic.writeUInt8(incompatFlags, 1);        // incompat_flags
  headerWithoutMagic.writeUInt8(compatFlags, 2);          // compat_flags
  headerWithoutMagic.writeUInt8(seq & 0xff, 3);           // seq
  headerWithoutMagic.writeUInt8(sysId & 0xff, 4);         // srcSystem
  headerWithoutMagic.writeUInt8(compId & 0xff, 5);        // srcComponent
  headerWithoutMagic.writeUInt16LE(msgId & 0xffff, 6);   // msgId low 16 bits
  headerWithoutMagic.writeUInt8((msgId >> 16) & 0xff, 8); // msgId high 8 bits

  // CRC calculation: header bytes + payload + CRC_EXTRA
  const crcInput = Buffer.concat([headerWithoutMagic, usedPayload, Buffer.from([crcExtra ?? CRC_EXTRA[msgId] ?? 0])]);
  const crc = x25Crc(crcInput);

  // Build full frame: marker(0xFD) + header + payload + CRC
  const frame = Buffer.concat([Buffer.from([0xfd]), headerWithoutMagic, usedPayload, Buffer.alloc(2)]);
  frame.writeUInt16LE(crc, frame.length - 2);
  return frame;
}

// ============== 创建编码器 ==============
function createEncoder(options = {}) {
  let seq = Number.isInteger(options.initialSeq) ? options.initialSeq & 0xff : 0;
  const sysId = options.sysId ?? 1;
  const compId = options.compId ?? 25;
  const cameraConfigCrcExtra = Number.isInteger(options.cameraConfigCrcExtra)
    ? options.cameraConfigCrcExtra & 0xff
    : CRC_EXTRA[MSG.HY_CAMERA_CONFIG];

  const next = (msgId, payload, crcExtra) => {
    const frame = mavlink2Packet({ msgId, payload, seq, sysId, compId, crcExtra });
    seq = (seq + 1) & 0xff;
    return frame;
  };

  return {
    encodeRequest(request) {
      return next(MSG.HY_REQUEST, Buffer.from([request & 0xff]));
    },
    encodeActiveMode(gimbalMode) {
      return next(MSG.HY_GIMBAL_ACTIVE_MODE, Buffer.from([gimbalMode & 0xff]));
    },
    // HY_GIMBAL_CONTROL (11050)
    // Wire order: pitch_value(float), yaw_value(float), pitch_mode(uint8), yaw_mode(uint8)
    // Format: <ffBB
    encodeGimbalControl({ pitchMode, yawMode, pitchValue, yawValue }) {
      const payload = Buffer.alloc(10);
      payload.writeFloatLE(Number(pitchValue) || 0, 0);
      payload.writeFloatLE(Number(yawValue) || 0, 4);
      payload.writeUInt8((Number(pitchMode) || 0) & 0xff, 8);
      payload.writeUInt8((Number(yawMode) || 0) & 0xff, 9);
      return next(MSG.HY_GIMBAL_CONTROL, payload);
    },
    // MAV_CMD_SET_CAMERA_ZOOM (531) through COMMAND_LONG (76).
    // Wire order: <7fHBBB, matching hy_gimbal.py.
    encodeCommandLong({
      targetSystem = 1,
      targetComponent = 100,
      command = 531,
      confirmation = 0,
      param1 = 0,
      param2 = 0,
      param3 = 0,
      param4 = 0,
      param5 = 0,
      param6 = 0,
      param7 = 0,
    }) {
      const payload = Buffer.alloc(33);
      [param1, param2, param3, param4, param5, param6, param7].forEach((value, index) => {
        payload.writeFloatLE(Number(value) || 0, index * 4);
      });
      payload.writeUInt16LE(Number(command) & 0xffff, 28);
      payload.writeUInt8(Number(targetSystem) & 0xff, 30);
      payload.writeUInt8(Number(targetComponent) & 0xff, 31);
      payload.writeUInt8(Number(confirmation) & 0xff, 32);
      return next(MSG.COMMAND_LONG, payload);
    },
    // HY_CAMERA_CONFIG (11060)
    // Wire order: config_type(uint8), cmd_value(uint8)
    // Format: <BB
    encodeCameraConfig({ configType, cmdValue }) {
      return next(
        MSG.HY_CAMERA_CONFIG,
        Buffer.from([(configType ?? 0) & 0xff, (cmdValue ?? 0) & 0xff]),
        cameraConfigCrcExtra,
      );
    },
    // HY_CAMERA_GUIDE_MOVEMENT (11064)
    // Wire order: movement_x(float), movement_y(float)
    // Format: <ff
    encodeGuideMovement({ movementX, movementY }) {
      const payload = Buffer.alloc(8);
      payload.writeFloatLE(Number(movementX) || 0, 0);
      payload.writeFloatLE(Number(movementY) || 0, 4);
      return next(MSG.HY_CAMERA_GUIDE_MOVEMENT, payload);
    },
    // HY_IR_TEMP_REGION_CONFIG (11067)
    // Wire order: x(float), y(float), width(float), height(float), enable(uint8)
    // Format: <ffffB  (enable is LAST, not first!)
    encodeIrTempRegionConfig({ enable, x, y, width, height }) {
      const payload = Buffer.alloc(17);
      payload.writeFloatLE(Number(x) || 0, 0);
      payload.writeFloatLE(Number(y) || 0, 4);
      payload.writeFloatLE(Number(width) || 0, 8);
      payload.writeFloatLE(Number(height) || 0, 12);
      payload.writeUInt8((enable ?? 1) & 0xff, 16);
      return next(MSG.HY_IR_TEMP_REGION_CONFIG, payload);
    },
    // CAMERA_NET_CONFIG (11065)
    // Wire order: op_type(uint8), ip(char[16]), netmask(char[16]), gateway(char[16]), apply(uint8)
    // Format: <B16s16s16sB
    encodeCameraNetConfig({ opType = 0, ip = "", netmask = "", gateway = "", apply = 1 }) {
      const payload = Buffer.alloc(50);
      payload.writeUInt8(opType & 0xff, 0);
      Buffer.from(String(ip).slice(0, 15), "ascii").copy(payload, 1);
      Buffer.from(String(netmask).slice(0, 15), "ascii").copy(payload, 17);
      Buffer.from(String(gateway).slice(0, 15), "ascii").copy(payload, 33);
      payload.writeUInt8(apply & 0xff, 49);
      return next(MSG.CAMERA_NET_CONFIG, payload);
    },
    // 原始包透传
    encodeRaw(msgId, payloadHex, crcExtra) {
      const payload = Buffer.from(String(payloadHex || "").replace(/[^0-9a-f]/gi, ""), "hex");
      return next(Number(msgId), payload, Number.isFinite(Number(crcExtra)) ? Number(crcExtra) : undefined);
    },
  };
}

// ============== 解析单帧 ==============
function parseFrame(frame) {
  if (!Buffer.isBuffer(frame)) frame = Buffer.from(frame);
  if (frame.length < 12 || frame[0] !== 0xfd) return null;
  const len = frame[1];
  const frameLen = 12 + len;
  if (frame.length < frameLen) return null;
  const msgId = frame.readUIntLE(7, 3);
  const payload = frame.subarray(10, 10 + len);
  const crc = frame.readUInt16LE(10 + len);
  const crcExtra = CRC_EXTRA[msgId];
  let crcOk = null;
  if (crcExtra !== undefined) {
    crcOk = x25Crc(Buffer.concat([frame.subarray(1, 10 + len), Buffer.from([crcExtra])])) === crc;
  }
  return {
    protocol: "mavlink2",
    len,
    seq: frame[4],
    sysId: frame[5],
    compId: frame[6],
    msgId,
    name: MESSAGE_NAMES[msgId] || "UNKNOWN",
    crc,
    crcOk,
    payloadHex: payload.toString("hex").match(/../g)?.join(" ").toUpperCase() || "",
    decoded: decodePayload(msgId, payload),
  };
}

// ============== 解码消息载荷 ==============
function decodePayload(msgId, payload) {
  try {
    if (msgId === MSG.HEARTBEAT && payload.length >= 1) {
      const body = padPayload(payload, 9);
      return {
        customMode: body.readUInt32LE(0),
        type: body.readUInt8(4),
        autopilot: body.readUInt8(5),
        baseMode: body.readUInt8(6),
        systemStatus: body.readUInt8(7),
        mavlinkVersion: body.readUInt8(8),
      };
    }

    if (msgId === MSG.COMMAND_ACK && payload.length >= 3) {
      const body = padPayload(payload, 10);
      return {
        command: body.readUInt16LE(0),
        result: body.readUInt8(2),
        progress: body.readUInt8(3),
        resultParam2: body.readInt32LE(4),
        targetSystem: body.readUInt8(8),
        targetComponent: body.readUInt8(9),
      };
    }

    if (msgId === MSG.CAMERA_SETTINGS && payload.length >= 5) {
      const body = padPayload(payload, 14);
      return {
        timeBootMs: body.readUInt32LE(0),
        modeId: body.readUInt8(4),
        zoomLevel: payload.length >= 9 ? round(body.readFloatLE(5), 3) : null,
        focusLevel: payload.length >= 13 ? round(body.readFloatLE(9), 3) : null,
        cameraDeviceId: payload.length >= 14 ? body.readUInt8(13) : null,
      };
    }

    if (msgId === MSG.STORAGE_INFORMATION && payload.length >= 28) {
      const body = padPayload(payload, 61);
      return {
        timeBootMs: body.readUInt32LE(0),
        totalCapacityMiB: round(body.readFloatLE(4), 2),
        usedCapacityMiB: round(body.readFloatLE(8), 2),
        availableCapacityMiB: round(body.readFloatLE(12), 2),
        readSpeedMiBs: round(body.readFloatLE(16), 2),
        writeSpeedMiBs: round(body.readFloatLE(20), 2),
        storageId: body.readUInt8(24),
        storageCount: body.readUInt8(25),
        status: body.readUInt8(26),
        type: body.readUInt8(27),
        name: readAscii(body, 28, 32),
        storageUsage: payload.length >= 61 ? body.readUInt8(60) : null,
      };
    }

    if (msgId === MSG.CAMERA_CAPTURE_STATUS && payload.length >= 16) {
      const body = padPayload(payload, 23);
      return {
        timeBootMs: body.readUInt32LE(0),
        imageInterval: round(body.readFloatLE(4), 3),
        recordingTimeMs: body.readUInt32LE(8),
        availableCapacityMiB: round(body.readFloatLE(12), 2),
        imageStatus: payload.length >= 17 ? body.readUInt8(16) : null,
        videoStatus: payload.length >= 18 ? body.readUInt8(17) : null,
        imageCount: payload.length >= 22 ? body.readInt32LE(18) : null,
        cameraDeviceId: payload.length >= 23 ? body.readUInt8(22) : null,
      };
    }

    if (msgId === MSG.HY_REQUEST && payload.length >= 1) return { request: payload.readUInt8(0) };
    if (msgId === MSG.HY_GIMBAL_ACTIVE_MODE && payload.length >= 1) return { gimbalMode: payload.readUInt8(0) };

    // HY_GIMBAL_CONTROL (11050)
    // Wire order: pitch_value(float), yaw_value(float), pitch_mode(uint8), yaw_mode(uint8)
    if (msgId === MSG.HY_GIMBAL_CONTROL && payload.length >= 10) {
      const body = padPayload(payload, 10);
      return {
        pitchValue: round(body.readFloatLE(0), 4),
        yawValue: round(body.readFloatLE(4), 4),
        pitchMode: body.readUInt8(8),
        yawMode: body.readUInt8(9),
      };
    }

    // HY_GIMBAL_REPORT (11052)
    // Wire order: pitch_angle(int16), yaw_angle(int16), laser_distance(int16), status(uint8), temperature(int8)
    // Format: <hhhBb
    if (msgId === MSG.HY_GIMBAL_REPORT && payload.length >= 1) {
      const body = padPayload(payload, 8);
      return {
        pitchAngle: round(body.readInt16LE(0) / 100, 2),
        yawAngle: round(body.readInt16LE(2) / 100, 2),
        laserDistance: round(body.readInt16LE(4) / 10, 1),
        status: body.readUInt8(6),
        temperature: body.readInt8(7),
        statusText: lookupEnum(GIMBAL_STATUS, body.readUInt8(6)),
      };
    }

    // HY_CAMERA_CONFIG (11060) - ACK from device
    if (msgId === MSG.HY_CAMERA_CONFIG && payload.length >= 1) {
      const body = padPayload(payload, 2);
      return { configType: body.readUInt8(0), cmdValue: body.readUInt8(1) };
    }

    // HY_CAMERA_REPORT (11061)
    // status_value is uint64_t, MAVLink2 strips trailing zeros
    // So payload can be 4-8 bytes
    if (msgId === MSG.HY_CAMERA_REPORT && payload.length >= 1) {
      // Reconstruct full 64-bit value
      const padded = padPayload(payload, 8);
      const low = padded.readUInt32LE(0);
      const high = padded.length >= 8 ? padded.readUInt32LE(4) : 0;
      const value = low + high * 0x100000000;
      return decodeCameraStatus(value);
    }

    // HY_CAMERA_GUIDE_MOVEMENT (11064)
    if (msgId === MSG.HY_CAMERA_GUIDE_MOVEMENT && payload.length >= 1) {
      const body = padPayload(payload, 8);
      return {
        movementX: round(body.readFloatLE(0), 4),
        movementY: round(body.readFloatLE(4), 4),
      };
    }

    // HY_IR_TEMP_REGION_CONFIG (11067)
    // Wire order: x(float), y(float), width(float), height(float), enable(uint8)
    if (msgId === MSG.HY_IR_TEMP_REGION_CONFIG && payload.length >= 1) {
      const body = padPayload(payload, 17);
      return {
        x: round(body.readFloatLE(0), 3),
        y: round(body.readFloatLE(4), 3),
        width: round(body.readFloatLE(8), 3),
        height: round(body.readFloatLE(12), 3),
        enable: body.readUInt8(16),
      };
    }

    // CAMERA_NET_CONFIG (11065)
    if (msgId === MSG.CAMERA_NET_CONFIG && payload.length >= 1) {
      const body = padPayload(payload, 50);
      return {
        opType: body.readUInt8(0),
        ip: readAscii(body, 1, 16),
        netmask: readAscii(body, 17, 16),
        gateway: readAscii(body, 33, 16),
        apply: body.readUInt8(49),
      };
    }

    // HY_IR_CAMERA_STATUS (11068, V1.0.7 新增)
    // Wire order: min_temp(float), max_temp(float), region_min(float), region_max(float),
    //             region_avg(float), min_x, min_y, max_x, max_y,
    //             region_x1, region_y1, region_x2, region_y2, flags(uint8), flip_mode(uint8)
    // Format: <fffffHHHHHHHHBB  (38 bytes)
    if (msgId === MSG.HY_IR_CAMERA_STATUS && payload.length >= 1) {
      const body = padPayload(payload, 38);
      const flags = body.readUInt8(36);
      return {
        minTemp: round(body.readFloatLE(0), 1),
        maxTemp: round(body.readFloatLE(4), 1),
        regionMinTemp: round(body.readFloatLE(8), 1),
        regionMaxTemp: round(body.readFloatLE(12), 1),
        regionAvgTemp: round(body.readFloatLE(16), 1),
        minX: body.readUInt16LE(20),
        minY: body.readUInt16LE(22),
        maxX: body.readUInt16LE(24),
        maxY: body.readUInt16LE(26),
        regionX1: body.readUInt16LE(28),
        regionY1: body.readUInt16LE(30),
        regionX2: body.readUInt16LE(32),
        regionY2: body.readUInt16LE(34),
        flags,
        flipMode: body.readUInt8(37),
        globalValid: Boolean(flags & IR_CAMERA_STATUS_FLAGS.IR_CAMERA_GLOBAL_TEMP_VALID),
        regionValid: Boolean(flags & IR_CAMERA_STATUS_FLAGS.IR_CAMERA_REGION_VALID),
      };
    }

    // HY_CAMERA_GENERAL_ACK (11066)
    if (msgId === MSG.HY_CAMERA_GENERAL_ACK && payload.length >= 1) {
      const body = padPayload(payload, 37);
      return {
        targetMsgId: body.readUInt16LE(0),
        stage: body.readUInt8(2),
        result: body.readUInt8(3),
        extVal: body.readUInt8(4),
        message: readAscii(body, 5, 32),
      };
    }
  } catch (err) {
    return { decodeError: err.message };
  }
  return {};
}

function readAscii(buffer, offset, length) {
  const bytes = buffer.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  const slice = end >= 0 ? bytes.subarray(0, end) : bytes;
  return slice.toString("ascii");
}

function lookupEnum(enumObj, value) {
  const entry = Object.entries(enumObj).find(([, v]) => v === value);
  return entry ? entry[0] : `UNKNOWN_${value}`;
}

// ============== 解析 HY_CAMERA_REPORT 状态位域（64-bit, 实际使用低32位） ==============
function decodeCameraStatus(value) {
  const v = value >>> 0;
  const bitrateIdx = (v >> 23) & 0x0f;
  const txResIdx = (v >> 15) & 0x07;
  return {
    statusValue: v,
    zoomTimes: v & 0x7f,
    takePhoto: Boolean((v >> 7) & 1),
    videoRecord: Boolean((v >> 8) & 1),
    imageFlip: Boolean((v >> 9) & 1),
    osdDisplay: Boolean((v >> 10) & 1),
    rawResolution: (v >> 11) & 0x03,
    recordResolution: (v >> 13) & 0x03,
    transmissionResolution: txResIdx,
    transmissionResolutionText: TRANSMISSION_RESOLUTION_TABLE[txResIdx] || `未知_${txResIdx}`,
    recognitionScan: Boolean((v >> 18) & 1),
    trackingSelection: Boolean((v >> 19) & 1),
    stabilizer: Boolean((v >> 20) & 1),
    defog: Boolean((v >> 21) & 1),
    distortionCompensation: Boolean((v >> 22) & 1),
    bitrate: bitrateIdx,
    bitrateText: BITRATE_TABLE[bitrateIdx] || `未知_${bitrateIdx}`,
    encodingFormat: (v >> 27) & 1,
    encodingFormatText: ((v >> 27) & 1) === 0 ? "H.264" : "H.265",
    digitalZoom: Boolean((v >> 28) & 1),
    reserved: (v >> 29) & 0x07,
  };
}

// ============== 从缓冲区中批量解析帧 ==============
function parseFrames(buffer) {
  const frames = [];
  let i = 0;
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  while (i < buffer.length) {
    if (buffer[i] !== 0xfd) {
      i += 1;
      continue;
    }
    const len = buffer[i + 1];
    if (!Number.isFinite(len)) break;
    const frameLen = 12 + len;
    if (i + frameLen > buffer.length) break;
    const parsed = parseFrame(buffer.subarray(i, i + frameLen));
    if (parsed) frames.push(parsed);
    i += frameLen;
  }
  return frames;
}

function round(value, digits) {
  const mul = 10 ** digits;
  return Math.round(value * mul) / mul;
}

module.exports = {
  MSG,
  REQUEST_TYPES,
  GIMBAL_ACTIVE_MODE,
  GIMBAL_CONTROL_MODE,
  GIMBAL_STATUS,
  CAMERA_CONFIG_TYPE,
  IR_CAMERA_STATUS_FLAGS,
  BITRATE_TABLE,
  TRANSMISSION_RESOLUTION_TABLE,
  CRC_EXTRA,
  createEncoder,
  mavlink2Packet,
  parseFrame,
  parseFrames,
  decodeCameraStatus,
};
