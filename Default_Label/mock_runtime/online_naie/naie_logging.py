from __future__ import annotations


class NaieLogger:
    """在线飞轮 naie 日志 SDK 的 mock。"""

    def __init__(self, name: str) -> None:
        self.name = name

    def info(self, message: str) -> None:
        print(f"[naie_logging:{self.name}] {message}")


def get_logger(name: str) -> NaieLogger:
    return NaieLogger(name)
