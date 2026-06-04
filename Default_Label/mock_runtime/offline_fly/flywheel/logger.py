from __future__ import annotations


def log(level: str, message: str) -> None:
    """离线飞轮 flywheel.logger.log 的 mock。"""

    print(f"[flywheel.logger:{level}] {message}")
