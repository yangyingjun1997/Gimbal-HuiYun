# HY-DZ230F 吊舱 Web 测试工具

HY-DZ230F 三轴稳像吊舱的本地 Web 测试工具：MAVLink 控制、相机配置、设备 IP/网络修改、
RTSP 预览、拍照、录像、红外测温状态显示。用于集成评估，不是量产机器人驱动。

同一份源码跨平台运行：Windows 10/11 x64、Ubuntu 22.04/24.04（x86_64 与 arm64）。

## 下载

| 渠道 | 说明 |
| --- | --- |
| **GitHub Releases** | 下载打包好的 `web-gimbal-tester-windows.zip` / `web-gimbal-tester-ubuntu.tar.gz`，解压即用 |
| **克隆本仓库** | 只含源码（< 5 MB），FFmpeg 首次运行时自动下载安装 |

> 本仓库**不包含** FFmpeg 二进制（体积约 100 MB，受 GitHub 单文件限制）。
> Windows 首次启动运行 `install-ffmpeg-win.ps1` 自动下载；Ubuntu 由 `start-ubuntu.sh` 联网自动安装。

## 环境要求

- Node.js 18 及以上（推荐 Node 20 LTS）
- Python 3
- FFmpeg —— 视频预览、拍照、录像需要（首次运行自动安装，或手动准备）
- 一张和吊舱同网段的网卡

### Ubuntu：依赖自动安装

`start-ubuntu.sh` 在第 1/5 步检查每一项依赖，规则是：

1. **本地已安装** → 直接跳过，不重复装；
2. **本地没有、但有网且能提权** → 自动安装（交互模式先问一次，`--yes` 静默装）。
   Node.js 走 NodeSource 源，保证版本 ≥ 18；支持 apt / dnf / yum / zypper / pacman / apk；
3. **本地没有、且没网** → 明确提示"请先自行下载安装"，并给出对应的手动命令。

`--no-install` 或 `AUTO_INSTALL=0` 可关闭自动安装，只做报告。

如果想自己先把环境装好，等价命令是：

```bash
sudo apt update
sudo apt install -y python3 ffmpeg lsof curl iputils-ping ca-certificates
node -v          # 必须 >= 18，不够就：
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
```

Windows：装好 Node.js 18+ 和 Python 3，再运行 `install-ffmpeg-win.ps1` 自动下载 FFmpeg（一次即可）。

## 启动

两个启动脚本都是同样的五步（提示全部中文）：

```text
1/5 依赖检查   -> node、python3、厂商 SDK、源码、ffmpeg
                 （Ubuntu 联网时自动补装缺失项；本地已有则跳过）
2/5 吊舱 IP    -> 交互式询问，记住上次的值
    Web 端口   -> 交互式询问，被占用时自动建议空闲端口
    本地 UDP 端口 -> 交互式询问，同样有占用检测
3/5 网络自检   -> 本机 IP、路由、ICMP、RTSP TCP 554、端口占用、防火墙
4/5 重启清理   -> 停掉上一个测试实例，释放所选端口
5/5 启动服务   -> 拉起 Node、自动连接、打印启动后健康报告
```

Ubuntu：

```bash
cd /path/to/web-gimbal-tester-ubuntu
bash ./start-ubuntu.sh
```

Windows（双击 `start-win.bat`，或在 PowerShell 里）：

```powershell
cd C:\path\to\web-gimbal-tester-windows
.\start-win.ps1
```

然后打开打印出来的地址，通常是 `http://127.0.0.1:8080`。服务监听所有网卡，
局域网内别的机器用 `http://<主机IP>:<端口>` 也能访问。

### 交互询问的样子

```text
  回车采用方括号内的值，或直接输入新值。
  吊舱 IP [192.168.124.64]:
  Web 端口 8080 已被占用，占用进程: node (pid 435)
  建议改用 8081（回车即采用）
  Web 端口 [8081]:
  本地 UDP 接收端口 [3000]:
```

所以切换吊舱、避开被占用的端口都不用传参、不用改脚本。输入的值会写进
`.gimbal-tester.conf`，成为下次启动的默认值。Web 界面里也能随时改设备 IP
（设置抽屉 -> 设备 IP -> 重连），不必重启。

### 启动参数

| Ubuntu | Windows | 作用 |
| --- | --- | --- |
| `--ip <地址>` | `-GimbalIp <地址>` | 吊舱 IP，跳过该项询问 |
| `--port <n>` | `-Port <n>` | Web 端口，跳过该项询问 |
| `--local-port <n>` | `-LocalPort <n>` | 本地 UDP 接收端口，跳过该项询问 |
| `--check` | `-CheckOnly` | 只做体检后退出，不启动服务 |
| `--yes` / `-y` | `-Yes` | 非交互，直接用已保存/默认值 |
| `--install` | — | 强制安装缺失依赖（Ubuntu，联网时默认即如此） |
| `--no-install` | — | 一律不安装，只报告缺失项（Ubuntu） |
| `--no-connect` | `-NoConnect` | 启动服务但开机后不自动连接 |
| `--no-kill` | `-NoKill` | 不杀掉占用端口的进程 |
| `--help` | `-Help` | 显示帮助 |

环境变量（两个平台通用）：`GIMBAL_IP`、`PORT`、`GIMBAL_PORT`、`GIMBAL_LOCAL_PORT`、
`FFMPEG_PATH`、`PYTHON_PATH`、`HY_PYTHON_SDK`、`SKIP_CHECKS`。
仅 Ubuntu：`AUTO_INSTALL`（设 0 关闭自动安装）。

每个值的优先级：命令行参数 > 环境变量 > `.gimbal-tester.conf` > 出厂默认。

## 默认网络设置

```text
吊舱 IP:        192.168.124.64
主机 IP:        192.168.124.164      （和吊舱同一 /24 网段）
控制端口:       UDP 3000
本地接收端口:   UDP 3000
SDK 目标端口:   UDP 14550
Web 界面端口:   TCP 8080
源系统 ID:      1
源组件 ID:      25
```

确保连吊舱的那张网卡上真的有 `192.168.124.0/24` 网段的地址：

```bash
# Ubuntu
ip -4 -o addr show
sudo ip addr add 192.168.124.164/24 dev <你的网卡名>
ping -c 3 192.168.124.64
```

```powershell
# Windows
Get-NetIPAddress -AddressFamily IPv4
netsh interface ip set address "以太网" static 192.168.124.164 255.255.255.0
Test-Connection 192.168.124.64
```

## 体检 / 诊断

用体检模式运行启动脚本，会做完全部检查并顺带查询正在运行的实例：

```bash
bash ./start-ubuntu.sh --check          # Ubuntu
```

```powershell
.\start-win.ps1 -CheckOnly              # Windows
```

输出覆盖：架构与系统、每一项依赖、本机 IPv4、到吊舱的路由、ICMP 可达性、RTSP TCP 554、
Web/UDP 端口是否空闲及被谁占用、防火墙状态、运行中实例的 `/api/status` 解析结果，
以及 `logs/<今天>.log` 里最近的 `error`/`warn` 行。

第 5 步后自动打印的启动后健康报告也是这些关键字段：

```text
  设备          192.168.124.64  控制 3000  sdk 14550
  udp 绑定      0.0.0.0:3000  （期望 3000）
  ffmpeg        可用
  python sdk    运行中
  数据包        TX 6  RX 142  parseErrors 0
  [ok] 吊舱回包正常 —— 控制链路是通的。
```

Web 界面里的一键体检（T01–T08）覆盖 UDP 绑定、基础请求、RTSP 时延、八方向点动、
停止优先级、回中、相机指令和状态上报观察。

## 红外测温（HY_IR_CAMERA_STATUS，V1.0.7 新增）

新版厂商 SDK 增加了红外相机状态上报消息 `HY_IR_CAMERA_STATUS`（ID 11068）。
设备开启红外温度显示后（相机配置 -> 高级 ->「红外温度 开」），会周期性上报：

- 全局最低 / 最高温度，以及对应的像素坐标；
- 指定测温区域 (x1,y1)-(x2,y2) 的最低 / 最高 / 平均温度；
- 图像翻转模式、数据有效标志位。

界面在「相机状态」下方新增「红外测温」卡片实时显示这些值。配套地，`CAMERA_CONFIG_TYPE`
枚举新增三个控制项，界面上也有对应按钮：相机重启（27）、红外变焦（28）、SD 卡只读修复（29）。
测温区域仍用「红外区域测温」配置（`HY_IR_TEMP_REGION_CONFIG`，ID 11067）下发。

## SDK 传输链路

```text
Web -> Node 服务 -> 常驻 Python 桥 -> 厂商 hy_gimbal.py 编码
     -> Node UDP socket（绑定本地端口）-> 吊舱（UDP 3000 和 14550）
```

Python 桥用厂商 SDK 编码消息，把打包好的 MAVLink 帧交回 Node；Node 发出后，
回包继续到达已有的接收监听，并计入 Web 日志。原始帧、PDF 样例帧保留为 Node 直发通道，
便于协议比对。

桥接用于：云台控制、活动模式、相机配置、变焦、引导移动、红外区域测温配置、
相机网络配置，以及标准 MAVLink command-long 控制。

## 视频、拍照、录像

浏览器不能直接播 RTSP，所以服务端用 FFmpeg 把两路 RTSP 转成 MJPEG：

```text
rtsp://<吊舱IP>/live/main
rtsp://<吊舱IP>/live/thermal
```

Web 拍照是用 FFmpeg 抽一帧 JPEG；Web 录像是用 FFmpeg 从 RTSP 录制。
这些和 MAVLink 的相机触发指令是相互独立的。

不用 Web 界面手动验证一路：

```bash
ffmpeg -hide_banner -rtsp_transport tcp -i rtsp://192.168.124.64/live/main -frames:v 1 -y /tmp/test.jpg
```

## 排障

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 第 1 步就中止 | node/python3 缺失或 node < 18，且没能装上 | 1/5 输出会写明原因（没网 / 没 root / 加了 `--no-install`），按打印的"手动安装"命令装 |
| `本机无网络，无法下载 -> 请先自行下载安装` | 主机没有到软件源的路由 | 接通外网网卡，或用内部镜像源，或按提示手动装 |
| `sudo 需要密码，但当前不是交互终端` | 以服务/CI 方式运行且没有免密 sudo | 先交互式跑一次，或配置 NOPASSWD，或先手动装好依赖 |
| 预览黑屏，健康报告 `ffmpeg 缺失` | ffmpeg 没装且没能自动装 | Ubuntu：联网后重跑 `./start-ubuntu.sh`，或 `sudo apt install -y ffmpeg`；Windows：把 `ffmpeg.exe` 放到 `tools\ffmpeg\bin\` |
| 预览黑屏，`ffmpeg 可用` | RTSP 不可达 | 看第 3 步的 ICMP 和 TCP 554；确认主机网段 |
| 控制有发，`RX = 0` | 网段/网卡/防火墙不对 | 第 3 步输出里有路由和本机 IP |
| 控制有发，`RX = 0`，网段正常 | 本地 UDP 端口被占 -> 退到随机端口 | 询问时换空闲端口；健康报告会标 `绑定到了随机本地端口` |
| `Python SDK bridge timeout` | python3 缺失或首次 import 慢 | 看 `python3 -V`；重试一次（1.9MB 的 SDK 首次导入可能偏慢） |
| 界面本机能开、局域网开不了 | 防火墙 | 放行所选 Web 端口的入站 TCP |

## 日志与报告

运行日志写到 `logs/YYYY-MM-DD.log`。Web 页面还显示 TX/RX 样本、CRC 状态、计数器和时延。
测试完在 Web 页面生成评估报告，报告落在 `reports/` 下。

## 重要协议说明

厂商 SDK 把私有消息 `HY_CAMERA_CONFIG` 的 CRC extra 声明为 164，而早期实测这台设备
某些相机配置帧要用 167，本版本默认用 167。Web 页面保留了 Node 直发 CRC 选项用于比对，
SDK 模式则始终用 `vendor/hy_gimbal.py` 里定义的 CRC。量产集成前请与厂商确认这一差异。

## 目录结构

```text
web-gimbal-tester-<平台>/
├── start-ubuntu.sh / start-win.ps1 + start-win.bat   启动脚本（检查 + 询问 + 健康报告）
├── src/server.js                HTTP + SSE + UDP + FFmpeg 编排
├── src/protocol.js              MAVLink/HY 帧编解码
├── src/python_sdk_bridge.py     到厂商 SDK 的 stdin/stdout JSON 桥
├── src/report.js                评估报告生成
├── public/                      Web 界面（index.html, app.js, styles.css）
├── vendor/hy_gimbal.py          厂商 MAVLink SDK（只用 Python 标准库）
├── tools/ffmpeg/bin/ffmpeg.exe  仅 Windows 版
├── docs/                        协议问题记录
├── .gimbal-tester.conf          上次使用的 IP/端口（运行时生成）
└── logs/ photos/ recordings/ reports/   运行时生成
```
