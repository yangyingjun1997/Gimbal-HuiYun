"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LOG_DIR = path.join(ROOT, "logs");
const REPORT_DIR = path.join(ROOT, "reports");

const inspectionTestMatrix = [
  ["I01", "网络与端口", "同网段、UDP 控制端口、RTSP 端口、Windows/Linux 防火墙", "连接成功，错误 IP/断网后可恢复"],
  ["I02", "视频首帧与延迟", "可见光、热成像分别打开 10 次，记录首帧时间", "首帧时间稳定，无明显长尾"],
  ["I03", "视频连续性", "双路 RTSP 同时预览 30 分钟", "无持续断流、花屏、明显卡顿，CPU/内存可接受"],
  ["I04", "视频质量", "白天/弱光/高温目标/低温背景观察", "清晰度、热目标可辨识，码流满足机器人链路带宽"],
  ["I05", "点控方向", "上/下/左/右/东北/西北/东南/西南各 10 次，小速度和中速度各一轮", "方向正确，停止后无继续漂移"],
  ["I06", "停止优先级", "运动中连续按停止 20 次", "停止即时有效，无卡死或继续运动"],
  ["I07", "角度控制", "Pitch/Yaw 多角度前往，含 0 点和边界附近", "到位误差、耗时、过冲在业务可接受范围"],
  ["I08", "位姿重复性", "保存位姿 1-4，循环前往 3-5 轮", "同一位姿回到角度稳定，误差可量化"],
  ["I09", "状态上报", "连续记录云台角度、温度、测距、相机状态", "频率稳定，字段随动作变化合理"],
  ["I10", "相机功能", "拍照、录像、OSD、稳像、透雾、对焦、编码切换", "命令生效，状态和画面/文件结果一致"],
  ["I11", "异常恢复", "断网、改错 IP、重启云台、重启测试程序", "恢复后无需人工复杂操作即可继续控制/预览"],
  ["I12", "机器人集成", "与机器人主控同网段/多网卡/导航任务并行", "不抢端口，不影响底盘通信，日志可追踪"],
  ["I13", "长稳测试", "连续 2-8 小时运行，周期性点控和拉流", "无进程崩溃、内存增长、断流不可恢复"],
  ["I14", "安全边界", "角度限位、停止策略、丢包、重复命令", "不会失控打到机械限位，停止可覆盖其他指令"],
];

const openSourceReferences = [
  ["ROS diagnostics / diagnostic_updater", "机器人项目普遍把设备健康状态、频率、错误码做成可持续诊断，而不是只看一次命令返回。"],
  ["ROS image_pipeline / camera_calibration", "相机接入通常要关注标定、图像处理链路、帧率与图像质量，巡检场景尤其要验证可见光和热成像的有效视场。"],
  ["ROS 2 topic statistics / tracing", "机器人链路评估常统计消息频率、延迟、抖动和长尾，适合对应本工具里的 TX/RX 时间、首帧时间、上报间隔。"],
  ["工业相机 ROS 驱动项目", "优秀驱动通常会报告采集帧率、丢帧、带宽、重连和资源占用，这些也应纳入云台视频流验收。"],
];

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { time: null, level: "parse_error", message: line };
      }
    });
}

function summarize(items) {
  const tx = items.filter((item) => item.level === "tx");
  const rx = items.filter((item) => item.level === "rx");
  const errors = items.filter((item) => item.level === "error");
  const ffmpeg = items.filter((item) => String(item.message || "").toLowerCase().includes("ffmpeg"));
  const udpBinds = items.filter((item) => String(item.message || "").includes("UDP bound"));
  const commands = {};
  const targets = {};

  for (const item of tx) {
    const label = item.data?.label || String(item.message || "").split(" -> ")[0] || "UNKNOWN";
    commands[label] = (commands[label] || 0) + 1;
    const remote = item.data?.remote || "";
    if (remote) targets[remote] = (targets[remote] || 0) + 1;
  }

  const first = items.find((item) => item.time)?.time || "";
  const last = [...items].reverse().find((item) => item.time)?.time || "";
  const rxNames = {};
  for (const item of rx) {
    const name = item.data?.name || "UNKNOWN";
    rxNames[name] = (rxNames[name] || 0) + 1;
  }

  return {
    first,
    last,
    totalLines: items.length,
    txCount: tx.length,
    rxCount: rx.length,
    errorCount: errors.length,
    ffmpegCount: ffmpeg.length,
    udpBindCount: udpBinds.length,
    commands,
    targets,
    rxNames,
    errors: errors.slice(-20),
    ffmpeg: ffmpeg.slice(-20),
    udpBinds: udpBinds.slice(-10),
  };
}

function pct(numerator, denominator) {
  if (!denominator) return "N/A";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function tableFromObject(obj, emptyText) {
  const rows = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return emptyText;
  return rows.map(([key, value]) => `| ${key} | ${value} |`).join("\n");
}

function tableFromRows(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function generateReport(date = new Date().toISOString().slice(0, 10)) {
  const logFile = path.join(LOG_DIR, `${date}.log`);
  const items = readJsonLines(logFile);
  const s = summarize(items);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportFile = path.join(REPORT_DIR, `${date}-evaluation.md`);
  const now = new Date().toISOString();

  const confidence = s.txCount >= 30 || s.rxCount >= 30 ? "medium" : "low";
  const verdict = s.rxCount > 0
    ? "已有设备回包，可继续扩大样本验证稳定性。"
    : "当前日志未看到设备回包，暂不能证明控制链路可靠。需优先排查网络、端口、防火墙、SDK CRC/字段。";

  const body = `# HY-DZ230F 云台接入测试评估报告

生成时间：${now}

日志文件：${logFile}

## 1. 结论摘要

初步结论：${verdict}

当前证据等级：${confidence}

本报告基于 Web 测试台自动日志生成，适合给研发做问题定位和给管理侧做阶段性判断。由于样本量会直接影响结论可信度，建议每次正式测试至少覆盖 30 次以上控制指令、连续 10 分钟状态上报、双路 RTSP 视频各 5 分钟。

## 2. 自动统计

| 指标 | 数值 |
| --- | ---: |
| 日志行数 | ${s.totalLines} |
| 测试开始 | ${s.first || "N/A"} |
| 测试结束 | ${s.last || "N/A"} |
| TX 发包数 | ${s.txCount} |
| RX 收包数 | ${s.rxCount} |
| 粗略回包率 RX/TX | ${pct(s.rxCount, s.txCount)} |
| 错误日志数 | ${s.errorCount} |
| ffmpeg 相关日志数 | ${s.ffmpegCount} |
| UDP 绑定次数 | ${s.udpBindCount} |

## 3. 命令覆盖情况

| 下发命令 | 次数 |
| --- | ---: |
${tableFromObject(s.commands, "| 暂无 TX 命令 | 0 |")}

## 4. 目标地址统计

| 目标地址 | 次数 |
| --- | ---: |
${tableFromObject(s.targets, "| 暂无目标地址 | 0 |")}

## 5. 设备上报统计

| 上报消息 | 次数 |
| --- | ---: |
${tableFromObject(s.rxNames, "| 暂无 RX 上报 | 0 |")}

## 6. 机器人巡检接入评估维度

| 维度 | 当前观察 | 建议判断方式 |
| --- | --- | --- |
| 控制链路 | ${s.txCount ? `已发 ${s.txCount} 包` : "暂无发包"}；${s.rxCount ? `收到 ${s.rxCount} 包` : "未见回包"} | 每个动作至少重复 10 次，观察是否动作一致、是否有回包或状态变化 |
| 视频链路 | ffmpeg/RTSP 相关日志 ${s.ffmpegCount} 条 | VLC 与 Web 预览分别测试可见光、热成像 5 分钟，记录卡顿、首帧时间 |
| 状态上报 | ${Object.keys(s.rxNames).length ? "已有上报类型：" + Object.keys(s.rxNames).join(", ") : "暂未收到可解析上报"} | 连续运行 10 分钟，统计上报频率、丢包、角度/温度/相机状态是否合理 |
| 位姿重复性 | 当前需人工使用“位姿 1-4”测试 | 保存 4 个典型巡检点，循环前往 3-5 轮，记录角度误差和耗时 |
| 异常恢复 | 需专门制造断网/错 IP/重启云台场景 | 断开后恢复连接，确认控制、状态、视频都能恢复 |
| 长稳运行 | 当前报告基于本次日志长度 | 建议至少 30-60 分钟，正式接入前做 2-8 小时稳定性测试 |
| SDK 风险 | PDF 缺少厂家生成的 hy_gimbal.py/C 头文件 | 向厂家索要完整 SDK，核对 CRC extra、字段顺序、端口说明 |
| 系统集成风险 | 当前为 UDP + RTSP 双链路 | 后期公司系统需明确网络隔离、防火墙、端口占用、断线重连策略 |

## 7. 巡检接入完整测试矩阵

${tableFromRows(["编号", "测试项", "测试内容", "通过标准"], inspectionTestMatrix)}

## 8. 开源项目经验对照

${tableFromRows(["参考方向", "可借鉴点"], openSourceReferences)}

## 9. 当前主要风险

1. 如果 TX 有记录但 RX 长期为 0，不能直接判定云台不可用。需先排查电脑网卡是否在云台同网段、Windows 防火墙、目标端口 3000/14550 是否正确。
2. 浏览器不能原生播放 RTSP，Web 预览依赖 ffmpeg。ffmpeg 不可用或参数不兼容时，不代表云台视频流不可用，应同时用 VLC 或厂家上位机交叉验证。
3. 当前目录只有 PDF，没有厂家生成 SDK 文件。除 HY_GIMBAL_CONTROL 已用 PDF 示例包验证外，其他自定义消息仍建议用厂家 SDK 做最终确认。
4. 巡检机器人上车后会和导航、底盘、工控机网卡、其他相机共享资源，必须额外验证多任务并行时的延迟、带宽和 CPU/内存占用。
5. 停止命令必须作为安全优先级最高项。如果发现任何一次停止不即时，应暂停上车集成，先确认协议和云台控制模式。

## 10. 建议最小验收用例

| 编号 | 测试项 | 操作 | 通过标准 |
| --- | --- | --- | --- |
| T01 | 网络连通 | PC 配置同网段，页面连接 UDP | UDP 绑定成功，RTSP OPTIONS 有响应 |
| T02 | 可见光视频 | 打开可见光 RTSP | 5 分钟内无明显断流，首帧时间可接受 |
| T03 | 热成像视频 | 打开热成像 RTSP | 5 分钟内无明显断流，首帧时间可接受 |
| T04 | 云台速度控制 | 八方向各 10 次，小速度控制 | 动作方向正确，无卡死，停止命令有效 |
| T05 | 云台角度控制 | Pitch/Yaw 角度模式多点测试 | 到位误差在业务可接受范围 |
| T06 | 相机命令 | 拍照、录像、OSD、防抖、透雾 | 状态可观察，必要时设备端文件/画面验证 |
| T07 | 断线恢复 | 断开网线或改错 IP 后恢复 | 程序可重新连接，云台恢复响应 |
| T08 | 长稳测试 | 连续运行 30-60 分钟 | 无进程崩溃，日志无持续错误，视频/控制可恢复 |

## 11. 最近错误摘录

${s.errors.length ? s.errors.map((item) => `- ${item.time}: ${item.message}`).join("\n") : "暂无 error 日志。"}

## 12. ffmpeg/视频摘录

${s.ffmpeg.length ? s.ffmpeg.map((item) => `- ${item.time}: ${item.message}`).join("\n") : "暂无 ffmpeg 日志。"}

## 13. 阶段性采购/接入建议

当前建议：先不要仅凭一次 Web 测试直接定性为可靠或不可靠。建议以“网络与 SDK 对齐验证 -> 功能回归 -> 长稳测试”的顺序推进。

若完成以下条件，可进入公司系统接入 PoC：

- 控制命令 50 次以上无方向错误或失控；
- 停止命令 20 次以上即时有效；
- 双路 RTSP 均可稳定 30 分钟；
- 状态上报频率稳定，关键字段可信；
- 厂家提供完整 SDK，研发确认 CRC extra 和字段顺序；
- 断线重连、端口占用、防火墙策略明确。
`;

  fs.writeFileSync(reportFile, body, "utf8");
  return { reportFile, logFile, summary: s };
}

if (require.main === module) {
  const date = process.argv[2] || new Date().toISOString().slice(0, 10);
  const result = generateReport(date);
  console.log(`Report written: ${result.reportFile}`);
}

module.exports = { generateReport, summarize };
