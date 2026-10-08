"use strict";

const $ = (id) => document.getElementById(id);

let state = null;
let jogTimer = null;
let jogDirection = null;
let jogSpeed = 8;
let cruiseInterval = null;
let cruiseIndex = 0;
let cruiseBusy = false;
let poses = loadPoses();
let logCleared = false;

/* 按接口文档 CAMERA_CONFIG_TYPE 分组 */
const CAMERA_GROUPS = {
  img: [
    { t: 1, v: 2, label: "变焦 2x" },
    { t: 1, v: 5, label: "变焦 5x" },
    { t: 1, v: 10, label: "变焦 10x" },
    { t: 4, v: 1, label: "镜像翻转（实测）" },
    { t: 4, v: 0, label: "镜像关闭（实测）" },
    { t: 5, v: 1, label: "OSD 开" },
    { t: 5, v: 2, label: "OSD 关" },
    { t: 12, v: 1, label: "对焦 远" },
    { t: 12, v: 2, label: "对焦 近" },
    { t: 12, v: 3, label: "自动对焦" },
    { t: 24, v: 0, label: "持续放大" },
    { t: 25, v: 0, label: "持续缩小" },
    { t: 26, v: 0, label: "停止变倍" },
  ],
  rec: [
    { t: 2, v: 1, label: "拍照" },
    { t: 3, v: 1, label: "开始录像" },
    { t: 3, v: 2, label: "停止录像" },
    { t: 8, v: 0, label: "图传 4K" },
    { t: 8, v: 2, label: "图传 1080P" },
    { t: 8, v: 3, label: "图传 720P" },
    { t: 17, v: 3, label: "码率 2M" },
    { t: 17, v: 5, label: "码率 3M" },
    { t: 17, v: 7, label: "码率 4M" },
    { t: 18, v: 0, label: "编码 H.264" },
    { t: 18, v: 1, label: "编码 H.265" },
    { t: 11, v: 1, label: "格式化SD卡", danger: true },
  ],
  enh: [
    { t: 14, v: 1, label: "防抖 开" },
    { t: 14, v: 2, label: "防抖 关" },
    { t: 15, v: 1, label: "透雾 开" },
    { t: 15, v: 2, label: "透雾 关" },
    { t: 16, v: 1, label: "畸变矫正 开" },
    { t: 16, v: 2, label: "畸变矫正 关" },
    { t: 19, v: 1, label: "数字变焦 开" },
    { t: 19, v: 2, label: "数字变焦 关" },
    { t: 23, v: 0, label: "日夜 自动" },
    { t: 23, v: 1, label: "日夜 彩色" },
    { t: 23, v: 2, label: "日夜 黑白" },
    { t: 9, v: 1, label: "识别扫描 开" },
    { t: 9, v: 2, label: "识别扫描 关" },
    { t: 10, v: 1, label: "跟踪开关 开" },
    { t: 10, v: 2, label: "跟踪开关 关" },
  ],
  adv: [
    { t: 20, v: 1, label: "伪彩色 开" },
    { t: 20, v: 2, label: "伪彩色 关" },
    { t: 21, v: 1, label: "红外温度 开" },
    { t: 21, v: 2, label: "红外温度 关" },
    { t: 22, v: 1, label: "背光补偿 开" },
    { t: 22, v: 2, label: "背光补偿 关" },
    { t: 13, v: 3, label: "光圈 自动" },
    { t: 28, v: 1, label: "红外变焦 开" },
    { t: 28, v: 2, label: "红外变焦 关" },
    { t: 27, v: 1, label: "相机重启", danger: true },
    { t: 29, v: 1, label: "SD卡只读修复", danger: true },
  ],
};

/* configType → cameraReport 字段映射 */
const CAMERA_STATE_MAP = {
  4: { on: "imageFlip", expected: (value) => value !== 0 },
  5: { on: "osdDisplay", onVal: true, offVal: false },
  9: { on: "recognitionScan", onVal: true, offVal: false },
  10: { on: "trackingSelection", onVal: true, offVal: false },
  14: { on: "stabilizer", onVal: true, offVal: false },
  15: { on: "defog", onVal: true, offVal: false },
  16: { on: "distortionCompensation", onVal: true, offVal: false },
  19: { on: "digitalZoom", onVal: true, offVal: false },
};

/* 模式名称 */
const MODE_NAMES = { 1: "主动跟随", 2: "主动全局", 3: "直立跟随", 4: "直立全局" };

/* ========== 工具函数 ========== */

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`); }
  if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
  return data;
}
async function post(path, body) { return api(path, { method: "POST", body: JSON.stringify(body || {}) }); }

function getConfigFromForm() {
  return {
    deviceIp: $("deviceIp").value.trim(),
    controlPort: Number($("controlPort").value),
    cameraConfigCrcExtra: Number($("cameraConfigCrcExtra").value),
    localPort: Number($("localPort").value),
    autoLocalPort: true, sysId: 1, compId: 25,
  };
}

async function send(command, payload = {}) {
  try {
    if (command === "camera-config") setConfigNotice("pending", `${payload.label || "相机配置"}：指令发送中...`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, payload }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`); }
    if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
    if (data.verification) showConfigVerification(data.verification);
    return data;
  } catch (err) {
    if (command === "camera-config") setConfigNotice("rejected", `${payload.label || "相机配置"}：发送失败`);
    if (err.name === "AbortError") toast("指令发送超时（8秒无响应），请检查连接", "error");
    else toast(err.message || "指令发送异常", "error");
    return null;
  }
}

function setConfigNotice(status, message) {
  const notice = $("configNotice");
  if (!notice) return;
  notice.className = `config-notice ${status || "idle"}`;
  const text = $("configNoticeText");
  if (text) text.textContent = message;
}

function showConfigVerification(verification) {
  const status = verification.status || "unconfirmed";
  const message = verification.message || "相机配置状态未知";
  setConfigNotice(status, message);
  const type = status === "rejected" ? "error"
    : status === "unconfirmed" ? "warn"
      : "success";
  toast(message, type);
}

function toast(message, type = "info") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  const prefix = type === "error" ? "❌ " : type === "success" ? "✓ " : type === "warn" ? "⚠ " : "";
  item.textContent = prefix + message;
  $("toasts").appendChild(item);
  setTimeout(() => item.remove(), 3800);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

function isValidIPv4(value) {
  const parts = String(value || "").trim().split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function loadPoses() {
  try {
    const arr = JSON.parse(localStorage.getItem("hyGimbalPoses") || "[]");
    return [0, 1, 2, 3].map((i) => normalizePose(arr[i]));
  } catch { return [null, null, null, null]; }
}
function savePoses() { localStorage.setItem("hyGimbalPoses", JSON.stringify(poses)); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function normalizePose(pose) {
  if (!pose) return null;
  if (typeof pose !== "object") return null;
  if (Number.isFinite(pose.rawPitchAngle) || Number.isFinite(pose.rawYawAngle) || Number.isFinite(pose.targetPitchAngle) || Number.isFinite(pose.targetYawAngle)) {
    return {
      rawPitchAngle: Number(pose.rawPitchAngle ?? pose.pitchAngle ?? 0),
      rawYawAngle: Number(pose.rawYawAngle ?? pose.yawAngle ?? 0),
      targetPitchAngle: Number(pose.targetPitchAngle ?? pose.pitchAngle ?? 0),
      targetYawAngle: Number(pose.targetYawAngle ?? pose.yawAngle ?? 0),
      laserDistance: Number(pose.laserDistance ?? 0),
      savedAt: pose.savedAt || Date.now(),
      legacy: Boolean(pose.legacy),
    };
  }
  return {
    rawPitchAngle: Number(pose.pitchAngle ?? 0),
    rawYawAngle: Number(pose.yawAngle ?? 0),
    targetPitchAngle: Number(pose.pitchAngle ?? 0),
    targetYawAngle: Number(pose.yawAngle ?? 0),
    laserDistance: Number(pose.laserDistance ?? 0),
    savedAt: pose.savedAt || Date.now(),
    legacy: true,
  };
}

function getPoseTargets(pose, options = {}) {
  if (!pose) return null;
  const hasExplicitSwap = Object.prototype.hasOwnProperty.call(options, "swapAxes");
  const swapAxes = hasExplicitSwap ? options.swapAxes : ($("poseGotoSwapAxes")?.checked !== false);
  const rawPitch = Number(pose.rawPitchAngle ?? pose.pitchAngle ?? 0);
  const rawYaw = Number(pose.rawYawAngle ?? pose.yawAngle ?? 0);
  if (!hasExplicitSwap && Number.isFinite(pose.targetPitchAngle) && Number.isFinite(pose.targetYawAngle)) {
    return { pitch: Number(pose.targetPitchAngle), yaw: Number(pose.targetYawAngle) };
  }
  if (pose.legacy && swapAxes) return { pitch: rawYaw, yaw: rawPitch };
  return { pitch: rawPitch, yaw: rawYaw };
}

async function moveToPose(pose, { centerFirst = false, swapAxes, stopCruise: stopCruiseNow = false } = {}) {
  const target = getPoseTargets(pose, { swapAxes });
  if (!target) throw new Error("位姿数据无效");
  stopJog(false);
  if (stopCruiseNow) await stopCruise();
  if (centerFirst) {
    await send("gimbal-center");
    await sleep(800);
  }
  return send("gimbal-control", {
    pitchMode: 2,
    yawMode: 2,
    pitchValue: target.pitch,
    yawValue: target.yaw,
  });
}

/* ========== UI 渲染 & 状态更新 ========== */

function updateStatus(next) {
  state = next;
  const cfg = state.config;
  if (document.activeElement !== $("deviceIp")) $("deviceIp").value = cfg.deviceIp;
  if (document.activeElement !== $("controlPort")) $("controlPort").value = cfg.controlPort;
  if (document.activeElement !== $("cameraConfigCrcExtra")) $("cameraConfigCrcExtra").value = cfg.cameraConfigCrcExtra ?? 167;
  if (document.activeElement !== $("localPort")) $("localPort").value = cfg.localPort;
  $("appVersion").textContent = state.appVersion || "--";
  $("deviceIpDisplay").textContent = cfg.deviceIp || "--";

  const pill = $("connectionPill");
  const deviceResponded = Boolean(state.connected && state.lastRxAt && state.connectedAt && state.lastRxAt >= state.connectedAt);
  pill.classList.toggle("ok", deviceResponded);
  pill.classList.toggle("waiting", Boolean(state.connected && !deviceResponded));
  pill.querySelector(".status-text").textContent = !state.connected ? "未连接" : deviceResponded ? "设备在线" : "等待设备";
  $("rxMetric").textContent = state.counters.rxPackets;
  $("txMetric").textContent = state.counters.txPackets;

  const report = state.lastGimbalReport;
  $("laserReport").textContent = report ? `${report.laserDistance}m` : "--";
  $("tempReport").textContent = report ? `${report.temperature}°C` : "--";

  $("poseCurrentPitch").textContent = report ? report.pitchAngle : "--";
  $("poseCurrentYaw").textContent = report ? report.yawAngle : "--";
  const statusLabel = report ? formatGimbalStatus(report.statusText) : "等待设备回包";
  $("poseStatusText").textContent = statusLabel;
  $("poseStatusText").classList.toggle("online", Boolean(report));
  const modeBadge = $("gimbalModeBadge");
  if (modeBadge) modeBadge.textContent = report ? statusLabel : "--";

  const cam = state.lastCameraReport;
  const camBox = $("cameraStatus");
  if (!cam) {
    camBox.innerHTML = "<span>暂无相机回包</span>";
  } else {
    $("zoomReadout").textContent = cam.zoomTimes || 0;
    const chips = [
      [`变焦 ${cam.zoomTimes || 0}x`, true],
      [`拍照${cam.takePhoto ? "中" : "空闲"}`, cam.takePhoto],
      [`录像${cam.videoRecord ? "中" : "关"}`, cam.videoRecord],
      [`防抖${cam.stabilizer ? "开" : "关"}`, cam.stabilizer],
      [`透雾${cam.defog ? "开" : "关"}`, cam.defog],
      [`编码 ${cam.encodingFormatText || "-"}`, true],
      [`码率 ${cam.bitrateText || "-"}`, true],
      [`传输 ${cam.transmissionResolutionText || "-"}`, true],
    ];
    camBox.innerHTML = chips.map(([text, on]) => `<span class="${on ? "on" : ""}">${text}</span>`).join("");
  }

  if (!cam) $("zoomReadout").textContent = "--";
  updateStorageStatus();
  renderIrStatus();
  renderNetConfig();

  if (!logCleared) renderLogs(state.logs || []);
  updateRecordingState();
  updateCameraButtonStates();
  updateModeButtonStates();
  renderPoseGrid();
  renderCamBits();
  renderGimbalBits();
  // 每 3 次 status 更新同步一次 raw frames，避免频繁请求
  if (typeof window.__frameSync === "undefined") window.__frameSync = 0;
  window.__frameSync = (window.__frameSync + 1) % 3;
  if (window.__frameSync === 0 && $("diagnosticsDrawer")?.classList.contains("open")) refreshRawFrames(true).catch(() => {});
}

function formatGimbalStatus(statusText) {
  const labels = {
    STATE_UNINIT: "未初始化",
    STATE_BOOTING: "启动中",
    STATE_STANDBY: "待机",
    STATE_NO_IMU: "IMU 异常",
    STATE_NO_YAW_MOTOR: "偏航电机异常",
    STATE_NO_ROLL_MOTOR: "横滚电机异常",
    STATE_NO_PITCH_MOTOR: "俯仰电机异常",
    STATE_MOTOR_BLOCK: "电机堵转",
    STATE_START: "初始化",
    STATE_YAW_CALIBRATING: "偏航校准中",
    STATE_YAW_CALIBRATION_FINISHED: "偏航校准完成",
    STATE_ROLL_CALIBRATING: "横滚校准中",
    STATE_ROLL_CALIBRATION_FINISHED: "横滚校准完成",
    STATE_PITCH_CALIBRATING: "俯仰校准中",
    STATE_PITCH_CALIBRATION_FINISHED: "俯仰校准完成",
    STATE_ACTIVE_FOLLOW: "主动跟随",
    STATE_ACTIVE_GLOBAL: "主动全局",
  };
  return labels[statusText] || String(statusText || "未知状态").replace(/^STATE_/, "").replaceAll("_", " ");
}

function updateRecordingState() {
  const rec = state?.recording;
  const visibleBtn = $("recordBtn");
  const thermalBtn = $("thermalRecordBtn");
  for (const [btn, channel] of [[visibleBtn, "visible"], [thermalBtn, "thermal"]]) {
    if (!btn) continue;
    const activeHere = rec?.active && rec.channel === channel;
    btn.classList.toggle("active", Boolean(activeHere));
    btn.disabled = Boolean(rec?.active && !activeHere);
    btn.textContent = activeHere ? "停止本地录像" : "本地录像";
  }
  const deviceRecording = Boolean(state?.lastCameraReport?.videoRecord);
  $("deviceRecordStartBtn")?.classList.toggle("active", deviceRecording);
  if ($("deviceRecordingState")) $("deviceRecordingState").textContent = deviceRecording ? "录像中" : "空闲";
}

function formatCapacity(value) {
  const mib = Number(value);
  if (!Number.isFinite(mib)) return "--";
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GB` : `${mib.toFixed(1)} MB`;
}

function updateStorageStatus() {
  const storage = state?.lastStorageInformation;
  const available = storage ? formatCapacity(storage.availableCapacityMiB) : "--";
  if ($("sdCapacityCompact")) $("sdCapacityCompact").textContent = `可用 ${available}`;
  if ($("sdStorageName")) $("sdStorageName").textContent = storage?.name || "SD 卡";
  if ($("sdAvailable")) $("sdAvailable").textContent = available;
  if ($("sdUsed")) $("sdUsed").textContent = storage ? formatCapacity(storage.usedCapacityMiB) : "--";
}

function renderLogs(logs) {
  const box = $("logBox");
  const recent = logs.slice(0, 60);
  box.innerHTML = recent.map((item) => {
    const time = formatDate(item.time);
    const level = item.level || "info";
    return `<div class="log-entry ${level}"><span class="log-time">${time}</span><span class="log-msg">${escapeHtml(item.message || "")}</span></div>`;
  }).join("");
  box.scrollTop = 0;
}

function updateCameraButtonStates() {
  const cam = state?.lastCameraReport;
  if (!cam) return;
  document.querySelectorAll(".btn-grid button").forEach((btn) => {
    const cfgType = Number(btn.dataset.cfgType);
    const cfgValue = Number(btn.dataset.cfgValue);
    const mapping = CAMERA_STATE_MAP[cfgType];
    if (!mapping) return;
    /* 镜像实机使用 2=翻转/0=关闭，其余开关使用 1=开/2=关。 */
    const wantOn = mapping.expected ? mapping.expected(cfgValue) : cfgValue === 1;
    const isOn = cam[mapping.on] === true;
    if (wantOn === isOn) btn.classList.add("active-state");
    else btn.classList.remove("active-state");
  });
}

function updateModeButtonStates() {
  const report = state?.lastGimbalReport;
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.classList.remove("active");
  });
  if (report) {
    const status = report.status;
    if (status === 20) document.querySelector('.mode-btn[data-mode="1"]')?.classList.add("active");
    else if (status === 21) document.querySelector('.mode-btn[data-mode="2"]')?.classList.add("active");
  }
}

/* ========== 相机按钮渲染 ========== */

function buildCameraButtons() {
  const mount = (id, list) => {
    const container = $(id);
    if (!container) return;
    container.innerHTML = list.map((item) => {
      const danger = item.danger ? ` data-type="danger"` : "";
      return `<button data-cfg-type="${item.t}" data-cfg-value="${item.v}"${danger} title="config_type=${item.t}, cmd_value=${item.v}">${item.label}</button>`;
    }).join("");
  };
  mount("imgCameraButtons", CAMERA_GROUPS.img);
  mount("recCameraButtons", CAMERA_GROUPS.rec);
  mount("enhCameraButtons", CAMERA_GROUPS.enh);
  mount("advCameraButtons", CAMERA_GROUPS.adv);
}

/* ========== 位姿渲染 ========== */

function renderPoseGrid() {
  const grid = $("poseGrid");
  if (!grid) return;
  grid.innerHTML = poses.map((pose, i) => {
    const has = Boolean(pose);
    const target = has ? getPoseTargets(pose) : null;
    const rawPitch = has ? Number(pose.rawPitchAngle ?? pose.pitchAngle ?? 0) : 0;
    const rawYaw = has ? Number(pose.rawYawAngle ?? pose.yawAngle ?? 0) : 0;
    const distance = has && Number.isFinite(Number(pose.laserDistance)) ? Number(pose.laserDistance) : null;
    const val = has
      ? `<span>P ${target.pitch.toFixed(1)}° · Y ${target.yaw.toFixed(1)}°</span>${distance !== null ? `<small>保存测距 ${distance.toFixed(1)}m</small>` : ""}`
      : "未保存";
    return `<div class="pose-card ${has ? "has-data" : ""}">
      <div class="pose-slot">位姿${i + 1}</div>
      <div class="pose-val ${has ? "" : "empty"}">${val}</div>
      <div class="pose-actions">
        <button onclick="savePose(${i})">${has ? "覆盖" : "保存"}</button>
        <button onclick="gotoPose(${i})" ${has ? "" : "disabled"}>前往</button>
        <button class="del" onclick="deletePose(${i})" ${has ? "" : "disabled"} title="删除">×</button>
      </div>
    </div>`;
  }).join("");
}

function savePose(i) {
  const report = state?.lastGimbalReport;
  if (!report) { toast("无法保存：暂无云台角度回包", "error"); return; }
  const saveSwapAxes = $("poseSaveSwapAxes")?.checked !== false;
  const rawPitch = Number(report.pitchAngle);
  const rawYaw = Number(report.yawAngle);
  if (!Number.isFinite(rawPitch) || !Number.isFinite(rawYaw)) {
    toast("无法保存：云台角度回包无效", "error");
    return;
  }
  const targetPitch = saveSwapAxes ? rawYaw : rawPitch;
  const targetYaw = saveSwapAxes ? rawPitch : rawYaw;
  poses[i] = {
    rawPitchAngle: rawPitch,
    rawYawAngle: rawYaw,
    targetPitchAngle: targetPitch,
    targetYawAngle: targetYaw,
    pitchAngle: targetPitch,
    yawAngle: targetYaw,
    laserDistance: Number(report.laserDistance) || 0,
    savedAt: Date.now(),
    legacy: false,
  };
  savePoses();
  renderPoseGrid();
  toast(`位姿 ${i + 1} 已保存：原始 P:${rawPitch}° Y:${rawYaw}°`, "success");
}

async function gotoPose(i) {
  const pose = poses[i];
  if (!pose) { toast("该位姿未保存", "error"); return; }
  const centerFirst = $("poseCenterFirst")?.checked !== false;
  const target = getPoseTargets(pose, { swapAxes: $("poseGotoSwapAxes")?.checked !== false });
  const r = await moveToPose(pose, { centerFirst, stopCruise: true, swapAxes: $("poseGotoSwapAxes")?.checked !== false });
  if (r) toast(`前往位姿 ${i + 1}：P:${target.pitch}° Y:${target.yaw}°`, "success");
}

function deletePose(i) {
  poses[i] = null;
  savePoses();
  renderPoseGrid();
  toast(`位姿 ${i + 1} 已删除`, "info");
}

/* ========== 云台方向控制 ========== */

function startJog(direction) {
  if (!direction) return;
  stopCruise();
  stopJog(false);
  jogDirection = direction;
  send("gimbal-control", jogPayload(direction));
  jogTimer = setInterval(() => {
    if (jogDirection) send("gimbal-control", jogPayload(jogDirection));
  }, 120);
}

function stopJog(sendStop = true) {
  if (jogTimer) clearInterval(jogTimer);
  jogTimer = null;
  const wasJogging = Boolean(jogDirection);
  jogDirection = null;
  if (sendStop && wasJogging) send("gimbal-stop");
}

function jogPayload(direction) {
  const s = Math.max(0.5, jogSpeed);
  const d = Number((s / Math.SQRT2).toFixed(3));
  const map = {
    up: { pitchValue: s, yawValue: 0 },
    down: { pitchValue: -s, yawValue: 0 },
    left: { pitchValue: 0, yawValue: -s },
    right: { pitchValue: 0, yawValue: s },
    northwest: { pitchValue: d, yawValue: -d },
    northeast: { pitchValue: d, yawValue: d },
    southwest: { pitchValue: -d, yawValue: -d },
    southeast: { pitchValue: -d, yawValue: d },
  };
  return { pitchMode: 1, yawMode: 1, ...(map[direction] || map.up) };
}

function bindJogControls() {
  document.querySelectorAll(".dir-btn[data-jog]").forEach((btn) => {
    const dir = btn.dataset.jog;
    const down = (e) => {
      e.preventDefault();
      btn.setPointerCapture?.(e.pointerId);
      btn.classList.add("pressed");
      startJog(dir);
    };
    const up = () => { btn.classList.remove("pressed"); stopJog(); };
    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    btn.addEventListener("lostpointercapture", up);
  });
  document.querySelectorAll(".speed-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".speed-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      jogSpeed = Number(btn.dataset.speed) || 8;
    });
  });
  document.querySelectorAll(".tune-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await stopCruise();
      stopJog(false);
      const action = btn.dataset.tune;
      const step = 0.5;
      const report = state?.lastGimbalReport || { pitchAngle: 0, yawAngle: 0 };
      let pitch = Number(report.pitchAngle) || 0;
      let yaw = Number(report.yawAngle) || 0;
      switch (action) {
        case "yaw-left": yaw -= step; break;
        case "yaw-right": yaw += step; break;
        case "pitch-up": pitch += step; break;
        case "pitch-down": pitch -= step; break;
      }
      await send("gimbal-control", { pitchMode: 2, yawMode: 2, pitchValue: pitch, yawValue: yaw });
      toast(`微调 0.5° 到 P:${pitch.toFixed(1)}° Y:${yaw.toFixed(1)}°`, "success");
    });
  });
  document.querySelector(".emergency")?.addEventListener("click", async () => {
    stopJog(false);
    stopCruise();
    toast("紧急停止中...", "warn");
    try {
      await post("/api/emergency-stop");
      toast("紧急停止完成：云台+录制已全部停止", "success");
    } catch (err) { toast("紧急停止异常：" + err.message, "error"); }
  });
}

/* ========== 视频预览 & 拍照 & 录制 ========== */

async function startPreview(channel) {
  await post("/api/config", getConfigFromForm()).catch(() => {});
  const img = $(`${channel}Preview`);
  const hint = $(`${channel}Hint`);
  if (!state?.ffmpegAvailable) {
    img.style.display = "none";
    hint.style.display = "grid";
    hint.textContent = "本机未检测到 ffmpeg，请放入 tools/ffmpeg/bin/ 目录。";
    toast("ffmpeg 不可用", "error");
    return;
  }
  img.onload = () => {
    img.style.display = "block";
    hint.style.display = "none";
    const overlay = $(`${channel}OverlayStatus`);
    if (overlay) overlay.textContent = "实时";
  };
  img.onerror = () => {
    img.style.display = "none";
    hint.style.display = "grid";
    hint.textContent = "预览失败，请检查 RTSP 地址、网络和设备状态。";
    const overlay = $(`${channel}OverlayStatus`);
    if (overlay) overlay.textContent = "连接失败";
  };
  hint.style.display = "grid";
  hint.textContent = "正在启动预览...";
  img.src = `/api/mjpeg?channel=${channel}&t=${Date.now()}`;
}

async function stopPreview(channel) {
  const img = $(`${channel}Preview`);
  const hint = $(`${channel}Hint`);
  img.removeAttribute("src");
  img.style.display = "none";
  hint.style.display = "grid";
  hint.textContent = "预览已关闭";
  const overlay = $(`${channel}OverlayStatus`);
  if (overlay) overlay.textContent = "已关闭";
  await post("/api/mjpeg-stop", { channel }).catch(() => {});
}

async function captureLocalPhoto(channel) {
  try {
    toast(`正在截取${channel === "thermal" ? "热成像" : "可见光"}画面...`, "info");
    const result = await post("/api/photo", { channel });
    toast(`本地截图已保存：${result.file}`, "success");
    if ($("mediaDrawer")?.classList.contains("open")) loadMediaFiles();
  } catch (err) {
    toast("本地截图失败：" + err.message, "error");
  }
}

async function toggleLocalRecording(channel) {
  if (state?.recording?.active) {
    try {
      await post("/api/record-stop");
      toast("本地录像已停止并保存", "success");
      setTimeout(() => loadMediaFiles(), 1200);
    } catch (err) { toast(err.message, "error"); }
    return;
  }
  try {
    const result = await post("/api/record-start", { channel });
    toast(`本地录像中：${result.file}`, "success");
  } catch (err) { toast(err.message, "error"); }
}

function closeDrawers() {
  document.querySelectorAll(".drawer.open").forEach((drawer) => drawer.classList.remove("open"));
  $("drawerBackdrop")?.classList.remove("open");
}

function openDrawer(id) {
  closeDrawers();
  $(id)?.classList.add("open");
  $("drawerBackdrop")?.classList.add("open");
  if (id === "mediaDrawer") loadMediaFiles();
  if (id === "diagnosticsDrawer") refreshRawFrames(true);
}

function formatFileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

async function loadMediaFiles() {
  const list = $("mediaList");
  if (!list) return;
  try {
    const data = await api("/api/media");
    $("mediaPathText").textContent = `${data.photoDir} · ${data.recordingDir}`;
    if (!data.files?.length) {
      list.innerHTML = '<div class="empty-state">暂无本地媒体文件</div>';
      return;
    }
    list.innerHTML = data.files.map((file) => {
      const date = new Date(file.modifiedAt).toLocaleString("zh-CN", { hour12: false });
      const type = file.kind === "recording" ? "MP4" : "JPG";
      return `<div class="media-item">
        <div class="media-type">${type}</div>
        <div><div class="media-name">${escapeHtml(file.name)}</div><div class="media-meta">${date} · ${formatFileSize(file.size)}</div></div>
        <a class="btn sm" href="${file.url}" target="_blank" rel="noopener">查看</a>
      </div>`;
    }).join("");
  } catch (err) {
    list.innerHTML = `<div class="empty-state">媒体加载失败：${escapeHtml(err.message)}</div>`;
  }
}

/* ========== 一键完整测试 & 报告 ========== */

async function runFullTestAndReport() {
  const btn = $("testAllBtn");
  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "测试中...请勿关闭";
  toast("已开始一键完整测试，约 15~25 秒完成...", "info");
  try {
    await post("/api/config", getConfigFromForm()).catch(() => {});
    const data = await post("/api/run-full-test", { config: getConfigFromForm() });
    const { result, reportMarkdown } = data;
    const summary = `用例 ${result.stats.total} ｜ 通过 ${result.stats.pass} ｜ 警告 ${result.stats.warn || 0} ｜ 失败 ${result.stats.fail} ｜ 跳过 ${result.stats.skip} ｜ 耗时 ${result.durationSec}s`;
    toast(`测试完成：${summary}`, result.stats.fail === 0 ? "success" : "warn");
    showReportDialog(result, reportMarkdown, summary);
  } catch (err) { toast("一键测试失败：" + err.message, "error"); }
  finally { btn.disabled = false; btn.textContent = prevText; }
}

function showReportDialog(result, markdown, summary) {
  const id = "sdk-report-dialog";
  if (document.getElementById(id)) document.getElementById(id).remove();
  const dlg = document.createElement("div");
  dlg.id = id;
  dlg.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px;";
  const panel = document.createElement("div");
  panel.style.cssText = "background:#172236;border:1px solid #273658;border-radius:12px;max-width:1000px;width:100%;max-height:86vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.5);";
  const header = document.createElement("div");
  header.style.cssText = "padding:14px 18px;border-bottom:1px solid #273658;display:flex;align-items:center;justify-content:space-between;gap:12px;";
  header.innerHTML = `<div style="display:flex;flex-direction:column;gap:4px;"><div style="font-weight:600;font-size:15px;color:#fff;">HY-DZ230F SDK 一键测试报告</div><div style="color:#8ea0bf;font-size:12px;">${escapeHtml(summary)} ｜ ${escapeHtml(result.testTime)} ｜ ${escapeHtml(result.verdict)}</div></div>`;
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn ghost sm"; closeBtn.textContent = "✕ 关闭";
  closeBtn.onclick = () => dlg.remove();
  header.appendChild(closeBtn);
  const toolbar = document.createElement("div");
  toolbar.style.cssText = "padding:10px 18px;border-bottom:1px dashed rgba(255,255,255,0.08);display:flex;gap:8px;flex-wrap:wrap;";
  const dlMd = document.createElement("button"); dlMd.className = "btn sm primary"; dlMd.textContent = "下载 Markdown 报告";
  dlMd.onclick = () => downloadText(markdown, `HY-SDK-测试报告-${Date.now()}.md`);
  const dlJson = document.createElement("button"); dlJson.className = "btn sm"; dlJson.textContent = "下载 JSON 明细";
  dlJson.onclick = () => downloadText(JSON.stringify(result, null, 2), `HY-SDK-测试明细-${Date.now()}.json`);
  const copyBtn = document.createElement("button"); copyBtn.className = "btn sm ghost"; copyBtn.textContent = "复制 Markdown";
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(markdown); toast("已复制 Markdown 内容", "success"); }
    catch { toast("复制失败，请手动下载", "error"); }
  };
  const showMd = document.createElement("button"); showMd.className = "btn sm ghost"; showMd.textContent = "切换：原始 MD";
  toolbar.append(dlMd, dlJson, copyBtn, showMd);
  const body = document.createElement("div");
  body.style.cssText = "flex:1;overflow:auto;padding:18px;background:#0f1724;color:#e6ecf5;line-height:1.65;";
  body.innerHTML = renderMarkdownToHtml(markdown);
  let rawMode = false;
  showMd.onclick = () => {
    rawMode = !rawMode;
    body.innerHTML = rawMode ? `<pre style="font-family:Consolas,monospace;white-space:pre-wrap;color:#c7d2fe;background:#081222;border:1px solid #273658;padding:14px;border-radius:8px;">${escapeHtml(markdown)}</pre>` : renderMarkdownToHtml(markdown);
    showMd.textContent = rawMode ? "切换：渲染视图" : "切换：原始 MD";
  };
  panel.append(header, toolbar, body);
  dlg.appendChild(panel);
  dlg.onclick = (e) => { if (e.target === dlg) dlg.remove(); };
  document.body.appendChild(dlg);
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
}

function renderMarkdownToHtml(md) {
  const escape = (s) => escapeHtml(s);
  return md.split(/\r?\n/).map((rawLine) => {
    const line = rawLine.replace(/\s+$/g, "");
    if (!line) return "<br/>";
    if (line.startsWith("```")) return "";
    if (/^#{1,6}\s+/.test(line)) {
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      return `<h${m[1].length} style="color:#fff;margin:18px 0 8px;font-weight:600;">${escape(m[2])}</h${m[1].length}>`;
    }
    if (line.startsWith("> ")) return `<blockquote style="border-left:3px solid #3b82f6;padding:6px 12px;color:#94a3b8;background:rgba(59,130,246,0.08);margin:8px 0;border-radius:0 6px 6px 0;">${escape(line.slice(2))}</blockquote>`;
    if (line.startsWith("|")) return line + "\n";
    if (/^\d+\.\s+/.test(line)) return `<li style="color:#cbd5e1;margin:4px 0 4px 18px;">${escape(line.replace(/^\d+\.\s+/, ""))}</li>`;
    return `<p style="margin:6px 0;color:#cbd5e1;">${escape(line)}</p>`;
  }).join("").split(/\n{2,}/).map((block) => {
    if (/^\|/.test(block.trim())) {
      const rows = block.trim().split(/\r?\n/).filter((l) => l.startsWith("|"));
      if (rows.length < 2) return block;
      const headers = rows[0].slice(1, -1).split("|").map((c) => c.trim());
      const dataRows = rows.slice(1).filter((r) => !/^\|\s*:?-+:?\s*(\|:?-+:?\s*)*\|?\s*$/.test(r));
      if (headers.length === 1 && headers[0] === "") return block;
      return `<table style="border-collapse:collapse;width:100%;margin:10px 0;font-size:13px;">
        <thead><tr style="background:#1d2b44;">${headers.map((h) => `<th style="padding:8px 10px;border:1px solid #273658;color:#e6ecf5;text-align:left;">${escape(h)}</th>`).join("")}</tr></thead>
        <tbody>${dataRows.map((r) => {
          const cells = r.slice(1, -1).split("|").map((c) => c.trim());
          return `<tr>${cells.map((c) => {
            const on = c.includes("✅"); const warn = c.includes("⚠️"); const fail = c.includes("❌");
            const color = on ? "background:rgba(34,197,94,0.08);color:#86efac;" : warn ? "background:rgba(245,158,11,0.08);color:#fcd34d;" : fail ? "background:rgba(239,68,68,0.08);color:#fca5a5;" : "";
            return `<td style="padding:6px 10px;border:1px solid #273658;color:#cbd5e1;${color}">${escape(c)}</td>`;
          }).join("")}</tr>`;
        }).join("")}</tbody></table>`;
    }
    return block;
  }).join("");
}

/* ========== 事件绑定 ========== */

function bindGlobalEvents() {
  $("connectBtn").addEventListener("click", async () => {
    try { await post("/api/connect", getConfigFromForm()); toast("UDP 连接成功", "success"); }
    catch (err) { toast(err.message, "error"); }
  });
  $("disconnectBtn").addEventListener("click", async () => {
    try { await post("/api/disconnect"); toast("已断开连接", "success"); }
    catch (err) { toast(err.message, "error"); }
  });

  /* 网络配置（CAMERA_NET_CONFIG） */
  $("netCfgQueryBtn")?.addEventListener("click", async () => {
    const r = await send("camera-net-config", { opType: 1, ip: "", netmask: "", gateway: "", apply: 0 });
    if (r) toast("网络配置查询指令已发送，等待设备回包", "info");
  });
  $("netCfgSetBtn")?.addEventListener("click", async () => {
    const ip = $("netCfgIp").value.trim();
    const netmask = $("netCfgNetmask").value.trim();
    const gateway = $("netCfgGateway").value.trim();
    const apply = Number($("netCfgApply").value) ? 1 : 0;
    for (const [label, value] of [["设备 IP", ip], ["子网掩码", netmask], ["网关", gateway]]) {
      if (!isValidIPv4(value)) { toast(`${label}格式不正确：${value || "（空）"}`, "error"); return; }
    }
    if (apply && ip !== state?.config?.deviceIp) {
      toast(`注意：设备 IP 将改为 ${ip}，生效后需用新地址重新连接`, "warn");
    }
    const r = await send("camera-net-config", { opType: 0, ip, netmask, gateway, apply });
    if (r) toast(apply ? "网络配置已下发（立即生效）" : "网络配置已保存（设备重启后生效）", "success");
  });

  $("visibleOpen").addEventListener("click", () => startPreview("visible"));
  $("visibleClose").addEventListener("click", () => stopPreview("visible"));
  $("thermalOpen").addEventListener("click", () => startPreview("thermal"));
  $("thermalClose").addEventListener("click", () => stopPreview("thermal"));

  $("photoBtn").addEventListener("click", () => captureLocalPhoto("visible"));
  $("thermalPhotoBtn").addEventListener("click", () => captureLocalPhoto("thermal"));
  $("recordBtn").addEventListener("click", () => toggleLocalRecording("visible"));
  $("thermalRecordBtn").addEventListener("click", () => toggleLocalRecording("thermal"));

  $("devicePhotoBtn").addEventListener("click", async () => {
    const result = await send("camera-config", { configType: 2, cmdValue: 1, label: "设备拍照" });
    if (result && !result.verification) toast("设备拍照指令已发送，文件保存到云台 SD 卡", "success");
  });
  $("deviceRecordStartBtn").addEventListener("click", async () => {
    const result = await send("camera-config", { configType: 3, cmdValue: 1, label: "开始设备录像" });
    if (result && !result.verification) toast("设备录像已启动，文件保存到云台 SD 卡", "success");
  });
  $("deviceRecordStopBtn").addEventListener("click", async () => {
    const result = await send("camera-config", { configType: 3, cmdValue: 2, label: "停止设备录像" });
    if (result && !result.verification) toast("设备录像停止指令已发送", "success");
  });

  $("zoomSetBtn").addEventListener("click", async () => {
    const v = Math.max(1, Math.min(127, Number($("zoomValue").value) || 1));
    const r = await send("camera-config", { configType: 1, cmdValue: v, label: `变焦到 ${v}x` });
    if (r && !r.verification) toast(`变焦指令已发送：${v}x`, "success");
  });

  $("zoomInBtn")?.addEventListener("click", async () => {
    const r = await send("camera-config", { configType: 24, cmdValue: 0, label: "持续放大" });
    if (r && !r.verification) toast("持续放大已启动，请点击“停止变倍”结束", "warn");
  });

  $("zoomOutBtn")?.addEventListener("click", async () => {
    const r = await send("camera-config", { configType: 25, cmdValue: 0, label: "持续缩小" });
    if (r && !r.verification) toast("持续缩小已启动，请点击“停止”结束", "warn");
  });

  $("zoomStopBtn")?.addEventListener("click", async () => {
    const r = await send("camera-config", { configType: 26, cmdValue: 0, label: "停止变倍" });
    if (r && !r.verification) toast("变倍已停止", "success");
  });

  $("centerBtn").addEventListener("click", async () => {
    await stopCruise();
    stopJog(false);
    const r = await send("gimbal-center");
    if (r) toast("已发送云台回中指令", "success");
  });

  $("gotoAngleBtn").addEventListener("click", async () => {
    await stopCruise();
    stopJog(false);
    const p = Number($("pitchAngle").value) || 0;
    const y = Number($("yawAngle").value) || 0;
    const r = await send("gimbal-control", { pitchMode: 2, yawMode: 2, pitchValue: p, yawValue: y });
    if (r) toast(`已发送角度控制 P:${p}° Y:${y}°`, "success");
  });

  $("startCruiseBtn").addEventListener("click", async () => {
    const saved = poses.filter(Boolean);
    if (saved.length < 2) { toast("请先保存至少 2 个位姿", "error"); return; }
    stopJog(false);
    await stopCruise();
    cruiseIndex = 0;
    const go = async () => {
      if (cruiseBusy) return;
      cruiseBusy = true;
      const valid = poses.filter(Boolean);
      const pose = valid[cruiseIndex % valid.length];
      if (!pose) return;
      try {
        await moveToPose(pose, { centerFirst: true, stopCruise: false, swapAxes: $("poseGotoSwapAxes")?.checked !== false });
      } finally {
        cruiseBusy = false;
      }
    };
    await go();
    cruiseInterval = setInterval(async () => {
      const valid = poses.filter(Boolean);
      cruiseIndex = (cruiseIndex + 1) % valid.length;
      await go();
    }, 5000);
    toast(`开始巡航：${saved.length} 个位姿，每 5 秒切换`, "success");
  });
  $("stopCruiseBtn").addEventListener("click", () => { stopJog(false); stopCruise(); toast("已停止巡航", "info"); });

  /* 清空日志 */
  $("clearLogBtn").addEventListener("click", () => {
    logCleared = true;
    $("logBox").innerHTML = "";
    toast("日志已清空（新日志将继续显示）", "info");
    setTimeout(() => { logCleared = false; }, 5000);
  });

  $("testAllBtn").addEventListener("click", () => runFullTestAndReport());

  $("settingsToggle")?.addEventListener("click", () => openDrawer("settingsDrawer"));
  $("mediaToggle")?.addEventListener("click", () => openDrawer("mediaDrawer"));
  $("diagnosticsToggle")?.addEventListener("click", () => openDrawer("diagnosticsDrawer"));
  $("drawerBackdrop")?.addEventListener("click", closeDrawers);
  document.querySelectorAll("[data-close-drawer]").forEach((button) => button.addEventListener("click", closeDrawers));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDrawers(); });
  $("refreshMediaBtn")?.addEventListener("click", loadMediaFiles);

  /* Tab 切换（云台 tab + 协议调试 tab 各自独立范围） */
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nav = btn.closest(".tab-nav");
      const parentPanel = btn.closest(".panel-body") || btn.closest(".panel");
      if (nav) {
        nav.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      }
      // data-tab: 云台面板的 tab
      const tab = btn.dataset.tab;
      if (tab && parentPanel) {
        parentPanel.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
        $(`tab-${tab}`)?.classList.add("active");
      }
      // data-debugtab: 协议调试面板的 tab
      const dtab = btn.dataset.debugtab;
      if (dtab && parentPanel) {
        parentPanel.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
        $(`debugtab-${dtab}`)?.classList.add("active");
        if (dtab === "frames") refreshRawFrames(false);
        if (dtab === "cambits") { renderCamBits(); renderGimbalBits(); }
      }
    });
  });

  /* 模式按钮 */
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mode = Number(btn.dataset.mode);
      document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const r = await send("active-mode", { gimbalMode: mode });
      if (r) toast(`已切换到 ${MODE_NAMES[mode]} 模式`, "success");
    });
  });

  /* 模式 tab 内的功能按钮 */
  $("versionBtn")?.addEventListener("click", async () => {
    const r = await send("version-request", {});
    if (r) toast("版本查询请求已发送", "success");
  });
  $("channelBtn")?.addEventListener("click", async () => {
    const r = await send("channel-request", {});
    if (r) toast("通道查询请求已发送", "success");
  });
  $("rebootBtn")?.addEventListener("click", async () => {
    if (!confirm("确认重启云台？重启期间画面和控制将短暂中断。")) return;
    const r = await send("reboot-request", {});
    if (r) toast("重启请求已发送", "warn");
  });
  $("caliBtn")?.addEventListener("click", async () => {
    const r = await send("cali-feedback-request", {});
    if (r) toast("校准反馈请求已发送", "success");
  });

  /* 相机配置按钮事件委托（统一绑定到 document，避免重建丢失） */
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".btn-grid button");
    if (!btn) return;
    const cfgType = Number(btn.dataset.cfgType);
    const cfgValue = Number(btn.dataset.cfgValue);
    if (!cfgType && cfgType !== 0) return;
    btn.classList.add("sending");
    // All private camera config types must use HY_CAMERA_CONFIG(11060).
    // The standard MAV_CMD_SET_CAMERA_ZOOM(531) path is explicitly unsupported by this device.
    const label = btn.textContent.trim();
    const r = await send("camera-config", { configType: cfgType, cmdValue: cfgValue, label });
    btn.classList.remove("sending");
    if (r && !r.verification) {
      toast(`${btn.textContent.trim()} 指令已发送 (type=${cfgType} val=${cfgValue})`, "success");
    }
  });

  /* ===== 协议调试面板 ===== */
  $("refreshFramesBtn")?.addEventListener("click", () => refreshRawFrames(true));
  $("clearFramesBtn")?.addEventListener("click", () => { $("rawFramesBox").innerHTML = "显示已清空（点击刷新或发送新命令）"; });
  $("frameFilter")?.addEventListener("change", () => refreshRawFrames(false));

  $("debugSendCameraBtn")?.addEventListener("click", async () => {
    const ct = Number($("debugConfigType").value);
    const cv = Number($("debugCmdValue").value);
    const r = await send("camera-config", { configType: ct, cmdValue: cv });
    if (r) toast(`CAMERA_CONFIG 已发送 type=${ct} val=${cv}`, "success");
    setTimeout(() => refreshRawFrames(true), 500);
  });
  $("debugSendCamera5xBtn")?.addEventListener("click", async () => {
    const ct = Number($("debugConfigType").value);
    const cv = Number($("debugCmdValue").value);
    for (let i = 0; i < 5; i++) {
      await send("camera-config", { configType: ct, cmdValue: cv });
      await sleep(60);
    }
    toast(`已连发 5 次 CAMERA_CONFIG type=${ct} val=${cv}`, "success");
    setTimeout(() => refreshRawFrames(true), 500);
  });
  $("debugSendGimbalBtn")?.addEventListener("click", async () => {
    const mode = $("debugGimbalMode").value === "rate" ? 1 : 2;
    const p = Number($("debugGimbalP").value) || 0;
    const y = Number($("debugGimbalY").value) || 0;
    const r = await send("gimbal-control", { pitchMode: mode, yawMode: mode, pitchValue: p, yawValue: y });
    if (r) toast(`GIMBAL_CONTROL 已发送 (${mode === 1 ? "速率" : "角度"}) P=${p} Y=${y}`, "success");
    setTimeout(() => refreshRawFrames(true), 500);
  });
  $("debugSendRawBtn")?.addEventListener("click", async () => {
    const hex = $("debugRawHex").value.trim();
    if (!hex) return toast("请输入 HEX", "error");
    const r = await send("raw-hex", { hex });
    if (r) toast("HEX 帧已发送", "success");
    setTimeout(() => refreshRawFrames(true), 500);
  });
  $("debugConnBtn")?.addEventListener("click", async () => {
    for (let i = 0; i < 3; i++) { await send("connect-request", {}); await sleep(50); }
    toast("已连发 3 次 CONNECT_REQUEST", "success");
    setTimeout(() => refreshRawFrames(true), 500);
  });
  $("debugPdfSampleBtn")?.addEventListener("click", async () => {
    const r = await send("pdf-sample", { name: "pitchRateStop" });
    if (r) toast("PDF 示例帧 (Pitch 0°/s 停止) 已发送", "success");
    setTimeout(() => refreshRawFrames(true), 500);
  });
}

async function stopCruise(sendStop = true) {
  if (cruiseInterval) {
    clearInterval(cruiseInterval);
    cruiseInterval = null;
  }
  cruiseBusy = false;
  cruiseIndex = 0;
  if (sendStop) await send("gimbal-stop");
}

/* ========== 协议调试面板渲染 ========== */

let lastSamplesCache = [];

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

async function refreshRawFrames(fromServer) {
  if (fromServer) {
    try {
      const r = await api("/api/raw-frames?limit=200");
      if (r && r.samples) lastSamplesCache = r.samples;
    } catch { /* 忽略 */ }
  }
  const box = $("rawFramesBox");
  if (!box) return;
  const filter = $("frameFilter")?.value || "all";
  const list = lastSamplesCache.filter((s) => {
    if (filter === "tx") return s.direction === "tx";
    if (filter === "rx") return s.direction === "rx";
    if (filter === "camera") return /CAMERA/i.test(s.label || "") || /CAMERA/i.test(s.name || "");
    if (filter === "gimbal") return /GIMBAL/i.test(s.label || "") || /GIMBAL/i.test(s.name || "");
    return true;
  });
  if (!list.length) { box.innerHTML = "暂无帧（发送命令或点击刷新 / 连接 UDP 设备）"; return; }
  box.innerHTML = list.map((s) => {
    const dir = s.direction === "tx" ? "TX" : "RX";
    const crcCls = s.crcOk === true ? "crc-ok" : (s.crcOk === false ? "crc-bad" : "");
    const crcTag = s.crcOk === true ? `<span class="fr-crc">CRC✔</span>` :
                   s.crcOk === false ? `<span class="fr-crc">CRC✗</span>` : "";
    const titleLine = s.direction === "tx"
      ? `${s.label || "TX"}  → ${s.remote || ""}  ${s.bytes || 0}B`
      : `${s.name || "?"}  ← ${s.remote || ""}  ${s.bytes || 0}B  seq=${s.seq ?? ""}`;
    let decodedTag = "";
    if (s.direction === "rx" && s.decoded) {
      const d = s.decoded;
      if (typeof d.statusValue === "number") {
        decodedTag = `CAM_REPORT ${d.zoomTimes}x photo=${d.takePhoto} rec=${d.videoRecord} osd=${d.osdDisplay} stab=${d.stabilizer} defog=${d.defog}`;
      } else if (typeof d.regionAvgTemp === "number") {
        decodedTag = `IR_STATUS 全局[${d.minTemp}~${d.maxTemp}°C] 高温(${d.maxX},${d.maxY}) 低温(${d.minX},${d.minY}) 区域(${d.regionX1},${d.regionY1})-(${d.regionX2},${d.regionY2}) 均${d.regionAvgTemp}°C flip=${d.flipMode}`;
      } else if (typeof d.pitchAngle === "number") {
        decodedTag = `GIM_REPORT P=${d.pitchAngle} Y=${d.yawAngle} L=${d.laserDistance} T=${d.temperature}`;
      } else if (typeof d.configType === "number") {
        decodedTag = `CAM_CFG_ECHO type=${d.configType} val=${d.cmdValue}`;
      } else if (typeof d.pitchValue === "number") {
        decodedTag = `GIM_CTL_ECHO pm=${d.pitchMode} ym=${d.yawMode} P=${d.pitchValue} Y=${d.yawValue}`;
      } else {
        try { decodedTag = JSON.stringify(d).slice(0, 180); } catch {}
      }
    }
    return `<div class="frame-row ${s.direction} ${crcCls}">
      <div class="fr-head">
        <span>[${formatTime(s.at)}] <b>${dir}</b> <span class="fr-label">${escapeHtml(titleLine)}</span></span>
        <span>${crcTag}</span>
      </div>
      <div class="fr-hex">${escapeHtml(s.hex || s.payloadHex || "")}</div>
      ${decodedTag ? `<div class="fr-decoded">↳ ${escapeHtml(decodedTag)}</div>` : ""}
    </div>`;
  }).join("");
}

function bitCell(name, value, isBool) {
  if (isBool) {
    return `<div class="bit ${value ? "on" : "off"}"><span class="bit-name">${name}</span><span class="bit-value">${value ? "开" : "关"}</span></div>`;
  }
  const on = value !== 0 && value !== null && value !== undefined && value !== "--";
  return `<div class="bit ${on ? "on" : ""}"><span class="bit-name">${name}</span><span class="bit-value">${value == null ? "--" : value}</span></div>`;
}

function renderCamBits() {
  const cam = state?.lastCameraReport;
  if (!cam) {
    $("camReportRaw").textContent = "0x--------";
    $("camReportUpdate").textContent = "尚未收到 CAMERA_REPORT 回包";
    $("camBitGrid").innerHTML = `<div class="bit off"><span class="bit-name">暂无</span><span class="bit-value">--</span></div>`;
    return;
  }
  const v = cam.statusValue;
  const padHex = (x) => {
    try { return "0x" + (x >>> 0).toString(16).padStart(8, "0").toUpperCase(); } catch { return "0x--------"; }
  };
  $("camReportRaw").textContent = padHex(v);
  const ago = Math.floor((Date.now() - (cam.at || 0)) / 1000);
  $("camReportUpdate").textContent = `${ago >= 0 ? ago : 0} 秒前更新`;
  const cells = [
    ["变焦倍数", `${cam.zoomTimes || 0}×`, false],
    ["拍照中", cam.takePhoto, true],
    ["录像中", cam.videoRecord, true],
    ["图像翻转", cam.imageFlip, true],
    ["OSD 显示", cam.osdDisplay, true],
    ["原始分辨率", cam.rawResolution ?? "--", false],
    ["录像分辨率", cam.recordResolution ?? "--", false],
    ["图传分辨率", cam.transmissionResolutionText || cam.transmissionResolution, false],
    ["识别扫描", cam.recognitionScan, true],
    ["跟踪选择", cam.trackingSelection, true],
    ["电子防抖", cam.stabilizer, true],
    ["透雾/除雾", cam.defog, true],
    ["畸变矫正", cam.distortionCompensation, true],
    ["码率档位", cam.bitrateText || cam.bitrate, false],
    ["编码格式", cam.encodingFormatText || cam.encodingFormat, false],
    ["数字变焦", cam.digitalZoom, true],
    ["保留位", cam.reserved ?? "--", false],
  ];
  $("camBitGrid").innerHTML = cells.map(([n, v, b]) => bitCell(n, v, b)).join("");
}

/* 红外相机状态（HY_IR_CAMERA_STATUS, V1.0.7） */
function renderIrStatus() {
  const box = $("irStatusCard");
  if (!box) return;
  const ir = state?.lastIrCameraStatus;
  if (!ir) {
    box.innerHTML = `<div class="ir-empty">暂无红外状态回包（需在「相机配置-高级」开启红外温度）</div>`;
    return;
  }
  const ago = Math.max(0, Math.floor((Date.now() - (ir.at || 0)) / 1000));
  const flipMap = { 0: "无", 1: "水平", 2: "垂直", 3: "水平+垂直" };
  const regionOn = ir.regionValid && (ir.regionX2 > ir.regionX1 || ir.regionY2 > ir.regionY1);
  box.innerHTML = `
    <div class="ir-row">
      <span class="ir-lab">全局温度</span>
      <span class="ir-val ${ir.globalValid ? "on" : ""}">${ir.globalValid ? `${ir.minTemp} ~ ${ir.maxTemp} °C` : "无数据"}</span>
    </div>
    ${ir.globalValid ? `<div class="ir-row"><span class="ir-lab">热点 / 冷点</span><span class="ir-val">(${ir.maxX},${ir.maxY}) / (${ir.minX},${ir.minY})</span></div>` : ""}
    <div class="ir-row">
      <span class="ir-lab">测温区域</span>
      <span class="ir-val ${regionOn ? "on" : ""}">${regionOn ? `(${ir.regionX1},${ir.regionY1}) - (${ir.regionX2},${ir.regionY2})` : "未启用"}</span>
    </div>
    ${regionOn ? `<div class="ir-row"><span class="ir-lab">区域 低/高/均</span><span class="ir-val">${ir.regionMinTemp} / ${ir.regionMaxTemp} / ${ir.regionAvgTemp} °C</span></div>` : ""}
    <div class="ir-row">
      <span class="ir-lab">翻转模式</span>
      <span class="ir-val">${flipMap[ir.flipMode] ?? ir.flipMode}</span>
      <span class="ir-ago">${ago} 秒前更新</span>
    </div>`;
}

function renderNetConfig() {
  const box = $("netCfgCurrent");
  if (!box) return;
  const net = state?.lastCameraNetConfig;
  if (!net) {
    box.textContent = "尚未获取设备网络配置（点击“查询当前配置”）";
    box.classList.remove("on");
    return;
  }
  const ago = Math.max(0, Math.floor((Date.now() - (net.at || 0)) / 1000));
  const opText = net.opType === 0 ? "SET 回执" : net.opType === 1 ? "GET 响应" : `op=${net.opType}`;
  box.innerHTML =
    `<div class="ir-row"><span class="ir-lab">当前配置</span>` +
    `<span class="ir-val on">${escapeHtml(net.ip || "--")} / ${escapeHtml(net.netmask || "--")} / ${escapeHtml(net.gateway || "--")}</span></div>` +
    `<div class="ir-row"><span class="ir-lab">来源</span><span class="ir-val">${opText}</span>` +
    `<span class="ir-ago">${ago} 秒前更新</span></div>`;
  box.classList.add("on");
  if (net.ip && document.activeElement !== $("netCfgIp")) $("netCfgIp").value = net.ip;
  if (net.netmask && document.activeElement !== $("netCfgNetmask")) $("netCfgNetmask").value = net.netmask;
  if (net.gateway && document.activeElement !== $("netCfgGateway")) $("netCfgGateway").value = net.gateway;
}

function renderGimbalBits() {
  const g = state?.lastGimbalReport;
  $("gimBPitch").textContent = g ? g.pitchAngle : "--";
  $("gimBYaw").textContent = g ? g.yawAngle : "--";
  $("gimBLaser").textContent = g ? g.laserDistance : "--";
  $("gimBTemp").textContent = g ? g.temperature : "--";
  if (!g) { $("gimBStatus").textContent = "--"; return; }
  const statusText = typeof g.statusText === "string" ? g.statusText.replace(/_/g, " ") : "";
  $("gimBStatus").textContent = `${g.status} ${statusText}`.trim();
}

/* ========== 启动 ========== */

async function boot() {
  buildCameraButtons();
  bindJogControls();
  bindGlobalEvents();
  renderPoseGrid();
  try { updateStatus(await api("/api/status")); } catch (err) { toast("读取初始状态失败：" + err.message, "error"); }

  const events = new EventSource("/api/events");
  events.addEventListener("status", (e) => updateStatus(JSON.parse(e.data)));
  events.onerror = () => {};

  setInterval(async () => {
    if (!document.hidden) {
      try { updateStatus(await api("/api/status")); } catch {}
    }
  }, 1500);
}

boot().catch((err) => toast("启动失败：" + err.message, "error"));
