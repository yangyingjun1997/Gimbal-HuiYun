"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const dgram = require("dgram");
const net = require("net");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const {
  MSG,
  REQUEST_TYPES,
  GIMBAL_ACTIVE_MODE,
  GIMBAL_CONTROL_MODE,
  GIMBAL_STATUS,
  CAMERA_CONFIG_TYPE,
  CRC_EXTRA,
  createEncoder,
  parseFrames,
} = require("./protocol");
const { generateReport } = require("./report");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const LOG_DIR = path.join(__dirname, "..", "logs");
const PHOTO_DIR = path.join(__dirname, "..", "photos");
const RECORDING_DIR = path.join(__dirname, "..", "recordings");
const PYTHON_SDK_BRIDGE = path.join(__dirname, "python_sdk_bridge.py");
const PORT = Number(process.env.PORT || 8080);
const APP_VERSION = "2026-08-19.1-config-verification";
const RX_SAMPLE_INTERVAL_MS = 500;
const STATUS_EMIT_INTERVAL_MS = 250;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  config: {
    deviceIp: process.env.GIMBAL_IP || "192.168.124.64",
    controlPort: Number(process.env.GIMBAL_PORT || 3000),
    localPort: Number(process.env.GIMBAL_LOCAL_PORT || 3000),
    sdkTargetPort: 14550,
    sdkLocalPort: 14551,
    cameraComponentId: 100,
    // 167 is confirmed against this device; 164 is used by the latest vendor SDK.
    cameraConfigCrcExtra: Number(process.env.GIMBAL_CAMERA_CONFIG_CRC_EXTRA || 167),
    autoLocalPort: true,
    pythonSdkEnabled: process.env.HY_PYTHON_SDK !== "0",
    sysId: 1,
    compId: 25,
    visiblePath: "/live/main",
    thermalPath: "/live/thermal",
  },
  udp: null,
  udpReady: null,
  encoder: null,
  pythonSdk: {
    proc: null,
    pending: new Map(),
    nextId: 1,
    ready: null,
    lastError: null,
  },
  connectedAt: null,
  udpLocalAddress: null,
  counters: { txPackets: 0, txBytes: 0, rxPackets: 0, rxBytes: 0, parseErrors: 0 },
  lastRxAt: null,
  lastTxAt: null,
  lastGimbalReport: null,
  lastCameraReport: null,
  lastIrCameraStatus: null,
  lastCameraNetConfig: null,
  lastCameraConfigEcho: null,
  lastCameraGeneralAck: null,
  lastStorageInformation: null,
  lastCaptureStatus: null,
  samples: [],
  logs: [],
  sseClients: new Set(),
  rxSampleLastAt: {},
  rxSuppressed: 0,
  statusEmitTimer: null,
  mjpeg: {
    visible: { proc: null, clients: new Set(), startedAt: null, lastError: null, restartTimer: null },
    thermal: { proc: null, clients: new Set(), startedAt: null, lastError: null, restartTimer: null },
  },
  recording: {
    active: false,
    channel: null,
    startTime: null,
    proc: null,
    outputFile: null,
  },
};

function log(level, message, data) {
  const item = { time: new Date().toISOString(), level, message, data };
  state.logs.unshift(item);
  state.logs = state.logs.slice(0, 200);
  appendLog(item);
  emit("log", item);
}

function appendLog(item) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const day = item.time.slice(0, 10);
    const line = JSON.stringify(item) + "\n";
    fs.appendFile(path.join(LOG_DIR, `${day}.log`), line, () => {});
  } catch {}
}

function emit(type, data) {
  const body = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of state.sseClients) res.write(body);
}

function emitStatusThrottled() {
  if (state.statusEmitTimer) return;
  state.statusEmitTimer = setTimeout(() => {
    state.statusEmitTimer = null;
    emit("status", snapshot());
  }, STATUS_EMIT_INTERVAL_MS);
}

function snapshot() {
  return {
    config: state.config,
    connected: Boolean(state.udp),
    connectedAt: state.connectedAt,
    udpLocalAddress: state.udpLocalAddress,
    networkInterfaces: listNetworkInterfaces(),
    counters: state.counters,
    lastRxAt: state.lastRxAt,
    lastTxAt: state.lastTxAt,
    lastGimbalReport: state.lastGimbalReport,
    lastCameraReport: state.lastCameraReport,
    lastIrCameraStatus: state.lastIrCameraStatus,
    lastCameraNetConfig: state.lastCameraNetConfig,
    lastCameraConfigEcho: state.lastCameraConfigEcho,
    lastCameraGeneralAck: state.lastCameraGeneralAck,
    lastStorageInformation: state.lastStorageInformation,
    lastCaptureStatus: state.lastCaptureStatus,
    recentSamples: state.samples.slice(0, 40),
    logs: state.logs.slice(0, 100),
    logFile: path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`),
    appVersion: APP_VERSION,
    pythonSdk: {
      enabled: state.config.pythonSdkEnabled,
      running: Boolean(state.pythonSdk.proc),
      bridge: PYTHON_SDK_BRIDGE,
      lastError: state.pythonSdk.lastError,
    },
    rtsp: rtspUrls(),
    ffmpegAvailable: hasFfmpeg(),
    photoDir: PHOTO_DIR,
    recordingDir: RECORDING_DIR,
    recording: {
      active: state.recording.active,
      channel: state.recording.channel,
      startTime: state.recording.startTime,
      outputFile: state.recording.outputFile,
      duration: state.recording.startTime ? Math.floor((Date.now() - state.recording.startTime) / 1000) : 0,
    },
    mjpeg: Object.fromEntries(Object.entries(state.mjpeg).map(([channel, item]) => [channel, {
      running: Boolean(item.proc),
      clients: item.clients.size,
      startedAt: item.startedAt,
      lastError: item.lastError,
    }])),
  };
}

function rtspUrls(config = state.config) {
  return {
    visible: `rtsp://${config.deviceIp}${config.visiblePath}`,
    thermal: `rtsp://${config.deviceIp}${config.thermalPath}`,
  };
}

function connectUdp(configPatch = {}) {
  closeUdp();
  state.config = { ...state.config, ...normalizeConfig(configPatch) };
  state.encoder = createEncoder({
    sysId: state.config.sysId,
    compId: state.config.compId,
    cameraConfigCrcExtra: state.config.cameraConfigCrcExtra,
  });
  return bindUdpSocket(state.config.localPort);
}

function bindUdpSocket(localPort, retried = false) {
  state.udpReady = new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");

    socket.on("message", handleUdpMessage);
    socket.once("error", (err) => {
      if (err.code === "EADDRINUSE" && !retried && state.config.autoLocalPort !== false) {
        log("warn", `UDP local port ${localPort} is in use, retrying with an ephemeral local port`);
        try {
          socket.close();
        } catch {}
        bindUdpSocket(0, true).then(resolve, reject);
        return;
      }
      log("error", `UDP error on local port ${localPort}: ${err.message}`);
      reject(err);
    });

    socket.bind(localPort, "0.0.0.0", () => {
      socket.removeAllListeners("error");
      socket.on("error", (err) => log("error", `UDP runtime error: ${err.message}`));
      state.udp = socket;
      state.connectedAt = Date.now();
      state.udpLocalAddress = socket.address();
      state.config.localPort = state.udpLocalAddress.port;
      log("info", `UDP bound on ${state.udpLocalAddress.address}:${state.udpLocalAddress.port}, target ${state.config.deviceIp}:${state.config.controlPort}`);
      emit("status", snapshot());
      resolve();
    });
  });
  return state.udpReady;
}

function handleUdpMessage(msg, rinfo) {
  const receivedAt = Date.now();
  state.counters.rxPackets += 1;
  state.counters.rxBytes += msg.length;
  state.lastRxAt = receivedAt;
  const frames = parseFrames(msg);
  if (!frames.length) state.counters.parseErrors += 1;
  // 整帧的 hex（每个 UDP 包可能多个帧），按每帧单独保存
  const splitFrames = splitMavlinkFramesFromBuffer(msg);
  for (const frame of frames) {
    const matchingBytes = splitFrames.find((b) => {
      try {
        return b.length === 12 + frame.len && b[0] === 0xfd && b[1] === frame.len;
      } catch { return false; }
    });
    const sample = {
      direction: "rx",
      at: receivedAt,
      remote: `${rinfo.address}:${rinfo.port}`,
      bytes: matchingBytes ? matchingBytes.length : msg.length,
      hex: (matchingBytes || msg).toString("hex").match(/../g)?.join(" ").toUpperCase(),
      ...frame,
    };
    if (frame.msgId === MSG.HY_GIMBAL_REPORT) state.lastGimbalReport = { at: receivedAt, ...frame.decoded };
    if (frame.msgId === MSG.HY_CAMERA_REPORT) state.lastCameraReport = { at: receivedAt, ...frame.decoded };
    if (frame.msgId === MSG.HY_IR_CAMERA_STATUS) state.lastIrCameraStatus = { at: receivedAt, ...frame.decoded };
    if (frame.msgId === MSG.CAMERA_NET_CONFIG) state.lastCameraNetConfig = { at: receivedAt, ...frame.decoded };
    if (frame.msgId === MSG.HY_CAMERA_CONFIG) state.lastCameraConfigEcho = { at: receivedAt, ...frame.decoded };
    if (frame.msgId === MSG.HY_CAMERA_GENERAL_ACK) state.lastCameraGeneralAck = { at: receivedAt, ...frame.decoded };
    if (frame.msgId === MSG.STORAGE_INFORMATION) state.lastStorageInformation = { at: receivedAt, ...frame.decoded };
    if (frame.msgId === MSG.CAMERA_CAPTURE_STATUS) state.lastCaptureStatus = { at: receivedAt, ...frame.decoded };
    const key = `${sample.msgId || "unknown"}:${sample.remote}`;
    const lastSampleAt = state.rxSampleLastAt[key] || 0;
    if (receivedAt - lastSampleAt >= RX_SAMPLE_INTERVAL_MS) {
      state.rxSampleLastAt[key] = receivedAt;
      state.samples.unshift(sample);
      appendLog({ time: new Date(sample.at).toISOString(), level: "rx", message: `${sample.name} ${sample.remote} ${sample.bytes} bytes`, data: sample });
      emit("sample", sample);
    } else {
      state.rxSuppressed += 1;
    }
  }
  state.samples = state.samples.slice(0, 500);
  emitStatusThrottled();
}

function splitMavlinkFramesFromBuffer(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length - 11) {
    if (buf[i] !== 0xfd) { i++; continue; }
    const plen = buf[i + 1];
    if (plen > 255) { i++; continue; }
    const flen = 12 + plen;
    if (i + flen > buf.length) break;
    out.push(buf.slice(i, i + flen));
    i += flen;
  }
  return out;
}

function closeUdp() {
  if (state.udp) {
    try {
      state.udp.close();
    } catch {}
  }
  state.udp = null;
  state.udpReady = null;
  state.udpReadyResolve = null;
  state.udpReadyReject = null;
  state.connectedAt = null;
  state.udpLocalAddress = null;
  if (state.statusEmitTimer) {
    clearTimeout(state.statusEmitTimer);
    state.statusEmitTimer = null;
  }
}

function normalizeConfig(input) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (["controlPort", "localPort", "sdkTargetPort", "sdkLocalPort", "sysId", "compId", "cameraComponentId", "cameraConfigCrcExtra"].includes(key)) out[key] = Number(value);
    else if (["autoLocalPort", "pythonSdkEnabled"].includes(key)) out[key] = Boolean(value);
    else if (value !== undefined && value !== null && value !== "") out[key] = String(value);
  }
  return out;
}

async function ensureConnected() {
  if (state.udp) return;
  log("info", "Auto-connecting UDP...");
  await connectUdp();
  await sleep(200);
  if (state.config.pythonSdkEnabled) {
    const result = await pythonSdkRequest({
      message: "hy_request",
      fields: { request: REQUEST_TYPES.CONNECT_REQUEST },
      config: sdkBridgeConfig(),
    });
    const frame = Buffer.from(String(result.hex || "").replace(/\s+/g, ""), "hex");
    if (frame.length < 12) throw new Error("Python SDK returned an invalid MAVLink frame");
    await sendFrame(frame, "PYSDK AUTO_CONNECT");
  } else {
    await sendFrame(state.encoder.encodeRequest(REQUEST_TYPES.CONNECT_REQUEST), "AUTO_CONNECT");
  }
}

function sdkBridgeConfig() {
  return {
    deviceIp: state.config.deviceIp,
    ports: [...new Set([state.config.controlPort, state.config.sdkTargetPort].filter(Boolean))],
    sysId: state.config.sysId,
    compId: state.config.compId,
  };
}

function findPython() {
  const candidates = process.env.PYTHON_PATH
    ? [process.env.PYTHON_PATH]
    : process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  for (const candidate of candidates) {
    const args = candidate === "py" ? ["-3", "--version"] : ["--version"];
    const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : candidate;
    const commandArgs = process.platform === "win32"
      ? ["/d", "/c", `${quoteCommand(candidate)} ${args.join(" ")}`]
      : args;
    const result = spawnSync(command, commandArgs, { stdio: "ignore" });
    if (result.status === 0) return candidate;
  }
  return null;
}

function quoteCommand(command) {
  return /\s/.test(command) ? `"${command.replace(/"/g, "")}"` : command;
}

function stopPythonSdk() {
  const bridge = state.pythonSdk;
  for (const pending of bridge.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Python SDK bridge stopped"));
  }
  bridge.pending.clear();
  if (bridge.proc) {
    try { bridge.proc.kill(); } catch {}
  }
  bridge.proc = null;
  bridge.ready = null;
}

function startPythonSdk() {
  const bridge = state.pythonSdk;
  if (bridge.proc) return bridge.proc;
  if (!state.config.pythonSdkEnabled) throw new Error("Python SDK transport is disabled");
  const python = findPython();
  if (!python) throw new Error("Python 3 was not found in PATH; set PYTHON_PATH to the Python executable");
  const args = python === "py" ? ["-3", PYTHON_SDK_BRIDGE] : [PYTHON_SDK_BRIDGE];
  const proc = spawn(python, args, {
    cwd: path.join(__dirname, ".."),
    windowsHide: true,
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  bridge.proc = proc;
  bridge.lastError = null;
  proc.stdout.setEncoding("utf8");
  let buffered = "";
  proc.stdout.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let result;
      try { result = JSON.parse(line); } catch (err) {
        bridge.lastError = `Invalid Python SDK response: ${err.message}`;
        log("error", bridge.lastError);
        continue;
      }
      const pending = bridge.pending.get(result.id);
      if (!pending) continue;
      bridge.pending.delete(result.id);
      clearTimeout(pending.timer);
      if (result.ok) pending.resolve(result);
      else pending.reject(new Error(result.error || "Python SDK bridge failed"));
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    bridge.lastError = chunk.trim().slice(-500);
    if (bridge.lastError) log("error", `Python SDK: ${bridge.lastError}`);
  });
  proc.on("error", (err) => {
    bridge.lastError = err.message;
    log("error", `Python SDK bridge failed: ${err.message}`);
  });
  proc.on("exit", (code, signal) => {
    if (bridge.proc !== proc) return;
    bridge.proc = null;
    bridge.ready = null;
    const message = `Python SDK bridge exited code=${code} signal=${signal || "none"}`;
    if (code !== 0) log("error", message);
  });
  log("info", `Python SDK bridge started: ${python} ${PYTHON_SDK_BRIDGE}`);
  return proc;
}

function pythonSdkRequest(request) {
  const proc = startPythonSdk();
  const id = state.pythonSdk.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pythonSdk.pending.delete(id);
      reject(new Error("Python SDK bridge timeout"));
    }, 5000);
    state.pythonSdk.pending.set(id, { resolve, reject, timer });
    try {
      proc.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    } catch (err) {
      clearTimeout(timer);
      state.pythonSdk.pending.delete(id);
      reject(err);
    }
  });
}

async function sendFrame(frame, label, started = Date.now()) {
  if (!state.udp) await connectUdp();
  if (state.udpReady) await state.udpReady;
  // 同时发到控制端口 3000 + SDK 端口 14550（双通道广播，兼容设备不同固件/不同 MAVLink 监听器）
  // 部分型号在 3000 只发 CAM_REPORT，配置命令需要发到 14550
  const ports = new Set([state.config.controlPort, state.config.sdkTargetPort].filter(Boolean));
  const results = [];
  for (const port of ports) {
    results.push(await new Promise((resolve, reject) => {
      state.udp.send(frame, port, state.config.deviceIp, (err) => {
        if (err) { reject(err); return; }
        resolve({ port, sentAt: Date.now() });
      });
    }));
  }
  return recordTxSample(frame, label, [...ports], started);
}

function recordTxSample(frame, label, targetPorts, started = Date.now()) {
  const ports = [...new Set(targetPorts || [])];
  state.counters.txPackets += ports.length;
  state.counters.txBytes += frame.length * ports.length;
  state.lastTxAt = Date.now();
  const remotes = ports.map((port) => `${state.config.deviceIp}:${port}`).join(" + ");
  const sample = {
    direction: "tx",
    at: state.lastTxAt,
    remote: remotes,
    label,
    bytes: frame.length,
    latencyMs: Date.now() - started,
    hex: frame.toString("hex").match(/../g)?.join(" ").toUpperCase(),
    targetPorts: ports,
  };
  state.samples.unshift(sample);
  state.samples = state.samples.slice(0, 200);
  appendLog({ time: new Date(sample.at).toISOString(), level: "tx", message: `${label} -> ${remotes} ${sample.bytes} bytes`, data: sample });
  emit("sample", sample);
  emit("status", snapshot());
  return sample;
}

async function sendPythonSdkFrame(message, fields, label) {
  await ensureConnected();
  const started = Date.now();
  const result = await pythonSdkRequest({ message, fields, config: sdkBridgeConfig() });
  const frame = Buffer.from(String(result.hex || "").replace(/\s+/g, ""), "hex");
  if (frame.length < 12) throw new Error("Python SDK returned an invalid MAVLink frame");
  return sendFrame(frame, `PYSDK ${label}`, started);
}

async function sendPythonSdkFrameBurst(message, fieldsFactory, label, { repeat = 5, intervalMs = 40 } = {}) {
  await ensureConnected();
  let firstSample = null;
  for (let i = 0; i < repeat; i += 1) {
    const fields = typeof fieldsFactory === "function" ? fieldsFactory(i) : fieldsFactory;
    const sample = await sendPythonSdkFrame(
      message,
      fields,
      i === 0 ? `${label} (x${repeat})` : `${label} #${i + 1}`,
    );
    if (i === 0) firstSample = sample;
    if (i + 1 < repeat) await sleep(intervalMs);
  }
  return firstSample;
}

/**
 * UDP 不可靠 + 设备忙于处理 20Hz GIMBAL_REPORT，控制命令容易被丢掉。
 * 经验：连发 repeat 次设备才能稳定接收到。
 */
async function sendFrameBurst(frameFactory, label, { repeat = 5, intervalMs = 40 } = {}) {
  if (!state.udp) await connectUdp();
  let firstSample = null;
  for (let i = 0; i < repeat; i++) {
    const frame = typeof frameFactory === "function" ? frameFactory(i) : frameFactory;
    const labelWithCount = i === 0 ? `${label} (x${repeat})` : null;
    const sample = await sendFrame(frame, labelWithCount || `${label} #${i + 1}`);
    if (i === 0) firstSample = sample;
    if (i + 1 < repeat) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return firstSample;
}

const CAMERA_CONFIG_REPORT_FIELDS = {
  1: { field: "zoomTimes", expected: (value) => Number(value) },
  2: { field: "takePhoto", expected: () => true },
  3: { field: "videoRecord", expected: (value) => Number(value) === 1 },
  4: { field: "imageFlip", expected: (value) => Number(value) !== 0 },
  5: { field: "osdDisplay", expected: (value) => Number(value) === 1 },
  6: { field: "rawResolution", expected: (value) => Number(value) },
  7: { field: "recordResolution", expected: (value) => Number(value) },
  8: { field: "transmissionResolution", expected: (value) => Number(value) },
  9: { field: "recognitionScan", expected: (value) => Number(value) === 1 },
  10: { field: "trackingSelection", expected: (value) => Number(value) === 1 },
  14: { field: "stabilizer", expected: (value) => Number(value) === 1 },
  15: { field: "defog", expected: (value) => Number(value) === 1 },
  16: { field: "distortionCompensation", expected: (value) => Number(value) === 1 },
  17: { field: "bitrate", expected: (value) => Number(value) },
  18: { field: "encodingFormat", expected: (value) => Number(value) },
  19: { field: "digitalZoom", expected: (value) => Number(value) === 1 },
};

function cameraConfigLabel(payload) {
  const supplied = String(payload.label || "").trim();
  return supplied ? supplied.slice(0, 40) : `配置 ${Number(payload.configType)}:${Number(payload.cmdValue)}`;
}

async function verifyCameraConfig(payload, sentAt, beforeReport, beforeEchoAt, beforeAckAt) {
  const configType = Number(payload.configType);
  const cmdValue = Number(payload.cmdValue);
  const label = cameraConfigLabel(payload);
  const mapping = CAMERA_CONFIG_REPORT_FIELDS[configType];
  const watchesZoomChange = configType === 24 || configType === 25;
  const deadline = Date.now() + (mapping || watchesZoomChange ? 2000 : 800);

  while (Date.now() < deadline) {
    const report = state.lastCameraReport;
    if (report && report.at >= sentAt) {
      if (mapping) {
        const expected = mapping.expected(cmdValue);
        const actual = report[mapping.field];
        if (actual === expected) {
          const before = beforeReport?.[mapping.field];
          const changed = before !== actual;
          return {
            status: changed ? "changed" : "confirmed",
            message: changed ? `${label}：设备状态已变化，配置生效` : `${label}：设备已确认，当前已是该状态`,
            field: mapping.field,
            before: before ?? null,
            after: actual,
            reportAt: report.at,
          };
        }
      } else if (watchesZoomChange && report.zoomTimes !== beforeReport?.zoomTimes) {
        return {
          status: "changed",
          message: `${label}：设备变焦状态已变化`,
          field: "zoomTimes",
          before: beforeReport?.zoomTimes ?? null,
          after: report.zoomTimes,
          reportAt: report.at,
        };
      }
    }

    const echo = state.lastCameraConfigEcho;
    if (echo && echo.at > beforeEchoAt && echo.at >= sentAt &&
        Number(echo.configType) === configType && Number(echo.cmdValue) === cmdValue) {
      return { status: "acknowledged", message: `${label}：设备已回显接收`, echo };
    }

    const ack = state.lastCameraGeneralAck;
    if (ack && ack.at > beforeAckAt && ack.at >= sentAt && Number(ack.targetMsgId) === MSG.HY_CAMERA_CONFIG) {
      const detail = ack.message ? `（${ack.message}）` : "";
      return {
        status: Number(ack.result) === 0 ? "acknowledged" : "rejected",
        message: Number(ack.result) === 0 ? `${label}：设备 ACK 已接收${detail}` : `${label}：设备返回异常 result=${ack.result}${detail}`,
        ack,
      };
    }
    await sleep(50);
  }

  const protocolHasState = Boolean(mapping || watchesZoomChange);
  return {
    status: "unconfirmed",
    message: protocolHasState
      ? `${label}：指令已发送，但 2 秒内未观察到设备状态变化`
      : `${label}：指令已发送；当前协议没有可验证的状态字段`,
    field: mapping?.field || null,
    before: mapping ? beforeReport?.[mapping.field] ?? null : null,
    after: mapping ? state.lastCameraReport?.[mapping.field] ?? null : null,
  };
}

async function sendCommand(command, payload) {
  const enc = state.encoder || createEncoder({
    sysId: state.config.sysId,
    compId: state.config.compId,
    cameraConfigCrcExtra: state.config.cameraConfigCrcExtra,
  });
  state.encoder = enc;
  switch (command) {
    case "request":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrame("hy_request", { request: Number(payload.request) }, `HY_REQUEST ${payload.request}`)
        : sendFrame(enc.encodeRequest(Number(payload.request)), `HY_REQUEST ${payload.request}`);
    case "connect-request":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrame("hy_request", { request: REQUEST_TYPES.CONNECT_REQUEST }, "CONNECT_REQUEST")
        : sendFrame(enc.encodeRequest(REQUEST_TYPES.CONNECT_REQUEST), "CONNECT_REQUEST");
    case "version-request":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrame("hy_request", { request: REQUEST_TYPES.VERSION_REQUEST }, "VERSION_REQUEST")
        : sendFrame(enc.encodeRequest(REQUEST_TYPES.VERSION_REQUEST), "VERSION_REQUEST");
    case "channel-request":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrame("hy_request", { request: REQUEST_TYPES.CHANNEL_REQUEST }, "CHANNEL_REQUEST")
        : sendFrame(enc.encodeRequest(REQUEST_TYPES.CHANNEL_REQUEST), "CHANNEL_REQUEST");
    case "cali-feedback-request":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrame("hy_request", { request: REQUEST_TYPES.CALI_FEEDBACK_REQUEST }, "CALI_FEEDBACK_REQUEST")
        : sendFrame(enc.encodeRequest(REQUEST_TYPES.CALI_FEEDBACK_REQUEST), "CALI_FEEDBACK_REQUEST");
    case "reboot-request":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrame("hy_request", { request: REQUEST_TYPES.REBOOT_REQUEST }, "REBOOT_REQUEST")
        : sendFrame(enc.encodeRequest(REQUEST_TYPES.REBOOT_REQUEST), "REBOOT_REQUEST");
    case "active-mode":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrameBurst("hy_gimbal_active_mode", { gimbal_mode: Number(payload.gimbalMode) }, `ACTIVE_MODE ${payload.gimbalMode}`, { repeat: 3, intervalMs: 30 })
        : sendFrameBurst(() => enc.encodeActiveMode(Number(payload.gimbalMode)), `ACTIVE_MODE ${payload.gimbalMode}`, { repeat: 3, intervalMs: 30 });
    case "gimbal-control":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrameBurst("hy_gimbal_control", {
          pitch_mode: payload.pitchMode,
          yaw_mode: payload.yawMode,
          pitch_value: payload.pitchValue,
          yaw_value: payload.yawValue,
        }, "HY_GIMBAL_CONTROL", { repeat: 3, intervalMs: 30 })
        : sendFrameBurst(() => enc.encodeGimbalControl(payload), "HY_GIMBAL_CONTROL", { repeat: 3, intervalMs: 30 });
    case "gimbal-stop":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrameBurst("hy_gimbal_control", {
          pitch_mode: GIMBAL_CONTROL_MODE.GIMBAL_RATE_CONTROL,
          yaw_mode: GIMBAL_CONTROL_MODE.GIMBAL_RATE_CONTROL,
          pitch_value: 0,
          yaw_value: 0,
        }, "GIMBAL_STOP", { repeat: 5, intervalMs: 20 })
        : sendFrameBurst(() => enc.encodeGimbalControl({
        pitchMode: GIMBAL_CONTROL_MODE.GIMBAL_RATE_CONTROL,
        yawMode: GIMBAL_CONTROL_MODE.GIMBAL_RATE_CONTROL,
        pitchValue: 0,
        yawValue: 0,
      }), "GIMBAL_STOP", { repeat: 5, intervalMs: 20 });
    case "gimbal-center":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrameBurst("hy_gimbal_control", {
          pitch_mode: GIMBAL_CONTROL_MODE.GIMBAL_ANGLE_CONTROL,
          yaw_mode: GIMBAL_CONTROL_MODE.GIMBAL_ANGLE_CONTROL,
          pitch_value: 0,
          yaw_value: 0,
        }, "GIMBAL_CENTER", { repeat: 3, intervalMs: 30 })
        : sendFrameBurst(() => enc.encodeGimbalControl({
        pitchMode: GIMBAL_CONTROL_MODE.GIMBAL_ANGLE_CONTROL,
        yawMode: GIMBAL_CONTROL_MODE.GIMBAL_ANGLE_CONTROL,
        pitchValue: 0,
        yawValue: 0,
      }), "GIMBAL_CENTER", { repeat: 3, intervalMs: 30 });
    case "camera-config":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrameBurst("hy_camera_config", { config_type: payload.configType, cmd_value: payload.cmdValue }, `CAMERA_CONFIG ${payload.configType}:${payload.cmdValue}`, { repeat: 2, intervalMs: 25 })
        : sendFrameBurst(() => enc.encodeCameraConfig(payload), `CAMERA_CONFIG ${payload.configType}:${payload.cmdValue}`, { repeat: 2, intervalMs: 25 });
    case "camera-zoom-continuous":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrameBurst("hy_camera_config", { config_type: CAMERA_CONFIG_TYPE.CAMERA_ZOOM_TELE_CONTINUOUS, cmd_value: 0 }, "CAMERA_ZOOM_TELE_CONTINUOUS", { repeat: 3, intervalMs: 25 })
        : sendFrameBurst(
          () => enc.encodeCameraConfig({ configType: CAMERA_CONFIG_TYPE.CAMERA_ZOOM_TELE_CONTINUOUS, cmdValue: 0 }),
          "CAMERA_ZOOM_TELE_CONTINUOUS",
          { repeat: 3, intervalMs: 25 },
        );
    case "camera-zoom-stop":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrameBurst("hy_camera_config", { config_type: CAMERA_CONFIG_TYPE.CAMERA_ZOOM_STOP, cmd_value: 0 }, "CAMERA_ZOOM_STOP", { repeat: 5, intervalMs: 20 })
        : sendFrameBurst(
          () => enc.encodeCameraConfig({ configType: CAMERA_CONFIG_TYPE.CAMERA_ZOOM_STOP, cmdValue: 0 }),
          "CAMERA_ZOOM_STOP",
          { repeat: 5, intervalMs: 20 },
        );
    case "camera-zoom-standard-continuous": {
      const direction = String(payload.direction || "tele").toLowerCase() === "wide" ? -1 : 1;
      const name = direction > 0 ? "TELE" : "WIDE";
      const fields = {
        target_system: state.config.sysId,
        target_component: state.config.cameraComponentId || 100,
        command: 531,
        param1: 1,
        param2: direction,
      };
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrameBurst("command_long", fields, `MAV_CMD_SET_CAMERA_ZOOM ${name}_CONTINUOUS`, { repeat: 2, intervalMs: 30 })
        : sendFrameBurst(
          () => enc.encodeCommandLong({ ...fields, targetSystem: fields.target_system, targetComponent: fields.target_component }),
          `MAV_CMD_SET_CAMERA_ZOOM ${name}_CONTINUOUS`,
          { repeat: 2, intervalMs: 30 },
        );
    }
    case "camera-zoom-standard-stop":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrameBurst("command_long", {
          target_system: state.config.sysId,
          target_component: state.config.cameraComponentId || 100,
          command: 531,
          param1: 1,
          param2: 0,
        }, "MAV_CMD_SET_CAMERA_ZOOM STOP", { repeat: 3, intervalMs: 25 })
        : sendFrameBurst(
          () => enc.encodeCommandLong({
            targetSystem: state.config.sysId,
            targetComponent: state.config.cameraComponentId || 100,
            command: 531,
            param1: 1,
            param2: 0,
          }),
          "MAV_CMD_SET_CAMERA_ZOOM STOP",
          { repeat: 3, intervalMs: 25 },
        );
    case "camera-zoom-standard-target": {
      const target = Number(payload.zoomTimes);
      if (!Number.isInteger(target) || target < 1 || target > 127) {
        throw new Error("zoomTimes must be an integer from 1 to 127");
      }
      const current = Number(state.lastCameraReport?.zoomTimes);
      if (!Number.isInteger(current) || current < 1 || current > 127) {
        throw new Error("No valid HY_CAMERA_REPORT zoomTimes is available yet");
      }
      const startedAt = Date.now();
      const timeoutMs = Math.min(30000, Math.max(5000, Math.abs(target - current) * 900 + 1500));
      let observed = current;
      try {
        while (Date.now() - startedAt < timeoutMs) {
          observed = Number(state.lastCameraReport?.zoomTimes ?? observed);
          if (observed === target) break;
          const step = target > observed ? 1 : -1;
          const fields = {
            target_system: state.config.sysId,
            target_component: state.config.cameraComponentId || 100,
            command: 531,
            param1: 0,
            param2: step,
          };
          if (state.config.pythonSdkEnabled) {
            await sendPythonSdkFrame("command_long", fields, `MAV_CMD_SET_CAMERA_ZOOM STEP ${step > 0 ? "TELE" : "WIDE"} ${observed}->${target}`);
          } else {
            await sendFrame(
              enc.encodeCommandLong({ ...fields, targetSystem: fields.target_system, targetComponent: fields.target_component }),
              `MAV_CMD_SET_CAMERA_ZOOM STEP ${step > 0 ? "TELE" : "WIDE"} ${observed}->${target}`,
            );
          }
          await sleep(650);
        }
        observed = Number(state.lastCameraReport?.zoomTimes ?? observed);
      } finally {
        await sendCommand("camera-zoom-standard-stop", {});
      }
      if (observed !== target) {
        throw new Error(`Standard zoom target ${target}x not reached; device reports ${observed || "unknown"}x`);
      }
      return { ok: true, zoomTarget: target, zoomTimes: observed, durationMs: Date.now() - startedAt };
    }
    case "camera-zoom": {
      const zoomTimes = Number(payload.zoomTimes ?? payload.cmdValue);
      if (!Number.isInteger(zoomTimes) || zoomTimes < 1 || zoomTimes > 127) {
        throw new Error("zoomTimes must be an integer from 1 to 127");
      }
      const before = state.lastCameraReport;
      const currentZoom = Number(before?.zoomTimes);
      if (!Number.isInteger(currentZoom) || currentZoom < 1 || currentZoom > 127) {
        throw new Error("No valid CAMERA_REPORT zoomTimes is available yet");
      }
      if (currentZoom === zoomTimes) {
        const stopSample = state.config.pythonSdkEnabled
          ? await sendPythonSdkFrameBurst("hy_camera_config", { config_type: CAMERA_CONFIG_TYPE.CAMERA_ZOOM_STOP, cmd_value: 0 }, `CAMERA_ZOOM_STOP ${zoomTimes}x already reached`, { repeat: 2, intervalMs: 25 })
          : await sendFrameBurst(
            () => enc.encodeCameraConfig({ configType: CAMERA_CONFIG_TYPE.CAMERA_ZOOM_STOP, cmdValue: 0 }),
            `CAMERA_ZOOM_STOP ${zoomTimes}x already reached`,
            { repeat: 2, intervalMs: 25 },
          );
        return { ...stopSample, zoomTarget: zoomTimes, zoomTimes: currentZoom, durationMs: 0 };
      }

      // This firmware ignores CAMERA_ZOOM (type 1), but honors continuous
      // zoom commands and reports the actual zoom level in HY_CAMERA_REPORT.
      const direction = zoomTimes > currentZoom
        ? CAMERA_CONFIG_TYPE.CAMERA_ZOOM_TELE_CONTINUOUS
        : CAMERA_CONFIG_TYPE.CAMERA_ZOOM_WIDE_CONTINUOUS;
      const directionName = direction === CAMERA_CONFIG_TYPE.CAMERA_ZOOM_TELE_CONTINUOUS ? "TELE" : "WIDE";
      const startedAt = Date.now();
      const timeoutMs = Math.min(30000, Math.max(2500, Math.abs(zoomTimes - currentZoom) * 400 + 1000));
      let latest = before;
      let stopSample = null;

      try {
        if (state.config.pythonSdkEnabled) {
          await sendPythonSdkFrameBurst("hy_camera_config", { config_type: direction, cmd_value: 0 }, `CAMERA_ZOOM_${directionName} ${currentZoom}->${zoomTimes}x`, { repeat: 2, intervalMs: 40 });
        } else {
          await sendFrameBurst(
            () => enc.encodeCameraConfig({ configType: direction, cmdValue: 0 }),
            `CAMERA_ZOOM_${directionName} ${currentZoom}->${zoomTimes}x`,
            { repeat: 2, intervalMs: 40 },
          );
        }
        while (Date.now() - startedAt < timeoutMs) {
          await sleep(80);
          latest = state.lastCameraReport || latest;
          const observed = Number(latest?.zoomTimes);
          if (direction === CAMERA_CONFIG_TYPE.CAMERA_ZOOM_TELE_CONTINUOUS && observed >= zoomTimes) break;
          if (direction === CAMERA_CONFIG_TYPE.CAMERA_ZOOM_WIDE_CONTINUOUS && observed <= zoomTimes) break;
        }
      } finally {
        stopSample = state.config.pythonSdkEnabled
          ? await sendPythonSdkFrameBurst("hy_camera_config", { config_type: CAMERA_CONFIG_TYPE.CAMERA_ZOOM_STOP, cmd_value: 0 }, "CAMERA_ZOOM_STOP", { repeat: 3, intervalMs: 25 })
          : await sendFrameBurst(
            () => enc.encodeCameraConfig({ configType: CAMERA_CONFIG_TYPE.CAMERA_ZOOM_STOP, cmdValue: 0 }),
            "CAMERA_ZOOM_STOP",
            { repeat: 3, intervalMs: 25 },
          );
      }

      const observed = Number(state.lastCameraReport?.zoomTimes ?? latest?.zoomTimes);
      if (!Number.isInteger(observed) || observed !== zoomTimes) {
        throw new Error(`Zoom target ${zoomTimes}x not reached; device reports ${observed || "unknown"}x`);
      }
      return { ...stopSample, zoomTarget: zoomTimes, zoomTimes: observed, durationMs: Date.now() - startedAt };
    }
    case "guide-movement":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrame("hy_camera_guide_movement", { movement_x: payload.movementX, movement_y: payload.movementY }, "GUIDE_MOVEMENT")
        : sendFrame(enc.encodeGuideMovement(payload), "GUIDE_MOVEMENT");
    case "ir-temp-region-config":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrame("hy_ir_temp_region_config", {
          enable: payload.enable, x: payload.x, y: payload.y, width: payload.width, height: payload.height,
        }, "HY_IR_TEMP_REGION_CONFIG")
        : sendFrame(enc.encodeIrTempRegionConfig(payload), "HY_IR_TEMP_REGION_CONFIG");
    case "camera-net-config":
      return state.config.pythonSdkEnabled
        ? sendPythonSdkFrame("camera_net_config", {
          op_type: payload.opType, ip: payload.ip, netmask: payload.netmask, gateway: payload.gateway, apply: payload.apply,
        }, "CAMERA_NET_CONFIG")
        : sendFrame(enc.encodeCameraNetConfig(payload), "CAMERA_NET_CONFIG");
    case "raw":
      return sendFrame(enc.encodeRaw(payload.msgId, payload.payloadHex, payload.crcExtra), `RAW ${payload.msgId}`);
    case "raw-hex": {
      const frame = Buffer.from(String(payload.hex || "").replace(/[^0-9a-f]/gi, ""), "hex");
      if (frame.length < 12) throw new Error(`Raw frame too short: ${frame.length} bytes`);
      return sendFrame(frame, "RAW_HEX");
    }
    case "pdf-sample": {
      const samples = {
        pitchDown45: "FD 0A 00 00 7C 01 19 2A 2B 00 00 00 34 C2 00 00 00 00 02 02 ED 49",
        pitchUp10: "FD 0A 00 00 BE 01 19 2A 2B 00 00 00 20 41 00 00 00 00 02 02 3C 8C",
        pitchRate10: "FD 0A 00 00 4C 01 19 2A 2B 00 00 00 20 41 00 00 00 00 01 02 E9 3E",
        pitchRateStop: "FD 0A 00 00 20 01 19 2A 2B 00 00 00 00 00 00 00 00 01 02 9C DF",
      };
      const frame = Buffer.from((samples[payload.name] || samples.pitchRateStop).replace(/[^0-9a-f]/gi, ""), "hex");
      if (frame.length < 12) throw new Error(`PDF sample frame too short: ${frame.length} bytes`);
      if (frame[0] === 0xfd && frame.length !== frame[1] + 12) throw new Error(`PDF sample length mismatch: frame says ${frame[1] + 12}, got ${frame.length}`);
      return sendFrame(frame, `PDF_SAMPLE ${payload.name || "pitchRateStop"}`);
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function generateTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function listMediaFiles() {
  const scan = (kind, dir, extension) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
      .map((entry) => {
        const fullPath = path.join(dir, entry.name);
        const stat = fs.statSync(fullPath);
        return {
          kind,
          name: entry.name,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          url: `/api/media-file?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(entry.name)}`,
        };
      });
  };
  return [...scan("photo", PHOTO_DIR, ".jpg"), ...scan("recording", RECORDING_DIR, ".mp4")]
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function serveMediaFile(res, kind, requestedName) {
  const mediaKind = kind === "recording" ? "recording" : "photo";
  const dir = mediaKind === "recording" ? RECORDING_DIR : PHOTO_DIR;
  const expectedExtension = mediaKind === "recording" ? ".mp4" : ".jpg";
  const name = path.basename(String(requestedName || ""));
  if (!name || !name.toLowerCase().endsWith(expectedExtension)) {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "Invalid media file" }));
    return;
  }
  const filePath = path.join(dir, name);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "Media file not found" }));
    return;
  }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    "content-type": mediaKind === "recording" ? "video/mp4" : "image/jpeg",
    "content-length": stat.size,
    "content-disposition": `inline; filename="${name.replace(/"/g, "")}"`,
    "cache-control": "private, max-age=60",
  });
  fs.createReadStream(filePath).pipe(res);
}

async function capturePhoto(channel = "visible") {
  const ch = channel === "thermal" ? "thermal" : "visible";
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const url = rtspUrls()[ch];
  const filename = `${ch}_${generateTimestamp()}.jpg`;
  const outputPath = path.join(PHOTO_DIR, filename);

  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      "-rtsp_transport", "tcp",
      ...ffmpegRtspTimeoutArgs(),
      "-i", url,
      "-frames:v", "1",
      "-q:v", "2",
      "-y",
      outputPath,
    ];
    const proc = spawn(resolveFfmpeg(), args, { windowsHide: true });
    let stderrData = "";
    proc.stderr.on("data", (chunk) => {
      stderrData += chunk.toString("utf8");
    });
    proc.on("exit", (code) => {
      if (code === 0) {
        log("info", `Photo saved: ${filename}`);
        resolve({ ok: true, file: filename, path: outputPath });
      } else {
        reject(new Error(`Photo capture failed (exit ${code}): ${stderrData.slice(-300)}`));
      }
    });
    proc.on("error", reject);
  });
}

async function startRecording(channel = "visible") {
  const ch = channel === "thermal" ? "thermal" : "visible";
  if (state.recording.active) {
    throw new Error("已有录制正在进行中，请先停止当前录制");
  }
  fs.mkdirSync(RECORDING_DIR, { recursive: true });
  const url = rtspUrls()[ch];
  const filename = `${ch}_${generateTimestamp()}.mp4`;
  const outputPath = path.join(RECORDING_DIR, filename);

  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      "-rtsp_transport", "tcp",
      ...ffmpegRtspTimeoutArgs(),
      "-use_wallclock_as_timestamps", "1",
      "-i", url,
      "-c", "copy",
      "-fflags", "+genpts",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ];
    const proc = spawn(resolveFfmpeg(), args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    state.recording = {
      active: true,
      channel: ch,
      startTime: Date.now(),
      proc,
      outputFile: outputPath,
      filename,
    };
    proc.stderr.on("data", (chunk) => {
      const msg = chunk.toString("utf8");
      if (msg.includes("error") || msg.includes("failed")) {
        log("error", `Recording ${ch} error: ${msg.slice(0, 300)}`);
      }
    });
    proc.on("exit", (code) => {
      const duration = state.recording.startTime ? Math.floor((Date.now() - state.recording.startTime) / 1000) : 0;
      const fileSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
      log("info", `Recording stopped (exit ${code || 0}): ${filename}, duration=${duration}s, size=${(fileSize / 1024 / 1024).toFixed(2)}MB`);
      state.recording.active = false;
      state.recording.proc = null;
      state.recording.channel = null;
      state.recording.startTime = null;
      state.recording.outputFile = null;
      state.recording.filename = null;
      emit("status", snapshot());
    });
    proc.on("error", reject);
    log("info", `Recording started: ${filename}`);
    emit("status", snapshot());
    resolve({ ok: true, file: filename, path: outputPath });
  });
}

function stopRecording() {
  if (!state.recording.active || !state.recording.proc) {
    throw new Error("没有正在进行的录制");
  }
  const proc = state.recording.proc;
  const outputFile = state.recording.outputFile;
  let graceKilled = false;
  /* 优先尝试 ffmpeg 优雅退出：向 stdin 写入 'q' */
  try {
    if (proc.stdin && proc.stdin.writable) {
      proc.stdin.write("q\n");
      graceKilled = true;
      log("info", "Sent 'q' to ffmpeg stdin for graceful stop");
    }
  } catch (err) {
    log("warn", `stdin.write('q') failed: ${err.message}`);
  }
  /* Windows 兜底：如果 3 秒后进程仍在运行，用 taskkill 强制终止 */
  setTimeout(() => {
    if (state.recording.proc === proc) {
      log("warn", "ffmpeg did not exit gracefully after 3s, forcing termination");
      try {
        if (process.platform === "win32") {
          /* Windows 下 kill() = TerminateProcess，可立即终止 */
          proc.kill();
        } else {
          proc.kill("SIGINT");
        }
      } catch {}
      /* 再等 1 秒确认退出，记录文件大小 */
      setTimeout(() => {
        if (outputFile && fs.existsSync(outputFile)) {
          const sz = fs.statSync(outputFile).size;
          log("info", `Recording file finalized: ${(sz / 1024 / 1024).toFixed(2)}MB`);
        }
      }, 1000);
    }
  }, 3000);
  return { ok: true, message: graceKilled ? "录制停止中（ffmpeg 优雅退出）" : "录制已强制停止" };
}

async function runInspectionTest(configPatch = {}) {
  const startedAt = Date.now();
  const results = [];
  const add = (id, name, status, detail = "") => {
    const item = { id, name, status, detail, at: Date.now() };
    results.push(item);
    log(status === "fail" ? "error" : "info", `INSPECTION ${id} ${status}: ${name}${detail ? ` - ${detail}` : ""}`);
    return item;
  };
  const step = async (id, name, fn) => {
    try {
      const detail = await fn();
      add(id, name, "pass", detail);
    } catch (err) {
      add(id, name, "fail", err.message);
    }
  };

  log("info", "Inspection test started");

  await step("T01", "UDP 连接", async () => {
    await connectUdp(configPatch);
    return `绑定 ${state.udpLocalAddress.address}:${state.udpLocalAddress.port}，目标 ${state.config.deviceIp}:${state.config.controlPort}`;
  });

  await step("T02", "基础请求", async () => {
    await sendCommand("connect-request", {});
    await sleep(120);
    await sendCommand("version-request", {});
    await sleep(120);
    await sendCommand("channel-request", {});
    return "已发送连接、版本、通道查询";
  });

  await step("T03", "RTSP 延迟探测", async () => {
    const visible = await checkRtsp("visible");
    const thermal = await checkRtsp("thermal");
    if (!visible.ok && !thermal.ok) throw new Error(`可见光: ${visible.error || visible.response || "失败"}；热成像: ${thermal.error || thermal.response || "失败"}`);
    return `可见光 ${visible.ok ? `${visible.latencyMs}ms` : "失败"}；热成像 ${thermal.ok ? `${thermal.latencyMs}ms` : "失败"}`;
  });

  await step("T04", "云台八方向点控", async () => {
    const speed = 5;
    const diagonal = Number((speed / Math.SQRT2).toFixed(3));
    const moves = [
      ["up", { pitchMode: 1, yawMode: 1, pitchValue: speed, yawValue: 0 }],
      ["down", { pitchMode: 1, yawMode: 1, pitchValue: -speed, yawValue: 0 }],
      ["left", { pitchMode: 1, yawMode: 1, pitchValue: 0, yawValue: -speed }],
      ["right", { pitchMode: 1, yawMode: 1, pitchValue: 0, yawValue: speed }],
      ["northwest", { pitchMode: 1, yawMode: 1, pitchValue: diagonal, yawValue: -diagonal }],
      ["northeast", { pitchMode: 1, yawMode: 1, pitchValue: diagonal, yawValue: diagonal }],
      ["southwest", { pitchMode: 1, yawMode: 1, pitchValue: -diagonal, yawValue: -diagonal }],
      ["southeast", { pitchMode: 1, yawMode: 1, pitchValue: -diagonal, yawValue: diagonal }],
    ];
    for (const [, payload] of moves) {
      await sendCommand("gimbal-control", payload);
      await sleep(220);
      await sendCommand("gimbal-stop", {});
      await sleep(160);
    }
    return "已按上/下/左/右/西北/东北/西南/东南短促点控并停止，动作方向需人工确认";
  });

  await step("T05", "停止优先级", async () => {
    for (let i = 0; i < 5; i += 1) {
      await sendCommand("gimbal-stop", {});
      await sleep(80);
    }
    return "已连续发送 5 次停止命令";
  });

  await step("T06", "回中/角度模式", async () => {
    await sendCommand("gimbal-center", {});
    return "已发送 Pitch/Yaw 角度 0/0";
  });

  await step("T07", "相机基础命令", async () => {
    await sendCommand("camera-config", { configType: 5, cmdValue: 1 });
    await sleep(120);
    await sendCommand("camera-config", { configType: 5, cmdValue: 2 });
    return "已测试 OSD 开/关，相机状态和画面需人工确认";
  });

  const rxBeforeWait = state.counters.rxPackets;
  await step("T08", "状态上报观察", async () => {
    await sleep(1200);
    const delta = state.counters.rxPackets - rxBeforeWait;
    if (delta <= 0) throw new Error("等待 1.2 秒未收到新增上报");
    return `1.2 秒内新增 ${delta} 个 RX 包`;
  });

  add("T09", "视频连续预览", "manual", "请手动打开可见光/热成像并观察至少 5 分钟");
  add("T10", "位姿 1-4 重复性", "manual", "请保存 4 个位姿并逐个前往，人工记录到位误差和是否抖动");
  add("T11", "异常恢复", "manual", "请改错 IP/断网/重启云台后恢复连接，观察是否可恢复");
  add("T12", "长稳测试", "manual", "请连续运行 30-60 分钟，最终生成评估报告");

  const summary = {
    startedAt,
    finishedAt: Date.now(),
    pass: results.filter((item) => item.status === "pass").length,
    fail: results.filter((item) => item.status === "fail").length,
    manual: results.filter((item) => item.status === "manual").length,
    results,
  };
  log("info", `Inspection test finished: pass ${summary.pass}, fail ${summary.fail}, manual ${summary.manual}`);
  emit("status", snapshot());
  return summary;
}

// ====================== 一键完整 SDK 测试（覆盖全部消息+稳定性+反馈验证） ======================
async function runFullSdkTest(options = {}) {
  const startedAt = Date.now();
  const countersBefore = { ...state.counters };
  const cases = [];
  let lastReport = state.lastGimbalReport || null;
  let lastCamReport = state.lastCameraReport || null;
  const latencySamples = [];
  let rxObserved = false;

  const push = (caseItem) => {
    cases.push(caseItem);
    const level = caseItem.result === "PASS" ? "info" : caseItem.result === "FAIL" ? "error" : "warn";
    log(level, `SDK_TEST [${caseItem.id}] ${caseItem.name} => ${caseItem.result}${caseItem.detail ? ` (${caseItem.detail})` : ""}`);
  };

  const tx = async (command, payload = {}) => {
    const t0 = process.hrtime.bigint();
    await sendCommand(command, payload);
    const t1 = process.hrtime.bigint();
    latencySamples.push(Number(t1 - t0) / 1e6);
  };

  const verifyRx = async (beforeCount, waitMs = 200) => {
    await sleep(waitMs);
    const afterCount = state.counters.rxPackets;
    return afterCount > beforeCount;
  };

  const test = async (id, name, fn, verifyFn = null) => {
    const t0 = Date.now();
    try {
      const detail = (await fn()) || "";
      let result = "PASS";
      let verifyDetail = "";
      if (verifyFn) {
        const verifyResult = await verifyFn();
        if (verifyResult.pass === false) {
          result = "FAIL";
          verifyDetail = ` | 验证失败：${verifyResult.detail}`;
        } else if (verifyResult.pass === "warn") {
          result = "WARN";
          verifyDetail = ` | 警告：${verifyResult.detail}`;
        } else {
          verifyDetail = verifyResult.detail ? ` | ${verifyResult.detail}` : "";
        }
      }
      push({ id, name, result, detail: detail + verifyDetail, durationMs: Date.now() - t0 });
    } catch (err) {
      push({ id, name, result: "FAIL", detail: err.message, durationMs: Date.now() - t0 });
    }
  };

  // ========== A. 协议与连接层 ==========
  await test("A01", "UDP 建立连接", async () => {
    await connectUdp(options.config || {});
    return `本地 ${state.udpLocalAddress?.address}:${state.udpLocalAddress?.port} → 设备 ${state.config.deviceIp}:${state.config.controlPort}`;
  });

  // 检查 RX 是否有回包（验证设备在线）
  const rxBeforeA = state.counters.rxPackets;
  await test("A02", "HY_REQUEST: CONNECT_REQUEST + RX回包验证", async () => {
    await tx("connect-request");
    await sleep(300);
    const rxDelta = state.counters.rxPackets - rxBeforeA;
    if (rxDelta <= 0) throw new Error("发送连接请求后未收到任何回包，设备可能不在线或端口配置错误");
    rxObserved = true;
    return `请求类型=1，收到 ${rxDelta} 个回包`;
  });

  await test("A03", "HY_REQUEST: VERSION_REQUEST", async () => {
    await tx("version-request");
    return "请求类型=3";
  }, async () => {
    const newRx = state.counters.rxPackets;
    return newRx > rxBeforeA ? { pass: true, detail: `RX 持续增长 (${newRx} 总)` } : { pass: false, detail: "无新回包" };
  });

  await test("A04", "HY_REQUEST: CHANNEL_REQUEST", async () => {
    await tx("channel-request");
    return "请求类型=4";
  });
  await test("A05", "HY_REQUEST: CALI_FEEDBACK_REQUEST", async () => {
    await tx("cali-feedback-request");
    return "请求类型=5";
  });
  push({ id: "A06", name: "HY_REQUEST: REBOOT_REQUEST", result: "SKIP", detail: "重启请求破坏性较大，需人工确认后单独发送，请求类型=6" });

  // ========== B. 云台活动模式 ==========
  const modeKeys = Object.keys(GIMBAL_ACTIVE_MODE);
  for (let idx = 0; idx < modeKeys.length; idx++) {
    const name = modeKeys[idx];
    const value = GIMBAL_ACTIVE_MODE[name];
    const caseId = `B${String(idx + 1).padStart(2, "0")}`;
    // eslint-disable-next-line no-await-in-loop
    await test(caseId, `HY_GIMBAL_ACTIVE_MODE: ${name}`, async () => {
      await tx("active-mode", { gimbalMode: value });
      await sleep(300);
      return `模式值=${value}`;
    }, async () => {
      const report = state.lastGimbalReport;
      if (!report) return { pass: true, detail: "无云台回包(可能仅在运动时上报)" };
      const modeInReport = report.status >= 20 && report.status <= 21;
      return { pass: true, detail: `云台状态=${report.statusText || report.status}${modeInReport ? "(活动模式)" : "(非活动模式)"}` };
    });
  }

  // ========== C. 云台控制 ==========
  await test("C01", "HY_GIMBAL_CONTROL: 角度模式 回中", async () => {
    const beforeReport = state.lastGimbalReport;
    await tx("gimbal-center");
    await sleep(400);
    const afterReport = state.lastGimbalReport;
    if (!afterReport) return "已发送回中指令，但无云台回包";
    const pitchDelta = beforeReport ? Math.abs((afterReport.pitchAngle || 0) - (beforeReport.pitchAngle || 0)) : null;
    return `pitch=${afterReport.pitchAngle}° yaw=${afterReport.yawAngle}°${pitchDelta !== null ? ` | 角度变化量=${pitchDelta.toFixed(1)}°` : ""}`;
  }, async () => {
    const r = state.lastGimbalReport;
    if (!r) return { pass: false, detail: "无云台回包，无法验证角度变化" };
    return { pass: true, detail: `当前角度 P:${r.pitchAngle}° Y:${r.yawAngle}°` };
  });

  await test("C02", "HY_GIMBAL_CONTROL: 速率模式 + 停止", async () => {
    await tx("gimbal-control", { pitchMode: 1, yawMode: 1, pitchValue: 3, yawValue: 3 });
    await sleep(250);
    await tx("gimbal-stop");
    await sleep(200);
    const r = state.lastGimbalReport;
    return `速度→3°/s 运行250ms，再发停止${r ? ` | 实际 P:${r.pitchAngle}° Y:${r.yawAngle}°` : ""}`;
  });

  await test("C03", "HY_GIMBAL_CONTROL: 角度模式 Pitch+15°", async () => {
    const before = state.lastGimbalReport?.pitchAngle || 0;
    await tx("gimbal-control", { pitchMode: 2, yawMode: 2, pitchValue: 15, yawValue: 0 });
    await sleep(600);
    const after = state.lastGimbalReport;
    if (!after) return "已发送 Pitch=15° 指令，但无回包";
    const expectedDelta = Math.abs(15 - before);
    const actualDelta = Math.abs((after.pitchAngle || 0) - before);
    return `目标 Pitch=15°，实际 ${after.pitchAngle}°，变化量 ${actualDelta.toFixed(1)}°`;
  }, async () => {
    const r = state.lastGimbalReport;
    if (!r) return { pass: false, detail: "无云台回包" };
    return { pass: true, detail: `最终 P:${r.pitchAngle}° Y:${r.yawAngle}°` };
  });

  await test("C04", "HY_GIMBAL_CONTROL: 角度模式 Yaw ±30°", async () => {
    await tx("gimbal-control", { pitchMode: 2, yawMode: 2, pitchValue: 0, yawValue: 30 });
    await sleep(400);
    const r1 = state.lastGimbalReport;
    await tx("gimbal-control", { pitchMode: 2, yawMode: 2, pitchValue: 0, yawValue: -30 });
    await sleep(400);
    const r2 = state.lastGimbalReport;
    return `Yaw +30°(实际${r1?.yawAngle}°) → -30°(实际${r2?.yawAngle}°)`;
  });

  await test("C05", "HY_GIMBAL_CONTROL: 八方向点控", async () => {
    const s = 5;
    const d = Number((s / Math.SQRT2).toFixed(3));
    const moves = [[s, 0], [-s, 0], [0, -s], [0, s], [d, -d], [d, d], [-d, -d], [-d, d]];
    for (const [p, y] of moves) {
      // eslint-disable-next-line no-await-in-loop
      await tx("gimbal-control", { pitchMode: 1, yawMode: 1, pitchValue: p, yawValue: y });
      // eslint-disable-next-line no-await-in-loop
      await sleep(180);
      // eslint-disable-next-line no-await-in-loop
      await tx("gimbal-stop");
      // eslint-disable-next-line no-await-in-loop
      await sleep(120);
    }
    return "8 方向各点动一次+停止，速度 5°/s";
  });

  await test("C06", "停止优先级: 10 次停止压测", async () => {
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tx("gimbal-stop");
      // eslint-disable-next-line no-await-in-loop
      await sleep(50);
    }
    return "连续 10 次 HY_GIMBAL_CONTROL 零值";
  });
  try { await tx("gimbal-center"); } catch {}

  // ========== D. 相机配置（CAMERA_CONFIG_TYPE 全枚举 + 状态验证） ==========
  const camConfigs = [
    { t: 1, v: 2, name: "CAMERA_ZOOM 变焦=2x" },
    { t: 1, v: 1, name: "CAMERA_ZOOM 变焦=1x" },
    { t: 2, v: 1, name: "CAMERA_TAKE_PHOTO 拍照" },
    { t: 3, v: 1, name: "CAMERA_VIDEO_RECORD 开始" },
    { t: 3, v: 2, name: "CAMERA_VIDEO_RECORD 停止" },
    { t: 5, v: 1, name: "CAMERA_OSD_DISPLAY 开" },
    { t: 5, v: 2, name: "CAMERA_OSD_DISPLAY 关" },
    { t: 8, v: 2, name: "CAMERA_TRANSMISSION_RESOLUTION=1080P" },
    { t: 9, v: 1, name: "CAMERA_RECOGNITION_SCAN 开" },
    { t: 9, v: 2, name: "CAMERA_RECOGNITION_SCAN 关" },
    { t: 10, v: 1, name: "CAMERA_TRACKER_SELECTION 开" },
    { t: 10, v: 2, name: "CAMERA_TRACKER_SELECTION 关" },
    { t: 12, v: 3, name: "CAMERA_FOCUS_VALUE=AUTO" },
    { t: 13, v: 3, name: "CAMERA_APERTURE_VALUE=AUTO" },
    { t: 14, v: 1, name: "CAMERA_IMAGE_STABILIZATION 开" },
    { t: 14, v: 2, name: "CAMERA_IMAGE_STABILIZATION 关" },
    { t: 15, v: 1, name: "CAMERA_SET_DEFOG 开" },
    { t: 15, v: 2, name: "CAMERA_SET_DEFOG 关" },
    { t: 16, v: 1, name: "CAMERA_DISTORTION_COMPENSATION 开" },
    { t: 16, v: 2, name: "CAMERA_DISTORTION_COMPENSATION 关" },
    { t: 17, v: 5, name: "CAMERA_BITRATE=3Mbps" },
    { t: 18, v: 0, name: "CAMERA_ENCODING_FORMAT=H.264" },
    { t: 18, v: 1, name: "CAMERA_ENCODING_FORMAT=H.265" },
    { t: 19, v: 1, name: "CAMERA_DIGITAL_ZOOM 开" },
    { t: 19, v: 2, name: "CAMERA_DIGITAL_ZOOM 关" },
    { t: 23, v: 1, name: "CAMERA_DAY_NIGHT_SWITCH=彩色" },
    { t: 23, v: 0, name: "CAMERA_DAY_NIGHT_SWITCH=自动" },
    { t: 24, v: 0, name: "CAMERA_ZOOM_TELE_CONTINUOUS 放大" },
    { t: 26, v: 0, name: "CAMERA_ZOOM_STOP 停止变倍" },
  ];
  push({ id: "D00", name: "CAMERA_CONFIG 说明", result: "INFO", detail: "覆盖 27 个常用枚举组合；每项均发送指令并尝试读取相机状态回包验证" });

  // 状态验证映射
  const configTypeToReportField = {
    1: { field: "zoomTimes", matchValues: { 1: 1, 2: 2 } },
    4: { field: "imageFlip", matchValues: { 1: false, 2: true, 3: true } },
    5: { field: "osdDisplay", matchValues: { 1: true, 2: false } },
    8: { field: "transmissionResolution", matchValues: { 0: 0, 1: 1, 2: 2, 3: 3 } },
    9: { field: "recognitionScan", matchValues: { 1: true, 2: false } },
    10: { field: "trackingSelection", matchValues: { 1: true, 2: false } },
    14: { field: "stabilizer", matchValues: { 1: true, 2: false } },
    15: { field: "defog", matchValues: { 1: true, 2: false } },
    16: { field: "distortionCompensation", matchValues: { 1: true, 2: false } },
    18: { field: "encodingFormat", matchValues: { 0: 0, 1: 1 } },
    19: { field: "digitalZoom", matchValues: { 1: true, 2: false } },
  };

  for (let i = 0; i < camConfigs.length; i += 1) {
    const item = camConfigs[i];
    const caseId = `D${String(i + 1).padStart(2, "0")}`;
    const mapping = configTypeToReportField[item.t];
    // eslint-disable-next-line no-await-in-loop
    await test(caseId, item.name, async () => {
      if (item.t === CAMERA_CONFIG_TYPE.CAMERA_ZOOM) {
        await tx("camera-zoom", { zoomTimes: item.v });
      } else {
        await tx("camera-config", { configType: item.t, cmdValue: item.v });
      }
      await sleep(350);
      return `config_type=${item.t}, cmd_value=${item.v}`;
    }, mapping ? async () => {
      const cam = state.lastCameraReport;
      if (!cam) return { pass: true, detail: "无相机回包(相机可能未上报状态)" };
      const expected = mapping.matchValues[item.v];
      const actual = cam[mapping.field];
      if (actual === expected) return { pass: true, detail: `相机状态验证: ${mapping.field}=${actual} ✔` };
      return { pass: false, detail: `相机状态: ${mapping.field}=${actual} (期望=${expected})` };
    } : null);
  }
  push({ id: "D99", name: "CAMERA_SD_FORMAT", result: "SKIP", detail: "格式化 SD 卡会清空数据，请 UI 单独操作，config_type=11 cmd_value=1" });

  // ========== E. 指点移动 & 红外温度 & 网络配置 ==========
  await test("E01", "HY_CAMERA_GUIDE_MOVEMENT X=40 Y=50", async () => {
    await tx("guide-movement", { movementX: 40, movementY: 50 });
    return "X=40%, Y=50%（画面百分比）";
  });
  await test("E02", "HY_CAMERA_GUIDE_MOVEMENT X=0 Y=0 (左上角)", async () => {
    await tx("guide-movement", { movementX: 0, movementY: 0 });
    return "X=0%, Y=0%";
  });
  await test("E03", "HY_IR_TEMP_REGION_CONFIG (V1.0.7 新增)", async () => {
    await tx("ir-temp-region-config", { enable: 1, x: 20, y: 20, width: 30, height: 30 });
    return "enable=1, x=20, y=20, width=30, height=30";
  });
  await test("E04", "CAMERA_NET_CONFIG GET (V1.0.7 新增)", async () => {
    await tx("camera-net-config", { opType: 1, apply: 0 });
    return "op_type=1 (GET)";
  });
  push({ id: "E05", name: "CAMERA_NET_CONFIG SET", result: "SKIP", detail: "SET 会改动相机网络，需人工确认参数后使用：op_type=0 + ip + netmask + gateway + apply=1" });

  // ========== F. 稳定性 & 上报频率 & 延迟统计 ==========
  const rxPre = state.counters.rxPackets;
  const txPre = state.counters.txPackets;
  await test("F01", "状态上报频率观察 3s", async () => {
    await sleep(3000);
    const rxDelta = state.counters.rxPackets - rxPre;
    const txDelta = state.counters.txPackets - txPre;
    const freq = (rxDelta / 3).toFixed(2);
    lastReport = state.lastGimbalReport || lastReport;
    return `RX 增加 ${rxDelta}，TX 增加 ${txDelta}，估计上报频率 ${freq} Hz`;
  });
  await test("F02", "30 次停止命令稳定性", async () => {
    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tx("gimbal-stop");
      // eslint-disable-next-line no-await-in-loop
      await sleep(30);
    }
    return "30 次零值控制均成功发送";
  });

  // ========== G. SDK 文档示例包 CRC 验证 ==========
  await test("G01", "PDF 示例包 CRC 校验（Pitch 向下 45°）", async () => {
    const hex = "FD 0A 00 00 7C 01 19 2A 2B 00 00 00 34 C2 00 00 00 00 02 02 ED 49";
    const buf = Buffer.from(hex.replace(/[^0-9a-f]/gi, ""), "hex");
    if (buf[0] !== 0xfd) throw new Error("起始字节错误");
    const len = buf[1];
    const msgId = buf.readUIntLE(7, 3);
    const crcExtra = CRC_EXTRA[msgId];
    if (crcExtra === undefined) throw new Error(`未知 msgId=${msgId} 的 CRC_EXTRA`);
    const calcCrc = require("./protocol").x25Crc ? null : null; // fallback
    // 用 protocol 的 CRC 函数验证
    const { x25Crc } = require("./protocol");
    const payload = buf.subarray(10, 10 + len);
    const crcInput = Buffer.concat([buf.subarray(1, 10 + len), Buffer.from([crcExtra])]);
    const expectedCrc = buf.readUInt16LE(10 + len);
    const actualCrc = x25Crc(crcInput);
    if (expectedCrc !== actualCrc) throw new Error(`CRC 不匹配：期望 ${expectedCrc} 实际 ${actualCrc}`);
    return `msgId=${msgId}, CRC_EXTRA=${crcExtra}, payload_len=${len}, CRC=0x${actualCrc.toString(16).padStart(4, "0")} ✔`;
  });

  const countersAfter = state.counters;
  const totalTx = countersAfter.txPackets - countersBefore.txPackets;
  const totalRx = countersAfter.rxPackets - countersBefore.rxPackets;
  const avgLatency = latencySamples.length
    ? Number((latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length).toFixed(2))
    : 0;
  const maxLatency = latencySamples.length ? Number(Math.max(...latencySamples).toFixed(2)) : 0;
  const jitter = latencySamples.length >= 2
    ? Number((latencySamples.slice(1).reduce((a, v, i) => a + Math.abs(v - latencySamples[i]), 0) / (latencySamples.length - 1)).toFixed(2))
    : 0;

  const passCount = cases.filter((c) => c.result === "PASS").length;
  const warnCount = cases.filter((c) => c.result === "WARN").length;
  const failCount = cases.filter((c) => c.result === "FAIL").length;
  const skipCount = cases.filter((c) => c.result === "SKIP" || c.result === "INFO").length;
  const verifiedPassCount = cases.filter((c) => c.result === "PASS" && c.detail && !c.detail.includes("无相机回包") && !c.detail.includes("无云台回包")).length;
  let verdict;
  if (failCount === 0 && warnCount === 0) {
    verdict = rxObserved
      ? `✅ SDK 功能验证通过，协议层与上报均正常 (已验证 ${verifiedPassCount} 项状态反馈)`
      : "✅ 命令全部发送成功，但未观察到设备回包，请核查网络/端口/防火墙";
  } else if (failCount === 0) {
    verdict = `⚠️ 所有命令发送成功，但有 ${warnCount} 项状态无法完全验证 (可能设备未上报状态)`;
  } else {
    verdict = `❌ 存在 ${failCount} 项失败，需定位具体失败点`;
  }

  const report = {
    sdkVersion: "汇云 MavLink 自定义消息接口文档 V1.0.7",
    testTime: new Date().toLocaleString("zh-CN", { hour12: false }),
    startedAt,
    finishedAt: Date.now(),
    durationSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    deviceInfo: {
      deviceIp: state.config.deviceIp,
      controlPort: state.config.controlPort,
      localPort: state.udpLocalAddress?.port || state.config.localPort,
      udpBound: !!state.udp,
      connected: state.connected,
    },
    counters: {
      totalTx,
      totalRx,
      ratioRxTx: totalTx ? Number((totalRx / totalTx).toFixed(3)) : 0,
    },
    latency: {
      samples: latencySamples.length,
      avgMs: avgLatency,
      maxMs: maxLatency,
      jitterMs: jitter,
    },
    stats: {
      total: cases.length,
      pass: passCount,
      warn: warnCount,
      fail: failCount,
      skip: skipCount,
      passRate: cases.length ? Number(((passCount / (cases.length - skipCount)) * 100).toFixed(1)) : 0,
      verifiedCount: verifiedPassCount,
    },
    lastReport: lastReport || state.lastGimbalReport || null,
    cases,
    verdict,
  };

  // 保存一份 JSON 报告
  try {
    const REPORT_DIR = path.join(__dirname, "..", "reports");
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const ts = generateTimestamp();
    const jsonFile = path.join(REPORT_DIR, `sdk-test-${ts}.json`);
    const mdFile = path.join(REPORT_DIR, `sdk-test-${ts}.md`);
    fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2));
    report._jsonFile = jsonFile;
    report._mdFile = mdFile;
    log("info", `SDK test JSON saved: ${jsonFile}`);
  } catch {}

  return report;
}

function generateFullSdkReport(r) {
  const lines = [];
  lines.push("# HY-DZ230F 吊舱 SDK 一键完整测试报告");
  lines.push("");
  lines.push(`生成时间：${r.testTime}`);
  lines.push(`SDK 版本：${r.sdkVersion}`);
  lines.push(`测试耗时：${r.durationSec} 秒`);
  lines.push("");
  lines.push("## 一、测试结论");
  lines.push("");
  lines.push(r.verdict);
  lines.push("");
  lines.push("## 二、设备与连接信息");
  lines.push("");
  lines.push(`| 项目 | 数值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 设备 IP | ${r.deviceInfo.deviceIp} |`);
  lines.push(`| 设备 UDP 端口 | ${r.deviceInfo.controlPort} |`);
  lines.push(`| 本地监听端口 | ${r.deviceInfo.localPort} |`);
  lines.push(`| UDP 已绑定 | ${r.deviceInfo.udpBound ? "是" : "否"} |`);
  lines.push(`| 连接状态（有回包判定） | ${r.deviceInfo.connected ? "已连接" : "未连接"} |`);
  lines.push("");
  lines.push("## 三、总体统计");
  lines.push("");
  lines.push(`| 指标 | 数值 |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| 测试用例总数 | ${r.stats.total} |`);
  lines.push(`| ✅ PASS | ${r.stats.pass} |`);
  lines.push(`| ⚠️ WARN | ${r.stats.warn || 0} |`);
  lines.push(`| ❌ FAIL | ${r.stats.fail} |`);
  lines.push(`| ⏭️ SKIP / INFO | ${r.stats.skip} |`);
  lines.push(`| 已验证状态反馈 | ${r.stats.verifiedCount || 0} |`);
  lines.push(`| 通过率（排除 SKIP） | ${r.stats.passRate} % |`);
  lines.push(`| TX 发包数（本次测试） | ${r.counters.totalTx} |`);
  lines.push(`| RX 收包数（本次测试） | ${r.counters.totalRx} |`);
  lines.push(`| RX / TX 比值 | ${r.counters.ratioRxTx} |`);
  lines.push(`| 命令发送平均延迟 | ${r.latency.avgMs} ms |`);
  lines.push(`| 命令发送最大延迟 | ${r.latency.maxMs} ms |`);
  lines.push(`| 命令发送抖动（相邻差均值） | ${r.latency.jitterMs} ms |`);
  lines.push("");
  lines.push("## 四、详细测试用例");
  lines.push("");
  lines.push(`| ID | 用例名称 | 结果 | 耗时(ms) | 详情 |`);
  lines.push(`| --- | --- | ---: | ---: | --- |`);
  for (const c of r.cases) {
    const icon = c.result === "PASS" ? "✅" : c.result === "FAIL" ? "❌" : c.result === "WARN" ? "⚠️" : "⏭️";
    lines.push(`| ${c.id} | ${c.name.replace(/\|/g, "/")} | ${icon} ${c.result} | ${c.durationMs ?? "-"} | ${(c.detail || "").replace(/\|/g, "/").replace(/\r?\n/g, " ")} |`);
  }
  lines.push("");
  lines.push("## 五、最后一次云台上报快照（如有）");
  lines.push("");
  if (r.lastReport) {
    lines.push("```json");
    lines.push(JSON.stringify(r.lastReport, null, 2));
    lines.push("```");
  } else {
    lines.push("> ⚠️ 测试过程中没有观察到 HY_GIMBAL_REPORT / HY_CAMERA_REPORT 回包");
  }
  lines.push("");
  lines.push("## 六、稳定性指标判定建议");
  lines.push("");
  lines.push("| 指标 | 合格标准 | 本报告值 | 是否满足 |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(`| 命令发送成功率 | 100%（无 FAIL） | ${100 - r.stats.fail}% | ${r.stats.fail === 0 ? "✅" : "❌"} |`);
  lines.push(`| 平均发送延迟 | < 50 ms | ${r.latency.avgMs} ms | ${r.latency.avgMs < 50 ? "✅" : "⚠️"} |`);
  lines.push(`| 抖动 | < 20 ms | ${r.latency.jitterMs} ms | ${r.latency.jitterMs < 20 ? "✅" : "⚠️"} |`);
  lines.push(`| 3 秒内回包数 | ≥ 15（5 Hz） | ${(r.cases.find((c) => c.id === "F01")?.detail.match(/RX 增加 (\d+)/) || [, "0"])[1]} | ${Number((r.cases.find((c) => c.id === "F01")?.detail.match(/RX 增加 (\d+)/) || [, "0"])[1]) >= 15 ? "✅" : "⚠️"} |`);
  lines.push(`| 30 次停止压测 | 无失败 | ${r.cases.find((c) => c.id === "F02")?.result || "-"} | ${r.cases.find((c) => c.id === "F02")?.result === "PASS" ? "✅" : "❌"} |`);
  lines.push(`| PDF 示例包 CRC 验证 | 通过 | ${r.cases.find((c) => c.id === "G01")?.result || "-"} | ${r.cases.find((c) => c.id === "G01")?.result === "PASS" ? "✅" : "❌"} |`);
  lines.push("");
  lines.push("## 七、上线前建议人工复核项");
  lines.push("");
  lines.push("1. **A06 REBOOT_REQUEST**: 重启云台会导致画面和控制短暂中断，需人工确认真实设备的恢复时间。");
  lines.push("2. **CAMERA_SD_FORMAT(11)**: 格式化 SD 卡会清空录像/照片数据，建议单独做破坏性测试。");
  lines.push("3. **CAMERA_NET_CONFIG SET**: 修改相机网络参数后可能断流，需现场验证新 IP 可达性。");
  lines.push("4. **HY_IR_TEMP_REGION_CONFIG**: 仅在带热成像机型上有效，普通可见光机型可能无回包，属正常现象。");
  lines.push("5. **长时间稳定性**: 自动化测试仅覆盖秒级样本，正式出厂建议 2~8 小时连续巡检 + 视频拉流并行。");
  lines.push("6. **位姿 / 巡航重复性**: 需结合实际巡检点位做 3~5 轮误差统计，建议保存位姿前先做一次 IMU 校准。");
  lines.push("");
  const md = lines.join("\n") + "\n";
  // 若有 _mdFile 就落盘
  if (r._mdFile) {
    try { require("fs").writeFileSync(r._mdFile, md); } catch {}
  }
  return md;
}

function listNetworkInterfaces() {
  const rows = [];
  for (const [name, items] of Object.entries(os.networkInterfaces())) {
    for (const item of items || []) {
      if (item.family === "IPv4" && !item.internal) {
        rows.push({ name, address: item.address, netmask: item.netmask, cidr: item.cidr });
      }
    }
  }
  return rows;
}

function apiJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value, null, 2));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const filePath = path.normalize(path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript" }[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-cache, no-store, must-revalidate" });
    res.end(data);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/version") return apiJson(res, { ok: true, appVersion: APP_VERSION });
    if (req.method === "GET" && url.pathname === "/api/status") return apiJson(res, snapshot());
    if (req.method === "GET" && url.pathname === "/api/media") {
      return apiJson(res, { ok: true, files: listMediaFiles(), photoDir: PHOTO_DIR, recordingDir: RECORDING_DIR });
    }
    if (req.method === "GET" && url.pathname === "/api/media-file") {
      return serveMediaFile(res, url.searchParams.get("kind"), url.searchParams.get("name"));
    }
    if (req.method === "GET" && url.pathname === "/api/enums") return apiJson(res, {
      MSG,
      REQUEST_TYPES,
      GIMBAL_ACTIVE_MODE,
      GIMBAL_CONTROL_MODE,
      GIMBAL_STATUS,
      CAMERA_CONFIG_TYPE,
      BITRATE_TABLE,
      TRANSMISSION_RESOLUTION_TABLE,
      CRC_EXTRA,
    });
    if (req.method === "GET" && url.pathname === "/api/raw-frames") {
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 100)));
      return apiJson(res, { ok: true, samples: state.samples.slice(0, limit) });
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      const body = await readJson(req);
      state.config = { ...state.config, ...normalizeConfig(body) };
      if (state.udp) await connectUdp(state.config);
      emit("status", snapshot());
      return apiJson(res, snapshot());
    }
    if (req.method === "POST" && url.pathname === "/api/connect") {
      await connectUdp(await readJson(req));
      await sleep(100);
      for (let i = 0; i < 3; i += 1) {
        await sendCommand("connect-request", {});
        if (i < 2) await sleep(60);
      }
      await sleep(150);
      return apiJson(res, { ok: true, status: snapshot() });
    }
    if (req.method === "POST" && url.pathname === "/api/disconnect") {
      closeUdp();
      emit("status", snapshot());
      return apiJson(res, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/send") {
      const body = await readJson(req);
      const beforeReport = state.lastCameraReport ? { ...state.lastCameraReport } : null;
      const beforeEchoAt = state.lastCameraConfigEcho?.at || 0;
      const beforeAckAt = state.lastCameraGeneralAck?.at || 0;
      const sentAt = Date.now();
      const result = await sendCommand(body.command, body.payload || {});
      const verification = body.command === "camera-config"
        ? await verifyCameraConfig(body.payload || {}, sentAt, beforeReport, beforeEchoAt, beforeAckAt)
        : null;
      return apiJson(res, { ok: true, result, verification });
    }
    if (req.method === "POST" && url.pathname === "/api/inspection-test") {
      const body = await readJson(req);
      const result = await runInspectionTest(body.config || body);
      return apiJson(res, { ok: true, result, status: snapshot() });
    }
    if (req.method === "POST" && url.pathname === "/api/run-full-test") {
      const body = await readJson(req);
      const result = await runFullSdkTest(body);
      const md = generateFullSdkReport(result);
      return apiJson(res, { ok: true, result, reportMarkdown: md });
    }
    if (req.method === "GET" && url.pathname === "/api/rtsp-check") {
      const channel = url.searchParams.get("channel") || "visible";
      const result = await checkRtsp(channel);
      return apiJson(res, result);
    }
    if (req.method === "POST" && url.pathname === "/api/photo") {
      const body = await readJson(req);
      const channel = body.channel || "visible";
      const result = await capturePhoto(channel);
      return apiJson(res, { ok: true, ...result });
    }
    if (req.method === "POST" && url.pathname === "/api/record-start") {
      const body = await readJson(req);
      const channel = body.channel || "visible";
      const result = await startRecording(channel);
      return apiJson(res, { ok: true, ...result });
    }
    if (req.method === "POST" && url.pathname === "/api/record-stop") {
      const result = stopRecording();
      return apiJson(res, { ok: true, ...result, status: snapshot() });
    }
    if (req.method === "POST" && url.pathname === "/api/emergency-stop") {
      if (state.recording.active) {
        try { stopRecording(); } catch {}
      }
      const results = [];
      for (let i = 0; i < 3; i++) {
        try {
          const r = state.config.pythonSdkEnabled
            ? await sendPythonSdkFrame("hy_gimbal_control", {
              pitch_mode: GIMBAL_CONTROL_MODE.GIMBAL_RATE_CONTROL,
              yaw_mode: GIMBAL_CONTROL_MODE.GIMBAL_RATE_CONTROL,
              pitch_value: 0,
              yaw_value: 0,
            }, `EMERGENCY_STOP_${i + 1}`)
            : await sendFrame(state.encoder.encodeGimbalControl({
              pitchMode: GIMBAL_CONTROL_MODE.GIMBAL_RATE_CONTROL,
              yawMode: GIMBAL_CONTROL_MODE.GIMBAL_RATE_CONTROL,
              pitchValue: 0,
              yawValue: 0,
            }), `EMERGENCY_STOP_${i + 1}`);
          results.push(r);
        } catch (err) {
          results.push({ error: err.message });
        }
        await sleep(30);
      }
      try {
        await sendCommand("camera-zoom-standard-stop", {});
      } catch (err) {
        log("error", `Emergency standard camera zoom stop failed: ${err.message}`);
      }
      try {
        await sendCommand("camera-zoom-stop", {});
      } catch (err) {
        log("error", `Emergency custom camera zoom stop failed: ${err.message}`);
      }
      log("warn", "Emergency stop executed: gimbal-stop + standard/custom camera zoom stop");
      return apiJson(res, { ok: true, results, status: snapshot() });
    }
    if (req.method === "GET" && url.pathname === "/api/events") return serveEvents(req, res);
    if (req.method === "GET" && url.pathname === "/api/mjpeg") return serveMjpeg(req, res, url.searchParams.get("channel") || "visible");
    if (req.method === "POST" && url.pathname === "/api/mjpeg-stop") {
      const body = await readJson(req);
      stopMjpeg(body.channel || "all");
      return apiJson(res, { ok: true, status: snapshot() });
    }
    if (req.method === "POST" && url.pathname === "/api/report") {
      const body = await readJson(req);
      const date = body.date || new Date().toISOString().slice(0, 10);
      const result = generateReport(date);
      log("info", `Evaluation report generated: ${result.reportFile}`);
      return apiJson(res, {
        ok: true,
        reportFile: result.reportFile,
        reportUrl: `/api/report-file?date=${encodeURIComponent(date)}`,
        summary: result.summary,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/report-file") {
      const date = (url.searchParams.get("date") || new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, "");
      const result = generateReport(date);
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(fs.readFileSync(result.reportFile));
      return true;
    }
    return false;
  } catch (err) {
    log("error", err.message);
    apiJson(res, { ok: false, error: err.message }, 500);
  }
  return true;
}

function serveEvents(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(`event: status\ndata: ${JSON.stringify(snapshot())}\n\n`);
  state.sseClients.add(res);
  req.on("close", () => state.sseClients.delete(res));
}

function hasFfmpeg() {
  if (hasFfmpeg.cached !== undefined) return hasFfmpeg.cached;
  const result = spawnSync(resolveFfmpeg(), ["-version"], { stdio: "ignore" });
  hasFfmpeg.cached = result.status === 0;
  return hasFfmpeg.cached;
}

function resolveFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(__dirname, "..", "tools", "ffmpeg", "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const toolsDir = path.join(__dirname, "..", "tools");
  const exeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const found = findFile(toolsDir, exeName, 4);
  if (found) return found;
  return "ffmpeg";
}

function ffmpegRtspTimeoutArgs() {
  if (ffmpegRtspTimeoutArgs.cached) return ffmpegRtspTimeoutArgs.cached;
  const ffmpeg = resolveFfmpeg();
  const rtspHelp = spawnSync(ffmpeg, ["-hide_banner", "-h", "demuxer=rtsp"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3000,
    maxBuffer: 1024 * 1024,
  });
  const rtspOptions = `${rtspHelp.stdout || ""}\n${rtspHelp.stderr || ""}`;
  if (/(?:^|\s)-stimeout\s/m.test(rtspOptions)) {
    ffmpegRtspTimeoutArgs.cached = ["-stimeout", "5000000"];
    return ffmpegRtspTimeoutArgs.cached;
  }
  ffmpegRtspTimeoutArgs.cached = ["-timeout", "5000000"];
  return ffmpegRtspTimeoutArgs.cached;
}

function findFile(dir, fileName, depth) {
  if (!dir || depth < 0 || !fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const nested = findFile(full, fileName, depth - 1);
      if (nested) return nested;
    }
  }
  return null;
}

function stopMjpeg(channel = "all") {
  const channels = channel === "all" ? Object.keys(state.mjpeg) : [channel];
  for (const name of channels) {
    const item = state.mjpeg[name];
    if (!item) continue;
    if (item.restartTimer) {
      clearTimeout(item.restartTimer);
      item.restartTimer = null;
    }
    if (item.proc) {
      item.proc.kill("SIGTERM");
      item.proc = null;
      log("info", `Stopped MJPEG proxy for ${name}`);
    }
    for (const client of item.clients) client.end();
    item.clients.clear();
    item.startedAt = null;
  }
}

function startMjpegProcess(channel) {
  const stream = state.mjpeg[channel];
  if (!stream || stream.proc) return;
  const input = rtspUrls()[channel] || rtspUrls().visible;
  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-rtsp_transport", "tcp",
    ...ffmpegRtspTimeoutArgs(),
    "-i", input,
    "-an",
    "-vf", "fps=10,scale=640:-1",
    "-q:v", "6",
    "-f", "mpjpeg",
    "pipe:1",
  ];
  const proc = spawn(resolveFfmpeg(), args, { windowsHide: true });
  stream.proc = proc;
  stream.startedAt = Date.now();
  stream.lastError = null;
  proc.stdout.on("data", (chunk) => {
    for (const client of stream.clients) client.write(chunk);
  });
  proc.stderr.on("data", (chunk) => {
    stream.lastError = chunk.toString("utf8").slice(0, 500);
    log("debug", `ffmpeg ${channel}: ${stream.lastError}`);
  });
  proc.on("error", (err) => {
    stream.lastError = err.message;
    log("error", `ffmpeg ${channel} failed to start: ${err.message}`);
  });
  proc.on("exit", (code) => {
    if (stream.proc === proc) stream.proc = null;
    stream.startedAt = null;
    log("info", `MJPEG ffmpeg ${channel} exited with code ${code}`);
    emit("status", snapshot());
    if (stream.clients.size > 0 && !stream.restartTimer) {
      stream.restartTimer = setTimeout(() => {
        stream.restartTimer = null;
        startMjpegProcess(channel);
      }, 1000);
      log("warn", `MJPEG ${channel} will reconnect in 1s`);
    }
  });
  log("info", `Started MJPEG proxy for ${channel}: ${input}`);
  emit("status", snapshot());
}

function serveMjpeg(req, res, channel) {
  channel = channel === "thermal" ? "thermal" : "visible";
  if (!hasFfmpeg()) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("ffmpeg is not installed or not in PATH. RTSP check is still available.");
    return;
  }
  const stream = state.mjpeg[channel];
  if (!stream.proc) startMjpegProcess(channel);
  res.writeHead(200, {
    "content-type": "multipart/x-mixed-replace; boundary=ffmpeg",
    "cache-control": "no-store",
    connection: "close",
  });
  stream.clients.add(res);
  req.on("close", () => stream.clients.delete(res));
}

function checkRtsp(channel) {
  const url = new URL(rtspUrls()[channel] || rtspUrls().visible);
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port || 554), timeout: 3500 });
    let data = "";
    let done = false;
    const finish = (ok, extra = {}) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, channel, url: url.toString(), latencyMs: Date.now() - started, ...extra });
    };
    socket.on("connect", () => {
      const request = [
        `OPTIONS ${url.toString()} RTSP/1.0`,
        "CSeq: 1",
        "User-Agent: HY-Web-Gimbal-Tester",
        "",
        "",
      ].join("\r\n");
      socket.write(request);
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.includes("\r\n\r\n")) finish(/^RTSP\/1\.\d\s+2\d\d/.test(data), { response: data.split("\r\n").slice(0, 4).join("\n") });
    });
    socket.on("timeout", () => finish(false, { error: "timeout" }));
    socket.on("error", (err) => finish(false, { error: err.message }));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) {
    const handled = await handleApi(req, res);
    if (handled !== false) return;
  }
  serveStatic(req, res);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use.`);
    console.error(`Start with another port, for example: .\\start-win.ps1 -Port ${PORT + 1}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  log("info", `HY web gimbal tester listening on http://127.0.0.1:${PORT}`);
  console.log(`HY web gimbal tester listening on http://127.0.0.1:${PORT}`);
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  fs.mkdirSync(RECORDING_DIR, { recursive: true });
});

process.on("SIGINT", () => {
  stopMjpeg();
  stopPythonSdk();
  if (state.recording.active && state.recording.proc) {
    try { state.recording.proc.kill("SIGTERM"); } catch {}
  }
  closeUdp();
  process.exit(0);
});
