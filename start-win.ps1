<#
=============================================================================
 HY-DZ230F 吊舱 Web 测试工具 —— Windows 启动脚本

 流程：1/5 依赖检查 -> 2/5 交互确认吊舱 IP / Web 端口 / 本地 UDP 端口
       3/5 网络自检 -> 4/5 清理旧实例 -> 5/5 启动服务 -> 启动后健康检查

 每次启动都会交互式询问 IP 与端口，切换设备、避开被占用端口都无需改脚本。
 检测到端口被占用时会自动建议一个空闲端口（回车即采用）。
 上次使用的值会写入 .gimbal-tester.conf，作为下次的默认值。
 Web 界面里也能随时改 IP（右上角设置抽屉 -> 设备 IP -> 重连），不必重启。

 依赖处理：node / python / 厂商 SDK / 源码 缺失会直接报错并给出下载地址；
 ffmpeg 缺失只警告（包内自带 tools\ffmpeg\bin\ffmpeg.exe，一般不会缺）。

 用法：
   .\start-win.ps1                                  # 交互式（日常使用）
   .\start-win.ps1 -CheckOnly                       # 只做体检，不启动服务
   .\start-win.ps1 -GimbalIp 192.168.124.64 -Port 8090 -LocalPort 3000
   .\start-win.ps1 -Yes                             # 不询问，直接用已保存/默认值
=============================================================================
#>
param(
  [string]$GimbalIp = "",
  [int]$Port = 0,
  [int]$LocalPort = 0,
  [switch]$CheckOnly,
  [switch]$Yes,
  [switch]$NoConnect,
  [switch]$NoKill,
  [switch]$StartOnly,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

# 让控制台正确显示中文与 UTF-8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ConfFile       = Join-Path $Root ".gimbal-tester.conf"
$PidFile        = Join-Path $Root ".gimbal-tester.pid"
$FactoryIp      = "192.168.124.64"
$DefPort        = 8080
$DefControlPort = 3000
$DefLocalPort   = 3000
$RtspPort       = 554

# ------------------------------------------------------------------ 输出
function Write-Title([string]$m) { Write-Host ""; Write-Host "--- $m ---" -ForegroundColor Cyan }
function Write-Ok([string]$m)    { Write-Host $m -ForegroundColor Green }
function Write-Warn2([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Write-Err2([string]$m)  { Write-Host $m -ForegroundColor Red }
function Write-Info([string]$m)  { Write-Host $m }

function Show-Usage {
  Write-Host @"
HY-DZ230F 吊舱 Web 测试工具（Windows）

用法: .\start-win.ps1 [选项]

正常启动会依次询问：吊舱 IP、Web 端口、本地 UDP 接收端口。
直接回车即采用方括号里的默认值；上次用过的值会记入 .gimbal-tester.conf，
下次启动时成为新的默认值。

选项:
  -GimbalIp <地址>    吊舱 IP（跳过该项询问）
  -Port <n>           Web 端口，默认 $DefPort（跳过该项询问）
  -LocalPort <n>      本地 UDP 接收端口，默认 $DefLocalPort（跳过该项询问）
  -CheckOnly          只运行体检后退出，不启动服务
  -Yes                非交互：直接使用已保存/默认值
  -NoConnect          启动服务，但开机后不自动连接设备
  -NoKill             不杀掉占用 Web 端口 / UDP 端口的进程
  -StartOnly          跳过重启清理
  -Help               显示本帮助

环境变量: GIMBAL_IP, PORT, GIMBAL_PORT, GIMBAL_LOCAL_PORT,
          FFMPEG_PATH, PYTHON_PATH, HY_PYTHON_SDK, SKIP_CHECKS
"@
}

if ($Help) { Show-Usage; exit 0 }

# ------------------------------------------------------- 读取已保存配置
function Read-ConfValue([string]$key) {
  if (-not (Test-Path $ConfFile)) { return "" }
  $line = Get-Content $ConfFile -ErrorAction SilentlyContinue |
    Where-Object { $_ -match "^\s*$key=" } | Select-Object -Last 1
  if ($line) { return (($line -split '=', 2)[1]).Trim() }
  return ""
}

function Save-Conf([string]$ip, [int]$webPort, [int]$udpPort) {
  $lines = @(
    "# HY-DZ230F 吊舱 Web 测试工具 —— 上次使用的设置（自动生成）"
    "GIMBAL_IP=$ip"
    "PORT=$webPort"
    "GIMBAL_LOCAL_PORT=$udpPort"
  )
  Set-Content -Path $ConfFile -Value $lines -Encoding ASCII
}

function Test-IPv4([string]$ip) {
  if ($ip -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$') { return $false }
  foreach ($o in @($Matches[1], $Matches[2], $Matches[3], $Matches[4])) {
    if ([int]$o -gt 255) { return $false }
  }
  return $true
}

function Test-PortValue([string]$p) {
  $n = 0
  if (-not [int]::TryParse($p, [ref]$n)) { return $false }
  return ($n -ge 1 -and $n -le 65535)
}

# 优先级：命令行参数 > 环境变量 > 已保存配置 > 出厂默认
$savedIp   = Read-ConfValue "GIMBAL_IP"
$savedPort = Read-ConfValue "PORT"
$savedUdp  = Read-ConfValue "GIMBAL_LOCAL_PORT"

$DefaultIp = if ($GimbalIp) { $GimbalIp } elseif ($env:GIMBAL_IP) { $env:GIMBAL_IP } elseif ($savedIp) { $savedIp } else { $FactoryIp }
$DefaultPort = if ($Port -gt 0) { $Port } elseif ($env:PORT) { [int]$env:PORT } elseif ($savedPort) { [int]$savedPort } else { $DefPort }
$DefaultLocalPort = if ($LocalPort -gt 0) { $LocalPort } elseif ($env:GIMBAL_LOCAL_PORT) { [int]$env:GIMBAL_LOCAL_PORT } elseif ($savedUdp) { [int]$savedUdp } else { $DefLocalPort }
$ControlPort = if ($env:GIMBAL_PORT) { [int]$env:GIMBAL_PORT } else { $DefControlPort }

# ------------------------------------------------------- 端口可用性
function Test-PortInUse([string]$proto, [int]$p) {
  try {
    if ($proto -eq "tcp") {
      $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
      return [bool]$c
    } else {
      $c = Get-NetUDPEndpoint -LocalPort $p -ErrorAction SilentlyContinue
      return [bool]$c
    }
  } catch { return $false }
}

function Get-PortHolder([string]$proto, [int]$p) {
  try {
    if ($proto -eq "tcp") {
      $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    } else {
      $c = Get-NetUDPEndpoint -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if ($c -and $c.OwningProcess) {
      $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      if ($proc) { return "$($proc.ProcessName) (pid $($proc.Id))" }
    }
  } catch {}
  return ""
}

function Get-FreePortSuggestion([string]$proto, [int]$start) {
  for ($p = $start; $p -le ($start + 19); $p++) {
    if (-not (Test-PortInUse $proto $p)) { return $p }
  }
  return $start
}

function Read-Value([string]$label, [string]$default, [string]$kind, [string]$proto) {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $answer = Read-Host "  $label [$default]"
    if ($null -eq $answer) { $answer = "" }
    $answer = $answer.Trim()
    if (-not $answer) { $answer = $default }

    if ($kind -eq "ip") {
      if (Test-IPv4 $answer) { return $answer }
      Write-Warn2 "  '$answer' 不是合法的 IPv4 地址。"
    } else {
      if (-not (Test-PortValue $answer)) {
        Write-Warn2 "  '$answer' 不是合法端口（1-65535）。"
        continue
      }
      $pnum = [int]$answer
      if ($proto -and (Test-PortInUse $proto $pnum)) {
        $holder = Get-PortHolder $proto $pnum
        if ($holder) { Write-Warn2 "  端口 $pnum 已被占用，占用进程: $holder" }
        else { Write-Warn2 "  端口 $pnum 已被占用" }
        $default = [string](Get-FreePortSuggestion $proto ($pnum + 1))
        Write-Warn2 "  建议改用空闲端口 $default（回车即采用）"
        continue
      }
      return $answer
    }
  }
  Write-Warn2 "  多次输入无效，$label 采用默认值 $default"
  return $default
}

# =========================================================== 1. 依赖检查
$Script:DepsFatal = $false

function Check-Deps {
  Write-Title "1/5 依赖检查"
  Write-Info "  系统: $([System.Environment]::OSVersion.VersionString)   架构: $env:PROCESSOR_ARCHITECTURE"
  $fatal = $false

  # Node.js >= 18
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    try {
      $nv = (& node -p "process.versions.node" 2>$null | Out-String).Trim()
      $nm = 0
      if ($nv -match '^(\d+)') { $nm = [int]$Matches[1] }
      if ($nm -ge 18) { Write-Ok "  node        OK       v$nv" }
      else {
        Write-Err2 "  node        版本过低  v$nv（需要 >= 18）—— 请到 https://nodejs.org/ 安装 Node 20 LTS"
        $fatal = $true
      }
    } catch {
      Write-Warn2 "  node        已找到，但版本检测失败"
    }
  } else {
    Write-Err2 "  node        缺失  —— 请到 https://nodejs.org/ 安装 Node.js 18+"
    $fatal = $true
  }

  # Python 3（厂商 SDK 桥接进程靠它编码每一帧控制指令）
  $pyCmd = $null
  foreach ($cand in @("python", "py", "python3")) {
    if (Get-Command $cand -ErrorAction SilentlyContinue) { $pyCmd = $cand; break }
  }
  if ($env:PYTHON_PATH) { $pyCmd = $env:PYTHON_PATH }
  if ($pyCmd) {
    try {
      if ($pyCmd -eq "py") { $pv = (& py -3 -V 2>&1 | Out-String).Trim() }
      else { $pv = (& $pyCmd -V 2>&1 | Out-String).Trim() }
      Write-Ok "  python      OK       $pv  ($pyCmd)"
    } catch {
      Write-Warn2 "  python      已找到（$pyCmd），但版本检测失败"
    }
  } else {
    Write-Err2 "  python      缺失  -> 无法编码云台/相机控制指令"
    Write-Info "              请到 https://www.python.org/ 安装 Python 3，或设置 PYTHON_PATH"
    $fatal = $true
  }

  # 厂商 SDK + 应用源码
  if (Test-Path (Join-Path $Root "vendor\hy_gimbal.py")) {
    Write-Ok "  厂商 SDK    OK       vendor\hy_gimbal.py"
  } else {
    Write-Err2 "  厂商 SDK    缺失  vendor\hy_gimbal.py"
    $fatal = $true
  }
  $missingSrc = $false
  foreach ($f in @("src\server.js", "src\protocol.js", "src\report.js", "src\python_sdk_bridge.py", "public\index.html", "public\app.js")) {
    if (-not (Test-Path (Join-Path $Root $f))) { Write-Err2 "  源码        缺失  $f"; $missingSrc = $true }
  }
  if (-not $missingSrc) { Write-Ok "  源码        OK       src\ + public\ 齐全" } else { $fatal = $true }

  # FFmpeg（视频预览 / 拍照 / 录像）
  $ff = ""
  if ($env:FFMPEG_PATH) { $ff = $env:FFMPEG_PATH }
  if (-not $ff) {
    $local = Join-Path $Root "tools\ffmpeg\bin\ffmpeg.exe"
    if (Test-Path $local) { $ff = $local }
  }
  if (-not $ff) {
    $found = Get-ChildItem (Join-Path $Root "tools") -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $ff = $found.FullName }
  }
  if (-not $ff) {
    $inPath = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($inPath) { $ff = $inPath.Source }
  }
  if ($ff) {
    Write-Ok "  ffmpeg      OK       $ff"
    $Script:FfmpegBin = $ff
    $ffDir = Split-Path -Parent $ff
    if ($env:PATH -notlike "*$ffDir*") { $env:PATH = "$ffDir;$env:PATH" }
  } else {
    Write-Warn2 "  ffmpeg      缺失  -> 视频预览 / 拍照 / 录像将不可用"
    Write-Info "              把 ffmpeg.exe 放到 tools\ffmpeg\bin\，或设置 FFMPEG_PATH，"
    Write-Info "              或运行: .\install-ffmpeg-win.ps1"
    Write-Info "              （没有它，MAVLink 控制和 RTSP 连通性探测仍然可用）"
    $Script:FfmpegBin = ""
  }

  $Script:DepsFatal = $fatal
  if ($fatal) { Write-Err2 "  结果: 依赖不完整 —— 请先解决上面的缺失项。" ; return $false }
  Write-Ok "  结果: 必需依赖全部就绪。"
  return $true
}

# ============================================ 2. 询问吊舱 IP + 本地端口
function Resolve-Settings {
  Write-Title "2/5 吊舱 IP 与本地端口"

  $interactive = $true
  if ($Yes) { $interactive = $false; Write-Info "  已指定 -Yes -> 直接使用已保存/默认值" }
  elseif ([System.Console]::IsInputRedirected) { $interactive = $false; Write-Info "  非交互终端 -> 直接使用已保存/默认值" }
  else { Write-Info "  回车采用方括号内的值，或直接输入新值。" }

  # ---- 吊舱 IP
  if ($interactive -and -not $GimbalIp) {
    $Script:UseIp = Read-Value "吊舱 IP" $DefaultIp "ip" ""
  } else {
    $Script:UseIp = $DefaultIp
  }
  if (-not (Test-IPv4 $Script:UseIp)) { Write-Err2 "  吊舱 IP 非法: $($Script:UseIp)"; exit 2 }
  Write-Ok "  吊舱 IP        $($Script:UseIp)"

  # ---- Web 端口
  if ($interactive -and $Port -le 0) {
    $defP = $DefaultPort
    if (Test-PortInUse "tcp" $defP) {
      $holder = Get-PortHolder "tcp" $defP
      if ($holder) { Write-Warn2 "  Web 端口 $defP 已被占用，占用进程: $holder" }
      else { Write-Warn2 "  Web 端口 $defP 已被占用" }
      $defP = Get-FreePortSuggestion "tcp" ($defP + 1)
      Write-Warn2 "  建议改用 $defP（回车即采用）"
    }
    $Script:UsePort = [int](Read-Value "Web 端口" "$defP" "port" "tcp")
  } else {
    $Script:UsePort = $DefaultPort
    if (Test-PortInUse "tcp" $Script:UsePort) {
      Write-Warn2 "  Web 端口 $($Script:UsePort) 被占用 —— 第 4 步会先停掉占用它的旧实例"
    }
  }
  Write-Ok "  Web 端口       $($Script:UsePort)   ->   http://127.0.0.1:$($Script:UsePort)"

  # ---- 本地 UDP 接收端口
  if ($interactive -and $LocalPort -le 0) {
    $defU = $DefaultLocalPort
    if (Test-PortInUse "udp" $defU) {
      $holder = Get-PortHolder "udp" $defU
      if ($holder) { Write-Warn2 "  UDP $defU 已被占用，占用进程: $holder" }
      else { Write-Warn2 "  UDP $defU 已被占用" }
      Write-Warn2 "  若一直被占用，服务会退到随机端口，导致收不到吊舱回包"
      $defU = Get-FreePortSuggestion "udp" ($defU + 1)
      Write-Warn2 "  建议改用 $defU（回车即采用）"
    }
    $Script:UseLocalPort = [int](Read-Value "本地 UDP 接收端口" "$defU" "port" "udp")
  } else {
    $Script:UseLocalPort = $DefaultLocalPort
  }
  Write-Ok "  本地 UDP 接收  $($Script:UseLocalPort)   （吊舱回包发到这里）"

  Write-Info "  控制 UDP $ControlPort + SDK UDP 14550  ->  $($Script:UseIp)"
  Write-Info "  RTSP        rtsp://$($Script:UseIp)/live/main , rtsp://$($Script:UseIp)/live/thermal"
  Save-Conf $Script:UseIp $Script:UsePort $Script:UseLocalPort
}

# ==================================================== 3. 网络自检
function Check-Network {
  Write-Title "3/5 网络自检（目标 $($Script:UseIp)）"

  Write-Info "  本机 IPv4 地址:"
  try {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -ne "127.0.0.1" } |
      ForEach-Object { Write-Info ("    {0,-22} {1}/{2}" -f $_.InterfaceAlias, $_.IPAddress, $_.PrefixLength) }
  } catch { Write-Info "    （Get-NetIPAddress 不可用）" }

  $netOk = $true
  try {
    if (Test-Connection -ComputerName $Script:UseIp -Count 2 -Quiet -ErrorAction SilentlyContinue) {
      Write-Ok "  ICMP        可达"
    } else {
      Write-Warn2 "  ICMP        不可达（ping 被拦截或网段不对）"
      $netOk = $false
    }
  } catch { Write-Warn2 "  ICMP        检测失败: $($_.Exception.Message)"; $netOk = $false }

  # RTSP TCP 554（不依赖 ffmpeg）
  try {
    $tcp = Test-NetConnection -ComputerName $Script:UseIp -Port $RtspPort -WarningAction SilentlyContinue
    if ($tcp -and $tcp.TcpTestSucceeded) { Write-Ok "  RTSP TCP $RtspPort  开放" }
    else { Write-Warn2 "  RTSP TCP $RtspPort  关闭/不可达 -> 视频预览会一直黑屏"; $netOk = $false }
  } catch { Write-Warn2 "  RTSP TCP $RtspPort  检测失败: $($_.Exception.Message)"; $netOk = $false }

  if (-not $netOk) {
    Write-Warn2 "  主机网卡必须和吊舱在同一网段。示例："
    Write-Warn2 "    netsh interface ip set address `"以太网`" static 192.168.124.164 255.255.255.0"
    Write-Warn2 "  或者用设备真实地址启动:  .\start-win.ps1 -GimbalIp <地址>"
  }

  # 本地端口可用性
  if (Test-PortInUse "udp" $Script:UseLocalPort) {
    $h = Get-PortHolder "udp" $Script:UseLocalPort
    Write-Warn2 "  UDP $($Script:UseLocalPort) 仍被占用$(if ($h) { "，占用进程: $h" })"
    Write-Warn2 "  服务会退到随机本地端口，导致收不到吊舱回包。"
  } else { Write-Ok "  UDP $($Script:UseLocalPort) 空闲（本地接收）" }

  if (Test-PortInUse "tcp" $Script:UsePort) {
    $h = Get-PortHolder "tcp" $Script:UsePort
    Write-Warn2 "  TCP $($Script:UsePort) 仍被占用$(if ($h) { "，占用进程: $h" }) —— 第 4 步会释放"
  } else { Write-Ok "  TCP $($Script:UsePort) 空闲（Web 界面）" }

  # 防火墙
  try {
    $prof = Get-NetFirewallProfile -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq "True" }
    if ($prof) {
      Write-Warn2 "  防火墙已启用: $(($prof | ForEach-Object { $_.Name }) -join ', ') —— 若需局域网访问请放行入站 TCP $($Script:UsePort)"
    } else { Write-Info "  防火墙: 所有配置文件均未启用" }
  } catch {}
}

# ========================================================== 4. 清理旧实例
function Stop-ProcessByIdSafe([int]$ProcessId, [string]$Reason) {
  if ($ProcessId -le 0 -or $ProcessId -eq $PID) { return }
  try {
    $proc = Get-Process -Id $ProcessId -ErrorAction Stop
    Write-Info "  停止 PID $ProcessId（$($proc.ProcessName)）- $Reason"
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
  } catch {
    Write-Warn2 "  无法停止 PID ${ProcessId}: $($_.Exception.Message)"
  }
}

function Cleanup-Old([int]$WebPort, [int]$UdpPort) {
  Write-Title "4/5 重启清理"

  if (Test-Path $PidFile) {
    $oldPid = 0
    if ([int]::TryParse((Get-Content $PidFile -Raw).Trim(), [ref]$oldPid)) {
      try {
        if (Get-Process -Id $oldPid -ErrorAction Stop) { Stop-ProcessByIdSafe $oldPid "上一个测试进程" }
      } catch {}
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }

  $pids = New-Object System.Collections.Generic.HashSet[int]
  try {
    Get-NetTCPConnection -LocalPort $WebPort -ErrorAction SilentlyContinue |
      Where-Object { $_.OwningProcess -and $_.OwningProcess -ne 0 } |
      ForEach-Object { [void]$pids.Add([int]$_.OwningProcess) }
  } catch {}
  try {
    Get-NetUDPEndpoint -LocalPort $UdpPort -ErrorAction SilentlyContinue |
      Where-Object { $_.OwningProcess -and $_.OwningProcess -ne 0 } |
      ForEach-Object { [void]$pids.Add([int]$_.OwningProcess) }
  } catch {}
  try {
    $escapedRoot = [regex]::Escape($Root)
    Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match $escapedRoot -or $_.CommandLine -match "src\\server\.js" } |
      ForEach-Object { [void]$pids.Add([int]$_.ProcessId) }
    Get-CimInstance Win32_Process -Filter "name='python.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match "python_sdk_bridge\.py" } |
      ForEach-Object { [void]$pids.Add([int]$_.ProcessId) }
  } catch { Write-Warn2 "  进程命令行查询不可用；改用按端口清理" }

  if ($NoKill) {
    if ($pids.Count -gt 0) { Write-Warn2 "  已指定 -NoKill：保留 $($pids.Count) 个进程继续运行" }
  } else {
    foreach ($id in $pids) { Stop-ProcessByIdSafe -ProcessId $id -Reason "重启清理" }
  }
  Start-Sleep -Milliseconds 500
  Write-Info "  完成"
}

# ====================================================== 5. 启动 + 健康检查
function Show-Health([int]$WebPort) {
  Write-Title "启动后健康检查"
  try {
    $s = Invoke-RestMethod -Uri "http://127.0.0.1:$WebPort/api/status" -TimeoutSec 5 -ErrorAction Stop
  } catch {
    Write-Warn2 "  读取 /api/status 失败: $($_.Exception.Message)"
    return
  }
  $cfg = $s.config
  $la = $s.udpLocalAddress
  $c = $s.counters
  $py = $s.pythonSdk
  Write-Info ("  {0,-14}{1}" -f "设备", "$($cfg.deviceIp)  控制 $($cfg.controlPort)  sdk $($cfg.sdkTargetPort)")
  Write-Info ("  {0,-14}{1}" -f "udp 绑定", "$($la.address):$($la.port)  （期望 $($cfg.localPort)）")
  Write-Info ("  {0,-14}{1}" -f "ffmpeg", $(if ($s.ffmpegAvailable) { "可用" } else { "缺失 -> 无视频预览" }))
  Write-Info ("  {0,-14}{1}" -f "python sdk", $(if ($py.running) { "运行中" } else { "未运行  lastError: $($py.lastError)" }))
  Write-Info ("  {0,-14}{1}" -f "数据包", "TX $($c.txPackets)  RX $($c.rxPackets)  parseErrors $($c.parseErrors)")
  Write-Info ("  {0,-14}{1}" -f "rtsp", $s.rtsp.visible)
  foreach ($p in $s.mjpeg.PSObject.Properties) {
    if ($p.Value.lastError) { Write-Info ("  {0,-14}{1}" -f "mjpeg $($p.Name)", $p.Value.lastError.Substring(0, [Math]::Min(110, $p.Value.lastError.Length))) }
  }
  Write-Host ""
  if ($c.rxPackets -eq 0) {
    Write-Warn2 "  [!] RX = 0：吊舱没有回包。"
    Write-Warn2 "      请检查网段/网卡、设备 IP，以及 UDP $($cfg.localPort) 是否被别的进程占用。"
  } else {
    Write-Ok "  [ok] 吊舱回包正常 —— 控制链路是通的。"
  }
  if ($la.port -and $cfg.localPort -and ($la.port -ne $cfg.localPort)) {
    Write-Warn2 "  [!] 绑定到了随机本地端口：发到 $($cfg.localPort) 的回包会丢失。"
  }
  if (-not $s.ffmpegAvailable) {
    Write-Warn2 "  [!] ffmpeg 缺失：装好后才有视频预览 / 拍照 / 录像。"
  }
}

function Start-Server {
  Write-Title "5/5 启动服务"

  foreach ($d in @("logs", "photos", "recordings", "reports")) {
    $p = Join-Path $Root $d
    if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
  }

  $env:PORT = "$($Script:UsePort)"
  $env:GIMBAL_IP = $Script:UseIp
  $env:GIMBAL_PORT = "$ControlPort"
  $env:GIMBAL_LOCAL_PORT = "$($Script:UseLocalPort)"
  if ($Script:FfmpegBin) { $env:FFMPEG_PATH = $Script:FfmpegBin }

  Write-Info "  Web 界面    : http://127.0.0.1:$($Script:UsePort)"
  Write-Info "  吊舱        : $($Script:UseIp)   控制 UDP $ControlPort / SDK 14550   本地接收 UDP $($Script:UseLocalPort)"
  Write-Info "  日志文件    : $(Join-Path $Root "logs\$(Get-Date -Format yyyy-MM-dd).log")"
  Write-Info "  本次取值已存为下次默认: $ConfFile"
  Write-Info "  改 IP 不用重启：Web 界面 -> 设置抽屉 -> 设备 IP -> 重连"
  Write-Host ""

  $proc = Start-Process -FilePath "node" -ArgumentList ".\src\server.js" -WorkingDirectory $Root -NoNewWindow -PassThru
  Set-Content -Path $PidFile -Value $proc.Id -Encoding ASCII

  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    if ($proc.HasExited) { break }
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:$($Script:UsePort)/api/version" -TimeoutSec 1 -ErrorAction Stop | Out-Null
      $ready = $true; break
    } catch { Start-Sleep -Milliseconds 500 }
  }

  if ($proc.HasExited) {
    Write-Err2 "  服务进程在启动阶段就退出了（代码 $($proc.ExitCode)）—— 详见 logs\"
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit 1
  }
  if (-not $ready) { Write-Warn2 "  服务 20 秒内没有响应端口 $($Script:UsePort)（进程仍在运行，pid $($proc.Id)）" }

  if (-not $NoConnect) {
    try {
      $body = @{ deviceIp = $Script:UseIp; controlPort = $ControlPort; localPort = $Script:UseLocalPort } | ConvertTo-Json -Compress
      Invoke-RestMethod -Uri "http://127.0.0.1:$($Script:UsePort)/api/connect" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 8 -ErrorAction Stop | Out-Null
    } catch { Write-Warn2 "  自动连接请求失败: $($_.Exception.Message)" }
    Start-Sleep -Milliseconds 1500
    Show-Health $Script:UsePort
  }

  Write-Host ""
  Write-Info "服务运行中（pid $($proc.Id)）。按 Ctrl+C 停止。"
  try {
    Wait-Process -Id $proc.Id -ErrorAction SilentlyContinue
  } finally {
    try { if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } } catch {}
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }
}

# =================================================================== 主流程
Write-Host "=============================================================="
Write-Host " HY-DZ230F 吊舱 Web 测试工具 - Windows"
Write-Host "=============================================================="

if ($env:SKIP_CHECKS -ne "1") {
  if (-not (Check-Deps)) {
    Write-Host ""
    Write-Err2 "启动中止：依赖不完整。"
    exit 1
  }
} else {
  Write-Warn2 "SKIP_CHECKS=1 -> 跳过依赖检查"
}

Resolve-Settings

if ($env:SKIP_CHECKS -ne "1") { Check-Network }

if ($CheckOnly) {
  Write-Title "体检模式"
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$($Script:UsePort)/api/version" -TimeoutSec 2 -ErrorAction Stop | Out-Null
    Write-Info "  端口 $($Script:UsePort) 上已有一个测试实例在运行"
    Show-Health $Script:UsePort
  } catch {
    Write-Info "  端口 $($Script:UsePort) 上没有运行中的测试实例（无可查询对象）"
  }
  $log = Join-Path $Root "logs\$(Get-Date -Format yyyy-MM-dd).log"
  if (Test-Path $log) {
    Write-Title "最近的错误（$log）"
    Get-Content $log | Select-String -Pattern '"level":"(error|warn)"' | Select-Object -Last 15 | ForEach-Object { Write-Info "  $_" }
  }
  Write-Host ""
  Write-Ok "体检完成。启动命令: .\start-win.ps1"
  exit 0
}

if (-not $StartOnly) { Cleanup-Old $Script:UsePort $Script:UseLocalPort }
Start-Server
