from __future__ import annotations


class FlyLogger:
    """离线飞轮 fly 日志 SDK 的 mock。"""

    def __init__(self, name: str) -> None:
        self.name = name

    def info(self, message: str) -> None:
        print(f"[fly_logging:{self.name}] {message}")


def get_logger(name: str) -> FlyLogger:
    return FlyLogger(name)
