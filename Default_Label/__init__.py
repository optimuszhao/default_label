from __future__ import annotations

import os
from typing import Any


__all__ = ["LLMClient"]


# 这个文件是算法包对外的 SDK 适配层。
# 算法包内部只使用 LLMClient，具体底层是在线飞轮 naie SDK 还是离线飞轮 flywheel SDK，
# 都在这个文件里自动判断和统一封装。


# 先声明全局变量，下面的 try import 会根据当前环境给这些变量赋值。
# SDK_NAME: 当前命中的 SDK 类型，取值为 naie 或 fly。
# _logger: 当前环境的日志对象或日志函数。
# _http_client_class: 在线飞轮 naie 的 HttpClient 类。
# _chat_func: 离线飞轮 flywheel 的 chat 函数。
SDK_NAME = ""
_logger: Any = None
_http_client_class: Any = None
_chat_func: Any = None
_RUNTIME_INFO: dict[str, str] = {}
_IMPORT_ERROR_MESSAGE = ""


# 第一优先级：尝试导入在线飞轮 naie SDK。
# 在线飞轮日志用法：
#   logger.info("message")
# 在线飞轮大模型 HTTP 调用用法：
#   http_client.post(url="...", body=body_dict)
try:
    from naie.http import HttpClient as _http_client_class
    from naie.log import logger as _logger

    SDK_NAME = "naie"
    _RUNTIME_INFO = {
        "sdk_name": "naie",
        "log": "naie.log.logger.info(message)",
        "llm_client": "naie.http.HttpClient.post(url, body)",
    }
except ImportError as naie_error:
    # 第二优先级：naie 导入失败后，尝试导入离线飞轮 flywheel SDK。
    # 离线飞轮日志用法：
    #   log("info", "message")
    # 离线飞轮大模型调用用法：
    #   chat(llm_dict, prompt)
    try:
        from flywheel.llm.completion import chat as _chat_func
        from flywheel.logger import log as _logger

        SDK_NAME = "fly"
        _RUNTIME_INFO = {
            "sdk_name": "fly",
            "log": "flywheel.logger.log(level, message)",
            "llm_client": "flywheel.llm.completion.chat(llm_dict, prompt)",
        }
    except ImportError as fly_error:
        # 两套 SDK 都导入失败时，先保存完整错误信息。
        # LLMClient 初始化时会抛出这个错误，方便从日志里定位当前环境缺少哪个包。
        _IMPORT_ERROR_MESSAGE = (
            "failed to import runtime SDK. "
            f"naie error: {naie_error}; fly error: {fly_error}"
        )


class LLMClient:
    """统一的大模型客户端。

    算法包内部推荐只使用这个类：

        client = LLMClient()
        client.log("info", "start")
        result = client.llm_client("prompt")

    这样业务代码无需关心当前环境使用 naie SDK 还是 flywheel SDK。
    """

    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        url: str | None = None,
    ) -> None:
        # 初始化时先确认已经命中一种 SDK 环境。
        # 这里失败说明当前 Python 虚拟环境里缺少 naie 和 flywheel 两套依赖。
        if not SDK_NAME:
            raise RuntimeError(_IMPORT_ERROR_MESSAGE)

        # 这些配置优先使用构造参数。
        # 构造参数为空时，从环境变量读取。
        # 环境变量也为空时，使用本地 mock 默认值，方便演示代码直接跑通。
        self.model = model or os.getenv("LLM_MODEL", "default-label-mock-model")
        self.api_key = api_key or os.getenv("LLM_API_KEY", "mock-api-key")
        self.base_url = base_url or os.getenv("LLM_BASE_URL", "http://mock-llm.local")
        self.url = url or os.getenv("LLM_URL", f"{self.base_url}/v1/llm/generate")

        # sdk_name 用来记录当前命中的环境。
        # main.py 会把它写入 result.json，方便本地验证。
        self.sdk_name = SDK_NAME

        # 离线 flywheel 的 chat 第一个参数要求是字典。
        # 字典里包含 model、api_key、base_url。
        self.llm_dict = {
            "model": self.model,
            "api_key": self.api_key,
            "base_url": self.base_url,
        }

        # 在线 naie 需要创建 HttpClient 实例。
        # 离线 flywheel 直接调用 chat 函数，所以这里保持 None。
        self.http_client = self._create_http_client()

        self.log(
            "info",
            f"LLMClient initialized, runtime={self.sdk_name}, model={self.model}",
        )

    def log(self, level: str, message: str) -> None:
        """统一日志入口。

        在线 naie 底层调用 logger.info(message)。
        离线 flywheel 底层调用 log(level, message)。
        """

        if self.sdk_name == "naie":
            # 当前确认在线飞轮日志格式是 logger.info("message")。
            if level.lower() == "info":
                _logger.info(message)
                return

            # logger 如果支持同名级别方法，比如 warning/error，就优先调用。
            log_func = getattr(_logger, level.lower(), None)
            if callable(log_func):
                log_func(message)
                return

            _logger.info(f"[{level}] {message}")
            return

        # 当前确认离线飞轮日志格式是 log("info", "message")。
        _logger(level, message)

    def llm_client(self, prompt: str) -> dict[str, Any]:
        """统一大模型调用入口。

        在线 naie 底层调用 http_client.post(url=url, body=body_dict)。
        离线 flywheel 底层调用 chat(llm_dict, prompt)。
        """

        self.log("info", f"calling LLM, prompt_length={len(prompt)}")

        if self.sdk_name == "naie":
            raw_response = self._call_naie(prompt)
        else:
            raw_response = self._call_fly(prompt)

        result = self._normalize_response(prompt, raw_response)
        self.log("info", "LLM call completed")
        return result

    def call_llm(self, prompt: str) -> dict[str, Any]:
        """兼容旧调用名。

        main.py 当前使用 call_llm。
        后续业务代码也可以直接使用 llm_client。
        """

        return self.llm_client(prompt)

    def get_runtime_info(self) -> dict[str, str]:
        """返回当前命中的 SDK 信息，方便写入 result.json 做验证。"""

        return dict(_RUNTIME_INFO)

    def _create_http_client(self) -> Any:
        # 在线 naie 使用 HttpClient。
        # 离线 flywheel 使用 chat 函数。
        if self.sdk_name == "naie":
            return _http_client_class()

        return None

    def _call_naie(self, prompt: str) -> Any:
        # 在线飞轮 body_dict。
        # 这里把 prompt 包进 messages，真实项目可以按接口要求调整 body 结构。
        body_dict = {
            "model": self.model,
            "messages": [
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
        }

        return self.http_client.post(
            url=self.url,
            body=body_dict,
        )

    def _call_fly(self, prompt: str) -> Any:
        # 离线飞轮 chat 的调用格式由 SDK 固定：
        # chat(llm_dict, prompt)
        return _chat_func(self.llm_dict, prompt)

    def _normalize_response(self, prompt: str, raw_response: Any) -> dict[str, Any]:
        # 统一返回结构。
        # 下游代码只读取 provider/model/prompt/output/raw_response 这些稳定字段。
        return {
            "provider": self.sdk_name,
            "model": self.model,
            "prompt": prompt,
            "output": self._extract_output(raw_response),
            "raw_response": raw_response,
        }

    def _extract_output(self, raw_response: Any) -> str:
        # mock SDK 返回 dict。
        # 真实 SDK 可能返回对象或字符串，所以这里做一个统一提取。
        if isinstance(raw_response, dict):
            for key in ("output", "content", "text", "answer"):
                value = raw_response.get(key)
                if value is not None:
                    return str(value)
            return str(raw_response)

        for attr in ("output", "content", "text", "answer"):
            value = getattr(raw_response, attr, None)
            if value is not None:
                return str(value)

        return str(raw_response)
