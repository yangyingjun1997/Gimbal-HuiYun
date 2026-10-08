#!/usr/bin/env python3
"""Persistent bridge from Node.js JSON lines to the vendor MAVLink SDK."""

import importlib.util
import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SDK_PATH = Path(os.environ.get("HY_GIMBAL_SDK", ROOT / "vendor" / "hy_gimbal.py"))


def load_sdk():
    if not SDK_PATH.exists():
        raise RuntimeError(f"Vendor SDK not found: {SDK_PATH}")
    spec = importlib.util.spec_from_file_location("hy_gimbal_vendor", SDK_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load vendor SDK: {SDK_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SDK = load_sdk()
MAV = SDK.MAVLink(None, srcSystem=1, srcComponent=25)


def integer(fields, name, default=0):
    return int(fields.get(name, default))


def number(fields, name, default=0.0):
    return float(fields.get(name, default))


def fixed_text(value):
    raw = str(value or "").encode("ascii", errors="replace")
    return raw[:15].ljust(16, b"\x00")


def encode_message(message, fields, config):
    MAV.srcSystem = integer(config, "sysId", 1)
    MAV.srcComponent = integer(config, "compId", 25)

    if message == "hy_request":
        return MAV.hy_request_encode(integer(fields, "request"))
    if message == "hy_gimbal_active_mode":
        return MAV.hy_gimbal_active_mode_encode(integer(fields, "gimbal_mode"))
    if message == "hy_gimbal_control":
        return MAV.hy_gimbal_control_encode(
            integer(fields, "pitch_mode"),
            integer(fields, "yaw_mode"),
            number(fields, "pitch_value"),
            number(fields, "yaw_value"),
        )
    if message == "hy_camera_config":
        return MAV.hy_camera_config_encode(
            integer(fields, "config_type"),
            integer(fields, "cmd_value"),
        )
    if message == "command_long":
        return MAV.command_long_encode(
            integer(fields, "target_system", 1),
            integer(fields, "target_component", 100),
            integer(fields, "command", 531),
            integer(fields, "confirmation"),
            number(fields, "param1"),
            number(fields, "param2"),
            number(fields, "param3"),
            number(fields, "param4"),
            number(fields, "param5"),
            number(fields, "param6"),
            number(fields, "param7"),
        )
    if message == "hy_camera_guide_movement":
        return MAV.hy_camera_guide_movement_encode(
            number(fields, "movement_x"), number(fields, "movement_y")
        )
    if message == "hy_ir_temp_region_config":
        return MAV.hy_ir_temp_region_config_encode(
            integer(fields, "enable", 1),
            number(fields, "x"),
            number(fields, "y"),
            number(fields, "width"),
            number(fields, "height"),
        )
    if message == "camera_net_config":
        return MAV.camera_net_config_encode(
            integer(fields, "op_type"),
            fixed_text(fields.get("ip")),
            fixed_text(fields.get("netmask")),
            fixed_text(fields.get("gateway")),
            integer(fields, "apply", 1),
        )
    raise ValueError(f"Unsupported vendor SDK message: {message}")


def response(request_id, **data):
    result = {"id": request_id, "ok": True}
    result.update(data)
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def error(request_id, message):
    response(request_id, ok=False, error=str(message))


def main():
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            config = request.get("config") or {}
            fields = request.get("fields") or {}
            message = encode_message(request["message"], fields, config)
            frame = message.pack(MAV)
            MAV.seq = (MAV.seq + 1) % 256
            ports = [int(p) for p in (config.get("ports") or [3000, 14550])]
            sequence = frame[4] if len(frame) > 4 else None
            response(
                request_id,
                hex=" ".join(f"{byte:02X}" for byte in frame),
                bytes=len(frame),
                ports=ports,
                seq=sequence,
                sdk="hy_gimbal.py",
                sdkPath=str(SDK_PATH),
            )
        except Exception as exc:  # keep the bridge alive for the next UI command
            error(request_id, exc)


if __name__ == "__main__":
    main()
