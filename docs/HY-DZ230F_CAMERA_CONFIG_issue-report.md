# HY-DZ230F 相机参数配置 (HY_CAMERA_CONFIG) 通信问题报告

**设备型号**: HY-DZ230F  
**固件版本**: (请厂家确认)  
**接口文档**: 汇云机器人MavLink自定义消息接口文档 V1.0.7  
**测试日期**: 2026-08-14  
**测试工具**: 独立 UDP 测试程序 (Python, 纯标准库, MAVLink2 协议)  

---

## 一、问题概述

通过 MAVLink2 UDP 协议向设备发送 `HY_CAMERA_CONFIG` (ID: 11060) 指令后，**设备完全不响应任何相机参数配置命令**。设备持续上报的 `HY_CAMERA_REPORT` (ID: 11061) 状态值不发生任何变化。

与此同时，`HY_GIMBAL_CONTROL` (ID: 11050) 和 `HY_GIMBAL_ACTIVE_MODE` (ID: 11049) 指令可以正常工作，排除了 UDP 通道、MAVLink2 帧格式和基本连接的问题。

---

## 二、测试环境与条件

- **设备 IP**: 192.168.144.18
- **控制端口**: UDP 3000 (收发同端口)
- **MAVLink2 参数**: sys_id=1, comp_id=25 (0x19)
- **发送方式**: 每条指令连发 5 次, 间隔 40ms (克服 UDP 丢包)
- **设备已重启**: 测试前对设备进行了断电重启, 确保初始状态干净

---

## 三、测试结果

### 3.1 可以正常工作的指令

| 指令 | 消息 ID | 结果 |
|------|---------|------|
| HY_GIMBAL_CONTROL (角度模式) | 11050 | 正常, 云台按指定角度运动 |
| HY_GIMBAL_CONTROL (速率模式) | 11050 | 正常, 云台按指定速率运动 |
| HY_GIMBAL_ACTIVE_MODE | 11049 | 正常, 模式切换生效 |
| HY_REQUEST (CONNECT) | 11047 | 正常, 设备建立连接并开始上报 |

### 3.2 无法工作的指令

以下指令发送后, CAMERA_REPORT 状态值 **完全没有变化**:

| config_type | 功能 | 测试的 cmd_value | 结果 |
|-------------|------|------------------|------|
| 4 | 镜像翻转 (CAMERA_IMAGE_FLIP) | 0, 1, 2 (以及 0-255 全扫描) | 无变化 |
| 5 | OSD 显示 (CAMERA_OSD_DISPLAY) | 1, 2 | 无变化 |
| 14 | 电子防抖 (CAMERA_IAMGE_STABILIZATION) | 1, 2 (以及 0-255 全扫描) | 无变化 |
| 15 | 透雾/除雾 (CAMERA_SET_DEFOG) | 1, 2 | 无变化 |
| 2 | 拍照 (CAMERA_TAKE_PHOTO) | 1 | 无变化 |

**valuescan 测试**: 对 config_type=4 (flip) 和 config_type=14 (stabilizer) 分别扫描了 0-255 所有 cmd_value, 每个值连发 3 次并等待 300ms, **没有一个 value 能改变 CAMERA_REPORT 的任何一位**。

---

## 四、发现的具体问题

### 4.1 [严重] CRC_EXTRA 值与文档不一致

通过从设备回包中逆向计算 (brute-force 0-255), 发现设备实际使用的 CRC_EXTRA 与文档隐含的值不匹配:

| 消息 | 消息 ID | 文档预期 CRC_EXTRA | 设备实际 CRC_EXTRA | 来源 |
|------|---------|-------------------|-------------------|------|
| HY_GIMBAL_CONTROL | 11050 | 148 | 148 | PDF 示例包验证一致 |
| HY_GIMBAL_REPORT | 11052 | 68 | **61** | 设备回包 brute-force |
| HY_CAMERA_REPORT | 11061 | 84 | **41** | 设备回包 brute-force |
| HY_CAMERA_CONFIG | 11060 | 36 | **未知** | 无法确定 (见下文) |

**问题说明**:
- HY_GIMBAL_REPORT 和 HY_CAMERA_REPORT 的 CRC_EXTRA 与标准 MAVLink CRC_EXTRA 生成算法计算出的值不同
- 由于设备会校验 CRC, CRC_EXTRA 不匹配会导致设备直接丢弃收到的包, 不做任何处理
- HY_CAMERA_CONFIG 的正确 CRC_EXTRA 无法通过常规方法确定 (详见 4.2)

### 4.2 [严重] HY_CAMERA_CONFIG 的 CRC_EXTRA 无法确定

我们编写了 crcscan 工具, 方法是: 对 CRC_EXTRA 0-255 每个值, 发送 `type=4 val=1` (镜像翻转), 检查 CAMERA_REPORT 中 image_flip 位是否变化。

扫描结果: **CRC_EXTRA=167 时 image_flip 从 False 变为 True**。

但在后续测试中 (包括设备重启后), 使用 CRC_EXTRA=167 发送任何 CAMERA_CONFIG 指令 (包括 type=4 val=2 翻转回去), 设备均不响应。

因此 CRC_EXTRA=167 可能是 **误报** (image_flip 的变化可能是由其他原因引起的, 而非我们的指令生效)。

**根本问题**: 如果设备对 CAMERA_CONFIG 使用了与文档不同的 CRC_EXTRA, 那么无论我们发送什么指令, 设备都会因 CRC 校验失败而静默丢弃, 且不会有任何错误反馈。

### 4.3 [中等] CAMERA_REPORT 负载长度与文档不符

文档描述 HY_CAMERA_REPORT (ID: 11061) 的负载为:
```
uint32 status_value  (4 字节)
```

但设备实际发送的负载为 **5 字节**:
```
01 00 02 C6 02
```
- 前 4 字节: `01 00 02 C6` = 0xC6020001 (status_value, little-endian)
- 第 5 字节: `02` (文档中未定义)

第 5 字节在所有回包中始终为 `0x02`, 其含义未知。请厂家确认:
- 该字节是否为新增字段?
- 其含义是什么?
- 是否影响 CAMERA_CONFIG 的处理逻辑?

### 4.4 [低] 码率索引超出文档范围

设备重启后 CAMERA_REPORT 的 raw 值为 `0xC6020001`, 其中码率索引 (bits 23-26) = 12。

文档中定义的码率索引范围为 1-11 (1M ~ 6M), **索引 12 未在文档中定义**。

### 4.5 [低] 保留位非零

CAMERA_REPORT 的 bits 29-31 (保留位) = `110` (十进制 6), 文档中应为 0。

---

## 五、测试用的原始数据

### 5.1 发送的 CAMERA_CONFIG 帧 (CRC_EXTRA=167, 重启后测试)

```
镜像翻转-正常 (type=4, val=1):
FD 02 00 00 04 01 19 34 2B 00 04 01 3D 8C

镜像翻转-翻转 (type=4, val=2):
FD 02 00 00 09 01 19 34 2B 00 04 02 87 AB

电子防抖-开 (type=14, val=1):
FD 02 00 00 1D 01 19 34 2B 00 0E 01 E4 32

电子防抖-关 (type=14, val=2):
FD 02 00 00 22 01 19 34 2B 00 0E 02 09 86

OSD-开 (type=5, val=1):
FD 02 00 00 27 01 19 34 2B 00 05 01 DF F7

透雾-关 (type=15, val=2):
FD 02 00 00 2C 01 19 34 2B 00 0F 02 00 07
```

### 5.2 设备回包 (CAMERA_REPORT, 始终不变)

```
payload (5字节): 01 00 02 C6 02
raw uint32: 0xC6020001

位域解析:
  变焦倍数: 1
  拍照: False
  录像: False
  镜像: False
  OSD: False
  防抖: False
  透雾: False
  畸变: False
  数码变焦: False
  识别扫描: False
  跟踪: False
  编码: H.264
  码率索引: 12 (未定义)
  图传分辨率: 480P
  保留位: 6 (应为0)
  第5字节: 0x02 (未定义)
```

### 5.3 可以正常工作的 GIMBAL_CONTROL 帧 (对比)

```
角度模式 P=15 Y=0:
FD 0A 00 00 1D 01 19 2A 2B 00 00 00 70 41 00 00 00 00 02 02 10 F3
→ 设备响应: 云台运动, P 从 15° 变化到 5.46° (向 0° 回中)
```

---

## 六、需要厂家确认的问题

1. **HY_CAMERA_CONFIG (11060) 的正确 CRC_EXTRA 是多少?**
   - 文档中未明确给出 CRC_EXTRA 值
   - 设备是否使用非标准 CRC_EXTRA?
   - 请提供一条可用的 CAMERA_CONFIG 完整帧示例 (含正确 CRC)

2. **CAMERA_REPORT (11061) 的第 5 字节 (0x02) 是什么?**
   - 文档中只定义了 4 字节 (uint32 status_value)
   - 设备实际发送 5 字节

3. **CAMERA_CONFIG 是否需要前置条件?**
   - 是否需要先发送特定的 CONNECT / AUTH 指令?
   - 是否需要特定的 sys_id / comp_id?
   - 是否有指令优先级或互斥限制?

4. **设备固件版本是否与文档 V1.0.7 匹配?**
   - CRC_EXTRA 不一致和负载长度不符, 可能是固件版本差异
   - 请确认设备固件版本号

5. **码率索引 12 和保留位非零是否正常?**
   - 文档中未定义码率索引 12
   - 保留位应为 0 但实际为 6

---

## 七、附录: 测试方法说明

### CRC_EXTRA 逆向方法

MAVLink2 的 CRC 校验范围包含: header (9字节) + payload + CRC_EXTRA (1字节)。

对于收到的回包, 已知 header、payload 和 CRC, 可以遍历 CRC_EXTRA 0-255, 找到使计算 CRC 等于包中 CRC 的值。此方法可 100% 准确地确定设备使用的 CRC_EXTRA。

### 发送验证方法

每条指令连发 5 次 (间隔 40ms), 发送后等待 500ms 读取 CAMERA_REPORT。如果 status_value 的任何一位发生变化, 则判定指令生效。

### valuescan 方法

对指定 config_type, 遍历 cmd_value 0-255, 每个值连发 3 次 (间隔 40ms), 等待 300ms 后检查 CAMERA_REPORT 是否变化。可找出设备实际响应的 cmd_value 范围。
