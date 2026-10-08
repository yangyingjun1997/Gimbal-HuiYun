#!/usr/bin/env bash
# =============================================================================
#  HY-DZ230F 吊舱 Web 测试工具 —— Ubuntu 启动脚本（x86_64 / arm64 通用）
#
#  流程：1/5 依赖检查 -> 2/5 交互确认吊舱 IP / Web 端口 / 本地 UDP 端口
#        3/5 网络自检 -> 4/5 清理旧实例 -> 5/5 启动服务 -> 启动后健康检查
#
#  每次启动都会交互式询问 IP 与端口，切换设备、避开被占用端口都无需改脚本。
#  检测到端口被占用时会自动建议一个空闲端口（回车即采用）。
#  上次使用的值会写入 .gimbal-tester.conf，作为下次的默认值。
#  Web 界面里也能随时改 IP（右上角设置抽屉 -> 设备 IP -> 重连），不必重启。
#
#  依赖处理（ffmpeg / python3 / nodejs / 诊断工具）：
#    先检查本机是否已安装，已安装则直接跳过；
#    缺失时若本机有网且能提权，则自动安装（交互模式会先询问一次，--yes 静默安装）；
#    缺失且无网时，明确提示需要先自行下载安装。
#    用 --no-install 或 AUTO_INSTALL=0 可关闭自动安装，只做报告。
#
#  用法：
#    bash ./start-ubuntu.sh                 # 交互式（日常使用）
#    bash ./start-ubuntu.sh --check         # 只做体检，不启动服务
#    bash ./start-ubuntu.sh --ip 192.168.124.64 --port 8090 --local-port 3000
#    bash ./start-ubuntu.sh --yes           # 不询问，直接用已保存/默认值
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

CONF_FILE="$ROOT/.gimbal-tester.conf"
PID_FILE="$ROOT/.gimbal-tester.pid"
STATUS_TMP="$(mktemp -t hy-status-XXXXXX.json)"

FACTORY_IP="192.168.124.64"
DEF_PORT=8080
DEF_CONTROL_PORT=3000
DEF_LOCAL_PORT=3000
RTSP_PORT=554

# ------------------------------------------------------------------- 输出
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*" >&2; }
warn()  { printf '\033[33m%s\033[0m\n' "$*" >&2; }
info()  { printf '%s\n' "$*" >&2; }
title() { printf '\n\033[36m--- %s ---\033[0m\n' "$*" >&2; }

cleanup_tmp() { rm -f "$STATUS_TMP"; }
trap cleanup_tmp EXIT

usage() {
  cat >&2 <<EOF
HY-DZ230F 吊舱 Web 测试工具（Ubuntu）

用法: bash ./start-ubuntu.sh [选项]

正常启动会依次询问：吊舱 IP、Web 端口、本地 UDP 接收端口。
直接回车即采用方括号里的默认值；上次用过的值会记入 .gimbal-tester.conf，
下次启动时成为新的默认值。

选项:
  --ip <地址>          吊舱 IP（跳过该项询问）
  --port <n>           Web 端口，默认 ${DEF_PORT}（跳过该项询问）
  --local-port <n>     本地 UDP 接收端口，默认 ${DEF_LOCAL_PORT}（跳过该项询问）
  --check              只运行体检后退出，不启动服务
  --yes, -y            非交互：直接使用已保存/默认值
  --install            强制安装缺失依赖（联网时默认即如此）
  --no-install         一律不安装，只报告缺失项
  --no-connect         启动服务，但开机后不自动连接设备
  --no-kill            不杀掉占用 Web 端口 / UDP 端口的进程
  --help, -h           显示本帮助

环境变量: GIMBAL_IP, PORT, GIMBAL_PORT, GIMBAL_LOCAL_PORT,
          FFMPEG_PATH, PYTHON_PATH, HY_PYTHON_SDK, SKIP_CHECKS,
          AUTO_INSTALL（设为 0 关闭自动安装）
EOF
}

# ------------------------------------------------------------- 参数解析
ARG_IP=""
ARG_PORT=""
ARG_LOCAL_PORT=""
CHECK_ONLY=0
ASSUME_YES=0
AUTO_CONNECT=1
NO_KILL=0
AUTO_INSTALL="${AUTO_INSTALL:-1}"

while [ $# -gt 0 ]; do
  case "$1" in
    --ip)          ARG_IP="${2:-}"; shift 2 ;;
    --ip=*)        ARG_IP="${1#*=}"; shift ;;
    --port)        ARG_PORT="${2:-}"; shift 2 ;;
    --port=*)      ARG_PORT="${1#*=}"; shift ;;
    --local-port)  ARG_LOCAL_PORT="${2:-}"; shift 2 ;;
    --local-port=*) ARG_LOCAL_PORT="${1#*=}"; shift ;;
    --check)       CHECK_ONLY=1; shift ;;
    --yes|-y)      ASSUME_YES=1; shift ;;
    --install)     AUTO_INSTALL=1; shift ;;
    --no-install)  AUTO_INSTALL=0; shift ;;
    --no-connect)  AUTO_CONNECT=0; shift ;;
    --no-kill)     NO_KILL=1; shift ;;
    --help|-h)     usage; exit 0 ;;
    *)             red "未知选项: $1"; usage; exit 2 ;;
  esac
done

case "$AUTO_INSTALL" in
  0|false|no|off) AUTO_INSTALL=0 ;;
  *)              AUTO_INSTALL=1 ;;
esac

GIMBAL_PORT="${GIMBAL_PORT:-$DEF_CONTROL_PORT}"

# ------------------------------------------------------- 读取已保存配置
conf_get() {
  [ -f "$CONF_FILE" ] || return 0
  grep -E "^[[:space:]]*$1=" "$CONF_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '[:space:]'
}

SAVED_IP="$(conf_get GIMBAL_IP)"
SAVED_PORT="$(conf_get PORT)"
SAVED_LOCAL_PORT="$(conf_get GIMBAL_LOCAL_PORT)"

# 优先级：命令行参数 > 环境变量 > 已保存配置 > 出厂默认
DEFAULT_IP="${ARG_IP:-${GIMBAL_IP:-${SAVED_IP:-$FACTORY_IP}}}"
DEFAULT_PORT="${ARG_PORT:-${PORT:-${SAVED_PORT:-$DEF_PORT}}}"
DEFAULT_LOCAL_PORT="${ARG_LOCAL_PORT:-${GIMBAL_LOCAL_PORT:-${SAVED_LOCAL_PORT:-$DEF_LOCAL_PORT}}}"

save_conf() {
  {
    echo "# HY-DZ230F 吊舱 Web 测试工具 —— 上次使用的设置（自动生成）"
    echo "GIMBAL_IP=$1"
    echo "PORT=$2"
    echo "GIMBAL_LOCAL_PORT=$3"
  } > "$CONF_FILE"
}

valid_ip() {
  local ip="$1" o
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for o in "${BASH_REMATCH[@]:1}"; do
    [ -n "$o" ] && (( 10#$o <= 255 )) || return 1
  done
  return 0
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 ))
}

# ------------------------------------------------------- 端口可用性
# 当前正在监听的本地地址（TCP 或 UDP），每行一个。
listening_addrs() {
  local proto="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -l${proto}n 2>/dev/null | tail -n +2 | awk '{print $4}'
  elif command -v netstat >/dev/null 2>&1; then
    netstat -l${proto}n 2>/dev/null | tail -n +3 | awk '{print $4}'
  fi
}

port_in_use() {
  local proto="$1" p="$2" addrs
  if command -v lsof >/dev/null 2>&1; then
    if [ "$proto" = "t" ]; then
      lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    else
      lsof -nP -iUDP:"$p" >/dev/null 2>&1 && return 0
    fi
  fi
  addrs="$(listening_addrs "$proto")"
  [ -n "$addrs" ] || return 1
  printf '%s\n' "$addrs" | grep -qE "[:.]${p}$" && return 0
  return 1
}

port_holder() {
  local proto="$1" p="$2"
  command -v lsof >/dev/null 2>&1 || return 0
  if [ "$proto" = "t" ]; then
    lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | tail -n +2 | awk '{print $1" (pid "$2")"}' | head -n 3
  else
    lsof -nP -iUDP:"$p" 2>/dev/null | tail -n +2 | awk '{print $1" (pid "$2")"}' | head -n 3
  fi
}

suggest_free_port() {
  local proto="$1" start="$2" p
  for p in $(seq "$start" $((start + 19))); do
    port_in_use "$proto" "$p" || { echo "$p"; return 0; }
  done
  echo "$start"
}

# 询问一个数值；$1=标签 $2=默认值 $3=校验类型 $4=协议(t/u，可选)
ask_value() {
  local label="$1" default="$2" kind="${3:-port}" proto="${4:-}" attempt input holder sug
  for attempt in 1 2 3; do
    printf '\033[36m  %s [%s]: \033[0m' "$label" "$default" >&2
    IFS= read -r input || input=""
    input="$(printf '%s' "$input" | tr -d '[:space:]')"
    [ -z "$input" ] && input="$default"
    if [ "$kind" = "ip" ]; then
      if valid_ip "$input"; then echo "$input"; return 0; fi
      warn "  '$input' 不是合法的 IPv4 地址。"
    else
      if ! valid_port "$input"; then
        warn "  '$input' 不是合法端口（1-65535）。"
        continue
      fi
      if [ -n "$proto" ] && port_in_use "$proto" "$input"; then
        holder="$(port_holder "$proto" "$input")"
        warn "  端口 $input 已被占用${holder:+，占用进程: $(echo "$holder" | tr '\n' ' ')}"
        sug="$(suggest_free_port "$proto" $((input + 1)))"
        warn "  建议改用空闲端口 $sug（回车即采用）"
        default="$sug"
        continue
      fi
      echo "$input"; return 0
    fi
  done
  warn "  多次输入无效，$label 采用默认值 $default"
  echo "$default"
}

# ------------------------------------------------- 包管理器 / 自动安装
PKG_MGR=""
ROOT_CMD=""
NET_OK=""
APT_UPDATED=0

detect_pkg_mgr() {
  [ -n "$PKG_MGR" ] && return 0
  if   command -v apt-get >/dev/null 2>&1; then PKG_MGR="apt"
  elif command -v dnf     >/dev/null 2>&1; then PKG_MGR="dnf"
  elif command -v zypper  >/dev/null 2>&1; then PKG_MGR="zypper"
  elif command -v yum     >/dev/null 2>&1; then PKG_MGR="yum"
  elif command -v pacman  >/dev/null 2>&1; then PKG_MGR="pacman"
  elif command -v apk     >/dev/null 2>&1; then PKG_MGR="apk"
  else PKG_MGR="none"
  fi
  return 0
}

# 判断软件源镜像是否可达，结果缓存到 NET_OK。
net_available() {
  [ -n "$NET_OK" ] && { [ "$NET_OK" = "1" ]; return $?; }
  local url
  if command -v curl >/dev/null 2>&1; then
    for url in http://archive.ubuntu.com/ubuntu/ http://deb.debian.org/debian/ https://mirrors.aliyun.com/ubuntu/; do
      curl -fsS -m 6 -o /dev/null "$url" 2>/dev/null && { NET_OK=1; return 0; }
    done
  elif command -v wget >/dev/null 2>&1; then
    for url in http://archive.ubuntu.com/ubuntu/ http://deb.debian.org/debian/; do
      wget -q -T 6 -t 1 -O /dev/null "$url" 2>/dev/null && { NET_OK=1; return 0; }
    done
  fi
  NET_OK=0
  return 1
}

# 计算如何提权；ROOT_CMD 为 "" 表示已是 root，NONE 表示无法提权。
elevate() {
  [ -n "$ROOT_CMD" ] && { [ "$ROOT_CMD" != "NONE" ]; return $?; }
  if [ "$(id -u)" = "0" ]; then ROOT_CMD=""; return 0; fi
  if command -v sudo >/dev/null 2>&1; then
    if [ -t 0 ] || sudo -n true 2>/dev/null; then ROOT_CMD="sudo"; return 0; fi
    warn "              sudo 需要密码，但当前不是交互终端，无法输入"
    ROOT_CMD="NONE"; return 1
  fi
  if command -v pkexec >/dev/null 2>&1; then ROOT_CMD="pkexec"; return 0; fi
  warn "              当前不是 root，且系统没有 sudo 或 pkexec"
  ROOT_CMD="NONE"; return 1
}

root_hint() {
  if [ "$(id -u)" = "0" ]; then printf ''; else printf 'sudo '; fi
}

# 把 apt 包名翻译成其它包管理器的对应名称。
map_pkg() {
  detect_pkg_mgr
  local n out=""
  for n in "$@"; do
    if [ "$PKG_MGR" != "apt" ]; then
      case "$n" in
        iputils-ping) n="iputils" ;;
        iproute2)     n="iproute" ;;
        procps)       n="procps-ng" ;;
      esac
    fi
    out="$out $n"
  done
  printf '%s' "$out"
}

pkg_install() {
  detect_pkg_mgr
  local pkgs rc
  pkgs="$(map_pkg "$@")"
  case "$PKG_MGR" in
    apt)
      if [ "$APT_UPDATED" != "1" ]; then
        info "  正在刷新软件源索引（apt-get update）..."
        if $ROOT_CMD apt-get update -qq >/dev/null 2>&1; then
          APT_UPDATED=1
        else
          warn "  apt-get update 失败 —— 仍尝试继续安装"
        fi
      fi
      DEBIAN_FRONTEND=noninteractive $ROOT_CMD apt-get install -y --no-install-recommends $pkgs
      rc=$?
      ;;
    dnf)    $ROOT_CMD dnf install -y $pkgs; rc=$? ;;
    yum)    $ROOT_CMD yum install -y $pkgs; rc=$? ;;
    zypper) $ROOT_CMD zypper --non-interactive install $pkgs; rc=$? ;;
    pacman) $ROOT_CMD pacman -S --noconfirm --needed $pkgs; rc=$? ;;
    apk)    $ROOT_CMD apk add --no-cache $pkgs; rc=$? ;;
    *)      warn "  找不到受支持的包管理器（apt/dnf/yum/zypper/pacman/apk）"; return 127 ;;
  esac
  [ "$rc" = "0" ] && hash -r 2>/dev/null
  return $rc
}

confirm() {
  local prompt="$1" ans
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then return 0; fi
  printf '\033[36m  %s [Y/n]: \033[0m' "$prompt" >&2
  IFS= read -r ans || ans=""
  case "$(printf '%s' "$ans" | tr 'A-Z' 'a-z')" in
    ""|y|yes) return 0 ;;
    *) return 1 ;;
  esac
}

# try_install <名称> <apt 包名>...
try_install() {
  local label="$1"; shift
  if [ "$AUTO_INSTALL" != "1" ]; then
    info "              已关闭自动安装（--no-install / AUTO_INSTALL=0）"
    return 1
  fi
  detect_pkg_mgr
  if [ "$PKG_MGR" = "none" ]; then
    warn "              找不到包管理器，无法自动安装 -> 请手动安装: $*"
    return 1
  fi
  if ! net_available; then
    warn "              本机无网络，无法下载 -> 请先自行下载安装: $*"
    return 1
  fi
  if ! elevate; then
    warn "              无法获取 root 权限 -> 请手动安装: $(root_hint)apt-get install -y $*"
    return 1
  fi
  confirm "是否现在自动安装 $label（$*）？可能需要几分钟" || { info "  用户跳过安装"; return 1; }
  info "  正在安装 $label ..."
  if pkg_install "$@"; then
    green "  已安装      $label"
    return 0
  fi
  warn "  $label 安装失败（原因见上方输出）"
  return 1
}

# Node 需要 >= 18，而 Ubuntu 自带源里的 nodejs 往往偏旧。
install_node() {
  detect_pkg_mgr
  if [ "$PKG_MGR" != "apt" ]; then
    try_install "nodejs" nodejs
    return $?
  fi
  if [ "$AUTO_INSTALL" != "1" ]; then
    info "              已关闭自动安装（--no-install / AUTO_INSTALL=0）"
    return 1
  fi
  net_available || { warn "              本机无网络，无法下载 Node.js -> 请先自行下载安装"; return 1; }
  elevate       || return 1
  confirm "是否现在自动安装 Node.js 20（NodeSource 源）？" || { info "  用户跳过安装"; return 1; }
  if command -v curl >/dev/null 2>&1; then
    local setup
    setup="$(mktemp -t nodesource-XXXXXX.sh)"
    info "  正在添加 NodeSource 软件源 ..."
    if curl -fsSL https://deb.nodesource.com/setup_20.x -o "$setup" 2>/dev/null; then
      $ROOT_CMD bash "$setup" >/dev/null 2>&1
      APT_UPDATED=1   # NodeSource 脚本内部已经刷新过索引
    else
      warn "  NodeSource 脚本下载失败 —— 改用系统自带源安装"
    fi
    rm -f "$setup"
  else
    warn "  缺少 curl，无法添加 NodeSource —— 改用系统自带源安装"
  fi
  info "  正在安装 nodejs ..."
  pkg_install nodejs
}

# =========================================================== 1. 依赖检查
check_deps() {
  title "1/5 依赖检查"
  local fatal=0

  info "架构: $(uname -m)   系统: $(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}" || echo unknown)"
  detect_pkg_mgr
  info "包管理器: $PKG_MGR"
  if [ "$AUTO_INSTALL" = "1" ]; then
    if net_available; then
      green "网络:        可达 -> 缺失的依赖将自动安装"
    else
      warn "网络:        不可达 -> 缺失依赖只能报告，无法自动下载"
    fi
  else
    info "自动安装:    已关闭（--no-install / AUTO_INSTALL=0）"
  fi

  # 诊断工具（curl / ping / ip / ss / lsof）
  local opt_pkgs="" pair bin pkg have_all
  for pair in curl:curl ping:iputils-ping ip:iproute2 ss:iproute2 lsof:lsof; do
    bin="${pair%%:*}"
    command -v "$bin" >/dev/null 2>&1 && continue
    pkg="${pair##*:}"
    case " $opt_pkgs " in *" $pkg "*) ;; *) opt_pkgs="$opt_pkgs $pkg" ;; esac
  done
  if [ -n "$opt_pkgs" ]; then
    warn "  诊断工具    缺失  $opt_pkgs  （缺了会导致部分自检被跳过）"
    try_install "诊断工具" $opt_pkgs
  fi
  have_all=1
  for bin in curl ping ip ss lsof; do
    command -v "$bin" >/dev/null 2>&1 || have_all=0
  done
  [ "$have_all" = "1" ] && green "  诊断工具    OK       curl ping ip ss lsof"

  # Node.js >= 18
  local nv nm node_ok=0
  nv="$(node -p 'process.versions.node' 2>/dev/null || true)"
  nm="${nv%%.*}"
  [[ "$nm" =~ ^[0-9]+$ ]] && (( nm >= 18 )) && node_ok=1
  if [ "$node_ok" = "1" ]; then
    green "  node        OK       v$nv"
  else
    if [ -n "$nv" ]; then red "  node        版本过低  v$nv（需要 >= 18）"; else red "  node        缺失"; fi
    if install_node; then
      nv="$(node -p 'process.versions.node' 2>/dev/null || true)"
      nm="${nv%%.*}"
      if [[ "$nm" =~ ^[0-9]+$ ]] && (( nm >= 18 )); then
        green "  node        OK       v$nv（刚装好）"
      else
        red "  node        安装后仍不可用 v${nv:-unknown}"
        fatal=1
      fi
    else
      info "              手动安装: curl -fsSL https://deb.nodesource.com/setup_20.x | $(root_hint)bash - && $(root_hint)apt-get install -y nodejs"
      fatal=1
    fi
  fi

  # Python 3（厂商 SDK 桥接进程靠它编码每一帧控制指令）
  if command -v python3 >/dev/null 2>&1; then
    green "  python3     OK       $(python3 -V 2>&1)"
  else
    if command -v python >/dev/null 2>&1; then
      warn "  python3     缺失  （但找到了 'python': $(python -V 2>&1)）"
    else
      red "  python3     缺失  -> 无法编码云台/相机控制指令"
    fi
    if try_install "python3" python3 && command -v python3 >/dev/null 2>&1; then
      green "  python3     OK       $(python3 -V 2>&1)（刚装好）"
    else
      info "              手动安装: $(root_hint)apt-get install -y python3（或用 PYTHON_PATH 指定解释器）"
      fatal=1
    fi
  fi

  # 厂商 SDK
  if [ -f "$ROOT/vendor/hy_gimbal.py" ]; then
    green "  厂商 SDK    OK       vendor/hy_gimbal.py"
  else
    red "  厂商 SDK    缺失  $ROOT/vendor/hy_gimbal.py"
    fatal=1
  fi

  # 应用源码
  local missing_src=0 f
  for f in src/server.js src/protocol.js src/report.js src/python_sdk_bridge.py public/index.html public/app.js; do
    [ -f "$ROOT/$f" ] || { red "  源码        缺失  $f"; missing_src=1; }
  done
  [ "$missing_src" = "0" ] && green "  源码        OK       src/ + public/ 齐全"
  [ "$missing_src" = "1" ] && fatal=1

  # FFmpeg（视频预览 / 拍照 / 录像）—— 非致命，没有它控制仍可用
  FFMPEG_BIN="${FFMPEG_PATH:-}"
  if [ -z "$FFMPEG_BIN" ] && [ -x "$ROOT/tools/ffmpeg/bin/ffmpeg" ]; then
    FFMPEG_BIN="$ROOT/tools/ffmpeg/bin/ffmpeg"
  fi
  if [ -z "$FFMPEG_BIN" ] && command -v ffmpeg >/dev/null 2>&1; then
    FFMPEG_BIN="$(command -v ffmpeg)"
  fi
  if [ -n "$FFMPEG_BIN" ]; then
    green "  ffmpeg      OK       $FFMPEG_BIN"
  else
    warn "  ffmpeg      缺失  -> 视频预览 / 拍照 / 录像将不可用"
    if try_install "ffmpeg" ffmpeg && command -v ffmpeg >/dev/null 2>&1; then
      FFMPEG_BIN="$(command -v ffmpeg)"
      green "  ffmpeg      OK       $FFMPEG_BIN（刚装好）"
    else
      info "              手动安装: $(root_hint)apt-get install -y ffmpeg"
      info "              （没有它，MAVLink 控制和 RTSP 连通性探测仍然可用）"
    fi
  fi

  DEPS_FATAL=$fatal
  if [ "$fatal" = "1" ]; then
    red "  结果: 依赖不完整 —— 请先解决上面的缺失项。"
    return 1
  fi
  green "  结果: 必需依赖全部就绪。"
  return 0
}

# ============================================ 2. 询问吊舱 IP + 本地端口
resolve_settings() {
  title "2/5 吊舱 IP 与本地端口"

  local interactive=1
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
    interactive=0
    if [ ! -t 0 ]; then
      info "  非交互终端 -> 直接使用已保存/默认值"
    else
      info "  已指定 --yes -> 直接使用已保存/默认值"
    fi
  else
    info "  回车采用方括号内的值，或直接输入新值。"
  fi

  # ---- 吊舱 IP ----------------------------------------------------------
  if [ "$interactive" = "1" ] && [ -z "$ARG_IP" ]; then
    GIMBAL_IP="$(ask_value "吊舱 IP" "$DEFAULT_IP" ip)"
  else
    GIMBAL_IP="$DEFAULT_IP"
  fi
  if ! valid_ip "$GIMBAL_IP"; then
    red "  吊舱 IP 非法: $GIMBAL_IP"
    exit 2
  fi
  green "  吊舱 IP        $GIMBAL_IP"

  # ---- Web 端口 ----------------------------------------------------------
  if [ "$interactive" = "1" ] && [ -z "$ARG_PORT" ]; then
    if port_in_use t "$DEFAULT_PORT"; then
      local holder
      holder="$(port_holder t "$DEFAULT_PORT" | tr '\n' ' ')"
      warn "  Web 端口 $DEFAULT_PORT 已被占用${holder:+，占用进程: $holder}"
      DEFAULT_PORT="$(suggest_free_port t $((DEFAULT_PORT + 1)))"
      warn "  建议改用 $DEFAULT_PORT（回车即采用）"
    fi
    PORT="$(ask_value "Web 端口" "$DEFAULT_PORT" port t)"
  else
    PORT="$DEFAULT_PORT"
    if port_in_use t "$PORT"; then
      warn "  Web 端口 $PORT 被占用 —— 第 4 步会先停掉占用它的旧实例"
    fi
  fi
  if ! valid_port "$PORT"; then
    red "  Web 端口非法: $PORT"
    exit 2
  fi
  green "  Web 端口       $PORT   ->   http://127.0.0.1:$PORT"

  # ---- 本地 UDP 接收端口 --------------------------------------------------
  if [ "$interactive" = "1" ] && [ -z "$ARG_LOCAL_PORT" ]; then
    if port_in_use u "$DEFAULT_LOCAL_PORT"; then
      local uholder
      uholder="$(port_holder u "$DEFAULT_LOCAL_PORT" | tr '\n' ' ')"
      warn "  UDP $DEFAULT_LOCAL_PORT 已被占用${uholder:+，占用进程: $uholder}"
      warn "  若一直被占用，服务会退到随机端口，导致收不到吊舱回包"
      DEFAULT_LOCAL_PORT="$(suggest_free_port u $((DEFAULT_LOCAL_PORT + 1)))"
      warn "  建议改用 $DEFAULT_LOCAL_PORT（回车即采用）"
    fi
    GIMBAL_LOCAL_PORT="$(ask_value "本地 UDP 接收端口" "$DEFAULT_LOCAL_PORT" port u)"
  else
    GIMBAL_LOCAL_PORT="$DEFAULT_LOCAL_PORT"
  fi
  if ! valid_port "$GIMBAL_LOCAL_PORT"; then
    red "  本地 UDP 端口非法: $GIMBAL_LOCAL_PORT"
    exit 2
  fi
  green "  本地 UDP 接收  $GIMBAL_LOCAL_PORT   （吊舱回包发到这里）"

  info "  控制 UDP $GIMBAL_PORT + SDK UDP 14550  ->  $GIMBAL_IP"
  info "  RTSP        rtsp://$GIMBAL_IP/live/main , rtsp://$GIMBAL_IP/live/thermal"
  save_conf "$GIMBAL_IP" "$PORT" "$GIMBAL_LOCAL_PORT"
}

# ==================================================== 3. 网络自检
check_network() {
  title "3/5 网络自检（目标 $GIMBAL_IP）"

  info "  本机 IPv4 地址:"
  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show 2>/dev/null | awk '{printf "    %-14s %s\n", $2, $4}'
  else
    info "    （ip 命令不可用）"
  fi

  if command -v ip >/dev/null 2>&1; then
    info "  路由: $(ip route get "$GIMBAL_IP" 2>&1 | head -n 1)"
  fi

  NET_OK=1
  if command -v ping >/dev/null 2>&1; then
    if ping -c 2 -W 2 "$GIMBAL_IP" >/dev/null 2>&1; then
      green "  ICMP        可达"
    else
      warn "  ICMP        不可达"
      NET_OK=0
    fi
  fi

  # RTSP TCP 554（不依赖 ffmpeg）
  if command -v timeout >/dev/null 2>&1; then
    if timeout 3 bash -c "cat < /dev/null > /dev/tcp/$GIMBAL_IP/$RTSP_PORT" 2>/dev/null; then
      green "  RTSP TCP $RTSP_PORT  开放"
    else
      warn "  RTSP TCP $RTSP_PORT  关闭/不可达 -> 视频预览会一直黑屏"
      NET_OK=0
    fi
  fi

  if [ "$NET_OK" = "0" ]; then
    warn "  主机网卡必须和吊舱在同一网段。示例："
    warn "    sudo ip addr add 192.168.124.164/24 dev <你的网卡名>"
    warn "  或者用设备真实地址启动:  bash ./start-ubuntu.sh --ip <地址>"
  fi

  # 本地端口可用性（Web TCP + UDP 接收）
  local holders=""
  if port_in_use u "$GIMBAL_LOCAL_PORT"; then
    holders="$(port_holder u "$GIMBAL_LOCAL_PORT" | tr '\n' ' ')"
    warn "  UDP $GIMBAL_LOCAL_PORT 仍被占用${holders:+，占用进程: $holders}"
    warn "  服务会退到随机本地端口，导致收不到吊舱回包。"
    warn "  请重启后换一个空闲端口，或先停掉上面的进程。"
  else
    green "  UDP $GIMBAL_LOCAL_PORT 空闲（本地接收）"
  fi

  if port_in_use t "$PORT"; then
    holders="$(port_holder t "$PORT" | tr '\n' ' ')"
    warn "  TCP $PORT 仍被占用${holders:+，占用进程: $holders} —— 第 4 步会释放"
  else
    green "  TCP $PORT 空闲（Web 界面）"
  fi

  # 防火墙
  if command -v ufw >/dev/null 2>&1; then
    local st
    st="$(ufw status 2>/dev/null | head -n 1)"
    case "$st" in
      *active*) warn "  ufw: $st（若需从别的机器访问界面，请放行入站 TCP $PORT）" ;;
      *)        info "  ufw: ${st:-未启用}" ;;
    esac
  fi
}

# ========================================================== 4. 清理旧实例
cleanup_old() {
  title "4/5 重启清理"

  if [ -f "$PID_FILE" ]; then
    local old_pid
    old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
      info "  停止上一个测试进程 pid $old_pid"
      kill -9 "$old_pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi

  pkill -f "node .*src/server.js" 2>/dev/null || true
  pkill -f "$ROOT/src/python_sdk_bridge.py" 2>/dev/null || true

  if [ "$NO_KILL" != "1" ] && command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$({
      lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
      lsof -tiUDP:"$GIMBAL_LOCAL_PORT" 2>/dev/null || true
    } | sort -u)"
    if [ -n "$pids" ]; then
      info "  释放 Web 端口 $PORT / UDP $GIMBAL_LOCAL_PORT（pid: $(echo "$pids" | tr '\n' ' ')）"
      echo "$pids" | xargs -r kill -9
    fi
  fi
  sleep 0.3
  info "  完成"
}

# ====================================================== 5. 启动 + 健康检查
start_server() {
  title "5/5 启动服务"

  mkdir -p "$ROOT/logs" "$ROOT/photos" "$ROOT/recordings" "$ROOT/reports"

  export PORT GIMBAL_IP GIMBAL_PORT GIMBAL_LOCAL_PORT
  [ -n "${FFMPEG_BIN:-}" ] && export FFMPEG_PATH="$FFMPEG_BIN"

  info "  Web 界面    : http://127.0.0.1:${PORT}   （局域网: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}）"
  info "  吊舱        : ${GIMBAL_IP}   控制 UDP ${GIMBAL_PORT} / SDK 14550   本地接收 UDP ${GIMBAL_LOCAL_PORT}"
  info "  日志文件    : $ROOT/logs/$(date +%F).log"
  info "  本次取值已存为下次默认: $CONF_FILE"
  info "  改 IP 不用重启：Web 界面 -> 设置抽屉 -> 设备 IP -> 重连"
  echo

  node ./src/server.js &
  NODE_PID=$!
  echo "$NODE_PID" > "$PID_FILE"
  trap 'kill -TERM "$NODE_PID" 2>/dev/null || true; rm -f "$PID_FILE"; cleanup_tmp' INT TERM

  local ready=0 i
  for i in $(seq 1 40); do
    kill -0 "$NODE_PID" 2>/dev/null || break
    if command -v curl >/dev/null 2>&1; then
      curl -s -m 1 "http://127.0.0.1:$PORT/api/version" >/dev/null 2>&1 && { ready=1; break; }
    else
      ready=1; break
    fi
    sleep 0.5
  done

  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    red "  服务进程在启动阶段就退出了 —— 详见 logs/$(date +%F).log"
    rm -f "$PID_FILE"
    exit 1
  fi
  if [ "$ready" != "1" ]; then
    warn "  服务 20 秒内没有响应端口 $PORT（进程仍在运行，pid $NODE_PID）"
  fi

  if [ "$AUTO_CONNECT" = "1" ] && command -v curl >/dev/null 2>&1; then
    curl -s -m 8 -X POST -H 'content-type: application/json' \
      -d "{\"deviceIp\":\"$GIMBAL_IP\",\"controlPort\":$GIMBAL_PORT,\"localPort\":$GIMBAL_LOCAL_PORT}" \
      "http://127.0.0.1:$PORT/api/connect" >/dev/null 2>&1
    sleep 1.5
    health_report
  fi

  echo
  wait "$NODE_PID"
}

health_report() {
  title "启动后健康检查"
  curl -s -m 5 "http://127.0.0.1:$PORT/api/status" -o "$STATUS_TMP" 2>/dev/null
  if [ ! -s "$STATUS_TMP" ]; then
    warn "  读取 /api/status 失败"
    return
  fi
  node -e '
    const fs = require("fs");
    let s;
    try { s = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch (e) { console.error("  状态解析失败: " + e.message); process.exit(0); }
    const cfg = s.config || {}, la = s.udpLocalAddress || {}, c = s.counters || {}, py = s.pythonSdk || {};
    const line = (k, v) => console.log("  " + k.padEnd(14) + v);
    line("设备", `${cfg.deviceIp}  控制 ${cfg.controlPort}  sdk ${cfg.sdkTargetPort}`);
    line("udp 绑定", `${la.address || "-"}:${la.port || "-"}  （期望 ${cfg.localPort}）`);
    line("ffmpeg", s.ffmpegAvailable ? "可用" : "缺失 -> 无视频预览");
    line("python sdk", py.running ? "运行中" : "未运行" + (py.lastError ? "  lastError: " + py.lastError : ""));
    line("数据包", `TX ${c.txPackets || 0}  RX ${c.rxPackets || 0}  parseErrors ${c.parseErrors || 0}`);
    line("rtsp", (s.rtsp || {}).visible || "-");
    for (const [ch, m] of Object.entries(s.mjpeg || {})) {
      if (m.lastError) line("mjpeg " + ch, String(m.lastError).slice(0, 110));
    }
    console.log("");
    if ((c.rxPackets || 0) === 0) {
      console.log("  [!] RX = 0：吊舱没有回包。");
      console.log("      请检查网段/网卡、设备 IP，以及 UDP " + (cfg.localPort) + " 是否被别的进程占用。");
    } else {
      console.log("  [ok] 吊舱回包正常 —— 控制链路是通的。");
    }
    if (la.port && cfg.localPort && la.port !== cfg.localPort) {
      console.log("  [!] 绑定到了随机本地端口：发到 " + cfg.localPort + " 的回包会丢失。");
    }
    if (!s.ffmpegAvailable) {
      console.log("  [!] ffmpeg 缺失 -> 没有视频预览 / 拍照 / 录像。");
      console.log("      联网状态下重跑 ./start-ubuntu.sh 会自动安装，");
      console.log("      或现在就装: sudo apt-get install -y ffmpeg（装完重启服务）");
    }
  ' "$STATUS_TMP"
}

# =================================================================== 主流程
echo "==============================================================" >&2
echo " HY-DZ230F 吊舱 Web 测试工具 - Ubuntu" >&2
echo "==============================================================" >&2

if [ "${SKIP_CHECKS:-0}" != "1" ]; then
  if ! check_deps; then
    echo >&2
    red "启动中止：依赖不完整。"
    exit 1
  fi
else
  warn "SKIP_CHECKS=1 -> 跳过依赖检查"
fi

resolve_settings

if [ "${SKIP_CHECKS:-0}" != "1" ]; then
  check_network
fi

if [ "$CHECK_ONLY" = "1" ]; then
  title "体检模式"
  if command -v curl >/dev/null 2>&1 && curl -s -m 2 "http://127.0.0.1:$PORT/api/version" >/dev/null 2>&1; then
    info "  端口 $PORT 上已有一个测试实例在运行"
    health_report
  else
    info "  端口 $PORT 上没有运行中的测试实例（无可查询对象）"
  fi
  LOG="$ROOT/logs/$(date +%F).log"
  if [ -f "$LOG" ]; then
    title "最近的错误（$LOG）"
    grep -E '"level":"(error|warn)"' "$LOG" | tail -n 15 >&2
  fi
  echo >&2
  green "体检完成。启动命令: bash ./start-ubuntu.sh"
  exit 0
fi

cleanup_old
start_server
