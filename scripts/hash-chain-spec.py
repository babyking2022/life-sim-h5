import hashlib
import json
import struct
from pathlib import Path


class BInt:
    def __init__(self, value: int):
        self.value = value


def u32(value: int) -> bytes:
    return struct.pack(">I", value)


def canon(value) -> bytes:
    if value is None:
        return b"\x00"
    if value is False:
        return b"\x01"
    if value is True:
        return b"\x02"
    if isinstance(value, BInt):
        digits = str(value.value).encode("ascii")
        return b"\x04" + u32(len(digits)) + digits
    if isinstance(value, int):
        return b"\x03" + struct.pack(">q", value)
    if isinstance(value, str):
        data = value.encode("utf-8")
        return b"\x05" + u32(len(data)) + data
    if isinstance(value, list):
        return b"\x07" + u32(len(value)) + b"".join(canon(item) for item in value)
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=lambda key: key.encode("utf-8"))
        return b"\x08" + u32(len(keys)) + b"".join(canon(key) + canon(value[key]) for key in keys)
    raise TypeError(type(value))


version = {
    "engineVersion": "0.1.0",
    "rulesetVersion": "p1b-1",
    "rngSpecVersion": "1.0.0",
    "dataVersion": "2026.10",
    "contentVersion": "hash-vectors",
    "saveFormatVersion": 3,
}
settings = {"contentMode": "standard", "autoChoicePolicy": "stop"}
base_state = {
    "schemaVersion": 1,
    "seed": "P1B-VECTOR",
    "year": 0,
    "stats": {"health": 500, "happiness": 500, "knowledge": 500, "relationships": 500},
    "resourcePppMicro": BInt(0),
    "flags": {},
    "rng": [1, 2, 3, 4],
    "rngDraws": 0,
    "rulesetSettings": settings,
}
state_one = {
    **base_state,
    "year": 1,
    "stats": {"health": 505, "happiness": 500, "knowledge": 500, "relationships": 500},
    "resourcePppMicro": BInt(1000),
}
state_two = {
    **state_one,
    "year": 2,
    "flags": {"vec": "ok"},
}
first_command = {
    "seq": 0,
    "commandId": "vec-1",
    "effectiveYear": 0,
    "auto": False,
    "policyId": None,
    "optionIds": ["o1", "o2"],
    "selectedOptionId": "o1",
    "rngCursor": {"state": [1, 2, 3, 4], "draws": 0},
    "command": {
        "kind": "apply_effects",
        "effects": [
            {"kind": "stat", "stat": "health", "delta": 5},
            {"kind": "money", "deltaPppMicro": "1000"},
        ],
    },
}
second_command = {
    "seq": 1,
    "commandId": "vec-2",
    "effectiveYear": 1,
    "auto": True,
    "policyId": "safe",
    "optionIds": ["o1"],
    "selectedOptionId": "o1",
    "rngCursor": {"state": [1, 2, 3, 4], "draws": 0},
    "command": {
        "kind": "apply_effects",
        "effects": [{"kind": "flag", "key": "vec", "value": "ok"}],
    },
}


def hexsha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


h0_input = b"LIFE1/P1B/H0/v1\x00" + canon({"version": version, "state": base_state})
h0 = hashlib.sha256(h0_input).digest()
h1_input = b"LIFE1/P1B/H/v1\x00" + h0 + canon({"version": version, "state": state_one, "command": first_command})
h1 = hashlib.sha256(h1_input).digest()
h2_input = b"LIFE1/P1B/H/v1\x00" + h1 + canon({"version": version, "state": state_two, "command": second_command})
h2 = hashlib.sha256(h2_input).digest()

out = {
    "generator": "hash-chain-spec-v1",
    "version": version,
    "baseState": {**base_state, "resourcePppMicro": "0"},
    "stateAfterFirst": {**state_one, "resourcePppMicro": "1000"},
    "stateAfterSecond": {**state_two, "resourcePppMicro": "1000"},
    "firstCommand": first_command,
    "secondCommand": second_command,
    "h0InputHex": h0_input.hex(),
    "h0": hexsha(h0_input),
    "h1InputHex": h1_input.hex(),
    "h1": hexsha(h1_input),
    "h2InputHex": h2_input.hex(),
    "h2": hexsha(h2_input),
}
target = Path("packages/engine/test/fixtures/hash-chain-vectors.json")
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
print(f"HASH-VECTORS-WRITTEN {target} h0={out['h0']}")
