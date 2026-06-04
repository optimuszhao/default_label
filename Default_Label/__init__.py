from __future__ import annotations

from typing import Any


# 这个文件放在算法包最外层，负责做 SDK 适配。
# main.py、default_label_util.py 等业务代码统一使用这里的 LLMClient。
# 在线飞轮环境和离线飞轮环境的 logging/httpclient 依赖差异，都收敛在这里。


# 先声明运行时变量，下面的 try 会给它们赋值。
# SDK_NAME 表示当前命中的环境类型。
# _log_sdk 保存当前环境的日志 SDK 模块。
# _http_sdk 保存当前环境的 HTTP Client SDK 模块。
SDK_NAME = ""
_log_sdk: Any = None
_http_sdk: Any = None
_IMPORT_ERROR_MESSAGE = ""


# 第一优先级：尝试导入在线飞轮环境里的 naie 依赖。
# 这里用两个 mock 包模拟真实环境中的 naie logging 和 naie httpclient。
try:
    import naie_http_client as _http_sdk
    import naie_logging as _log_sdk

    SDK_NAME = "naie"
except ImportError as naie_error:
    # 第二优先级：naie 导入失败后，尝试导入离线飞轮环境里的 fly 依赖。
    # 这一步对应架构师说的 fallback 逻辑。
    try:
        import fly_http_client as _http_sdk
        import fly_logging as _log_sdk

        SDK_NAME = "fly"
    except ImportError as fly_error:
        # 两套环境依赖都导入失败时，先记录错误。
        # LLMClient 初始化时会抛出清晰异常，方便排查当前 Python 环境。
        _IMPORT_ERROR_MESSAGE = (
            "failed to import runtime SDK. "
            f"naie error: {naie_error}; fly error: {fly_error}"
        )


class LLMClient:
    """统一的大模型调用入口。

    算法包内部统一实例化这个类，然后调用 call_llm。
    这个类内部根据 SDK_NAME 选择 naie 或 fly 的 logging/httpclient 实现。
    """

    def __init__(self, model_name: str = "default-label-mock-model") -> None:
        # 初始化时先确认已经命中一种运行环境。
        # 这里失败说明当前环境缺少 naie 和 fly 两套 SDK 依赖。
        if not SDK_NAME:
            raise RuntimeError(_IMPORT_ERROR_MESSAGE)

        # 保存模型名，真实项目里可以换成部署在飞轮上的模型服务名。
        self.model_name = model_name
        self.sdk_name = SDK_NAME

        # logging SDK 和 httpclient SDK 的创建方式由下面两个私有方法统一处理。
        self.logger = self._create_logger()
        self.http_client = self._create_http_client()

        self.logger.info(
            f"LLMClient initialized, runtime={self.sdk_name}, model={self.model_name}"
        )

    def call_llm(self, prompt: str) -> dict[str, Any]:
        """调用大模型，并返回统一结构。

        naie 和 fly 的底层返回结构可以不同。
        这里统一整理成 provider/model/prompt/output/raw_response。
        """

        self.logger.info(f"calling LLM, prompt_length={len(prompt)}")

        # payload 是发给底层 httpclient 的请求体。
        # 真实项目里可以在这里加入 temperature、max_tokens、tenant_id 等参数。
        payload = {
            "model": self.model_name,
            "prompt": prompt,
        }

        # 底层 HTTP Client 只在这一层使用。
        # 业务代码拿到的是下面 normalize 后的统一返回值。
        raw_response = self.http_client.post_json(
            path="/v1/llm/generate",
            payload=payload,
        )

        result = self._normalize_response(prompt, raw_response)
        self.logger.info("LLM call completed")
        return result

    def get_runtime_info(self) -> dict[str, str]:
        """返回当前命中的 SDK 信息，方便写入 result.json 做验证。"""

        return {
            "sdk_name": self.sdk_name,
            "logging_sdk": _log_sdk.__name__,
            "http_client_sdk": _http_sdk.__name__,
        }

    def _create_logger(self) -> Any:
        # 两套 mock logging SDK 都提供 get_logger(name)。
        # 适配层统一调用这个方法，业务代码无需关心具体 SDK 名称。
        return _log_sdk.get_logger("DefaultLabel")

    def _create_http_client(self) -> Any:
        # naie 和 fly 的 HTTP Client 类名不同。
        # 这里根据 SDK_NAME 做一次分流，外部统一拿到 self.http_client。
        if self.sdk_name == "naie":
            return _http_sdk.NaieHttpClient()
        return _http_sdk.FlyHttpClient()

    def _normalize_response(
        self,
        prompt: str,
        raw_response: dict[str, Any],
    ) -> dict[str, Any]:
        # 统一返回结构。
        # 下游代码只读取 output/provider/model 这些稳定字段。
        return {
            "provider": self.sdk_name,
            "model": self.model_name,
            "prompt": prompt,
            "output": str(raw_response.get("output", "")),
            "raw_response": raw_response,
        }
