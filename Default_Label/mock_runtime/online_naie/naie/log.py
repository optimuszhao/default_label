from __future__ import annotations


class NaieLogger:
    """在线飞轮 naie.log.logger 的 mock。"""

    def info(self, message: str) -> None:
        print(f"[naie.log] {message}")


logger = NaieLogger()
