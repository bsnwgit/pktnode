"""
Production entrypoint — reads host/port from Settings (config.yaml) at
process start, instead of a fixed --port flag in the systemd unit. This is
what lets Settings → General "Port" actually take effect on restart: saving
just rewrites config.yaml, and the next process start picks it up here.
"""
from __future__ import annotations

import uvicorn

from app.config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        workers=1,
        log_level="info",
        access_log=False,
    )


if __name__ == "__main__":
    main()
