from __future__ import annotations

from typing import Any


# 这个文件放在算法包最外层，负责做 SDK 适配。
# main.py、default_label_util.py 等业务代码统一使用这里的 LLMClient。
# 在线飞轮环境和离线飞轮环境的日志、大模型调用依赖差异，都收敛在这里。


# 先声明运行时变量，下面的 try 会给它们赋值。
# SDK_NAME 表示当前命中的环境类型。
# _logger 保存当前环境的日志对象。
# _http_client_class 保存在线飞轮里的 HttpClient 类。
# _chat_func 保存离线飞轮里的 chat 函数。
SDK_NAME = ""
_logger: Any = None
_http_client_class: Any = None
_chat_func: Any = None
_RUNTIME_INFO: dict[str, str] = {}
_IMPORT_ERROR_MESSAGE = ""


# 第一优先级：尝试导入在线飞轮环境里的 naie 依赖。
# 在线飞轮当前使用：
#   from naie.http import HttpClient
#   from naie.log import logger
try:
    from naie.http import HttpClient as _http_client_class
    from naie.log import logger as _logger

    SDK_NAME = "naie"
    _RUNTIME_INFO = {
        "sdk_name": "naie",
        "logger": "naie.log.logger",
        "llm_client": "naie.http.HttpClient",
    }
except ImportError as naie_error:
    # 第二优先级：naie 导入失败后，尝试导入离线飞轮环境里的 fly 依赖。
    # 离线飞轮当前使用：
    #   from flywheel.logger import log
    #   from flywheel.llm.completion import chat
    try:
        from flywheel.llm.completion import chat as _chat_func
        from flywheel.logger import log as _logger

        SDK_NAME = "fly"
        _RUNTIME_INFO = {
            "sdk_name": "fly",
            "logger": "flywheel.logger.log",
            "llm_client": "flywheel.llm.completion.chat",
        }
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
    这个类内部根据 SDK_NAME 选择 naie 或 fly 的底层实现。
    """

    def __init__(self, model_name: str = "default-label-mock-model") -> None:
        # 初始化时先确认已经命中一种运行环境。
        # 这里失败说明当前环境缺少 naie 和 fly 两套 SDK 依赖。
        if not SDK_NAME:
            raise RuntimeError(_IMPORT_ERROR_MESSAGE)

        # 保存模型名，真实项目里可以换成部署在飞轮上的模型服务名。
        self.model_name = model_name
        self.sdk_name = SDK_NAME

        # logger 来自当前飞轮环境。
        # 在线环境是 naie.log.logger，离线环境是 flywheel.logger.log。
        self.logger = _logger

        # 只有在线 naie 分支需要创建 HttpClient。
        # 离线 fly 分支直接调用 chat 函数，所以这里保存为 None。
        self.http_client = self._create_http_client()

        self._log_info(
            f"LLMClient initialized, runtime={self.sdk_name}, model={self.model_name}"
        )

    def call_llm(self, prompt: str) -> dict[str, Any]:
        """调用大模型，并返回统一结构。

        naie 和 fly 的底层返回结构可以不同。
        这里统一整理成 provider/model/prompt/output/raw_response。
        """

        self._log_info(f"calling LLM, prompt_length={len(prompt)}")

        # 这里按当前命中的 SDK 分支调用底层能力。
        # main.py 和其他业务代码只看到 call_llm 这个统一方法。
        if self.sdk_name == "naie":
            raw_response = self._call_naie(prompt)
        else:
            raw_response = self._call_fly(prompt)

        result = self._normalize_response(prompt, raw_response)
        self._log_info("LLM call completed")
        return result

    def get_runtime_info(self) -> dict[str, str]:
        """返回当前命中的 SDK 信息，方便写入 result.json 做验证。"""

        return dict(_RUNTIME_INFO)

    def _create_http_client(self) -> Any:
        # 在线 naie 使用 HttpClient 访问大模型服务。
        # 离线 fly 使用 chat 函数访问大模型服务。
        if self.sdk_name == "naie":
            return _http_client_class()
        return None

    def _log_info(self, message: str) -> None:
        # 在线 naie 的 logger 和离线 fly 的 log 形态可能不同。
        # 支持 logger.info(message) 和 log(message) 两种常见写法。
        if hasattr(self.logger, "info"):
            self.logger.info(message)
            return

        if callable(self.logger):
            self.logger(message)
            return

        print(f"[DefaultLabel] {message}")

    def _call_naie(self, prompt: str) -> dict[str, Any]:
        # 在线飞轮分支。
        # payload 是发给 naie HttpClient 的请求体。
        # 真实项目里可以在这里补充 temperature、max_tokens、tenant_id 等参数。
        payload = {
            "model": self.model_name,
            "messages": [
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
        }

        # 这个 mock HttpClient 提供 post_json 方法。
        # 真实 HttpClient 方法名如果不同，只需要改这一处，业务代码继续用 call_llm。
        return self.http_client.post_json(
            path="/v1/llm/generate",
            payload=payload,
        )

    def _call_fly(self, prompt: str) -> dict[str, Any]:
        # 离线飞轮分支。
        # flywheel.llm.completion.chat 是直接的大模型调用函数。
        messages = [
            {
                "role": "user",
                "content": prompt,
            }
        ]

        return _chat_func(
            model=self.model_name,
            messages=messages,
        )

    def _normalize_response(
        self,
        prompt: str,
        raw_response: dict[str, Any],
    ) -> dict[str, Any]:
        # 统一返回结构。
        # 下游代码只读取 output/provider/model 这些稳定字段。
        output = self._extract_output(raw_response)
        return {
            "provider": self.sdk_name,
            "model": self.model_name,
            "prompt": prompt,
            "output": output,
            "raw_response": raw_response,
        }

    def _extract_output(self, raw_response: Any) -> str:
        # mock SDK 返回 dict。
        # 真实 SDK 可能返回对象或字符串，所以这里做一个小的统一处理。
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
