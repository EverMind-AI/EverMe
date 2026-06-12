"""EverMe HTTP client (stdlib only — no httpx/requests).

Mirrors the invariants of @everme/agent-sdk client.js:
  - single request() funnel, Bearer auth from cfg["agent_token"]
  - envelope {error, requestId, status, result}: status==0 -> result
  - 30s timeout; only GET/HEAD retried once (writes never retried)
  - redact_error() scrubs evt_/emk_ tokens and S3 signing params
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlencode

TIMEOUT_S = 30.0
RETRY_SLEEP_S = 0.15

_evt_re = re.compile(r"evt_[A-Za-z0-9]{32,}")
_emk_re = re.compile(r"emk_[A-Za-z0-9]{32,}")
_s3_re = re.compile(
    r"(X-Amz-Signature|X-Amz-Security-Token|X-Amz-Credential)=[^&\"\s]+",
    re.IGNORECASE,
)


def redact_error(msg: Any) -> str:
    text = msg.message if isinstance(msg, Exception) and hasattr(msg, "message") else str(msg)
    text = _evt_re.sub(lambda m: m.group(0)[:8] + "_REDACTED", text)
    text = _emk_re.sub(lambda m: m.group(0)[:8] + "_REDACTED", text)
    text = _s3_re.sub(lambda m: m.group(1) + "=[REDACTED]", text)
    return text


class EvermeError(Exception):
    def __init__(self, message, status=0, code=0, request_id="", error_type="upstream"):
        safe = redact_error(message)
        super().__init__(safe)
        self.message = safe
        self.http_status = status
        self.code = code
        self.request_id = request_id
        self.type = error_type


def _default_opener(req, timeout):
    return urllib.request.urlopen(req, timeout=timeout)


class EverMeClient:
    def __init__(self, cfg: Dict[str, str], opener: Optional[Callable] = None, version: str = "0.1.0"):
        self._base = cfg["api_base"]
        self._token = cfg.get("agent_token", "")
        self._agent_id = cfg.get("agent_id", "")
        self._version = version
        self._opener = opener or _default_opener

    def _headers(self) -> Dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {self._token}",
            "User-Agent": f"everme-hermes-provider/{self._version} (agentId={self._agent_id})",
        }

    def request(self, method: str, path: str, body: Optional[dict] = None,
                *, timeout: float = TIMEOUT_S, query: Optional[dict] = None) -> Any:
        url = self._base + path
        if query:
            clean = {k: v for k, v in query.items() if v not in (None, "")}
            if clean:
                url += "?" + urlencode(clean, doseq=True)
        data = None if body is None else json.dumps(body).encode("utf-8")
        method = method.upper()

        def _once():
            req = urllib.request.Request(url, data=data, method=method, headers=self._headers())
            try:
                with self._opener(req, timeout) as resp:
                    raw = resp.read()
                    status = getattr(resp, "status", 200)
            except urllib.error.HTTPError as e:
                raw = e.read()
                status = e.code
            # Other transport exceptions (URLError, socket timeout, OSError)
            # propagate raw so the retry/wrap logic below owns them.
            return self._parse(raw, status)

        try:
            return _once()
        except EvermeError:
            raise  # application error — never retried
        except Exception as e:
            if method in ("GET", "HEAD"):
                time.sleep(RETRY_SLEEP_S)
                try:
                    return _once()
                except EvermeError:
                    raise
                except Exception as e2:
                    raise EvermeError(f"transport error: {e2}", error_type="upstream") from None
            raise EvermeError(f"transport error: {e}", error_type="upstream") from None

    @staticmethod
    def _parse(raw: bytes, http_status: int) -> Any:
        text = raw.decode("utf-8", errors="replace") if raw else ""
        try:
            env = json.loads(text) if text else {}
        except Exception:
            etype = "auth" if http_status in (401, 403) else "upstream"
            raise EvermeError(f"HTTP {http_status} — {text[:200]}", status=http_status, error_type=etype)
        if isinstance(env, dict) and env.get("status") == 0:
            return env.get("result")
        code = int(env.get("status") or 0) if isinstance(env, dict) else 0
        etype = "auth" if 30000 <= code < 30300 and code != 30104 else "upstream"
        raise EvermeError(
            (env.get("error") if isinstance(env, dict) else None) or f"HTTP {http_status}",
            status=http_status, code=code,
            request_id=(env.get("requestId") if isinstance(env, dict) else "") or "",
            error_type=etype,
        )
