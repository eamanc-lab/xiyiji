# -*- coding: utf-8 -*-

import os
import sys
from loguru import logger

logger.remove()
use_queue_logging = os.environ.get("XIYIJI_LOGURU_ENQUEUE", "0").strip() == "1"

custom_format = "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | <level>{level: <8}</level> - <level>{message}</level>"

logger.add(
    sink=sys.stderr,
    format=custom_format,
    level="DEBUG",
    colorize=True,
    enqueue=use_queue_logging
)

script_path = os.path.split(os.path.realpath(sys.argv[0]))[0]

logger.add(
    f"{script_path}/logs/streamget.log",
    level="DEBUG",
    format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | {name}:{function}:{line} - {message}",
    filter=lambda i: i["level"].name != "INFO",
    serialize=False,
    enqueue=use_queue_logging,
    retention=1,
    rotation="300 KB",
    encoding='utf-8'
)

logger.add(
    f"{script_path}/logs/PlayURL.log",
    level="INFO",
    format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {message}",
    filter=lambda i: i["level"].name == "INFO",
    serialize=False,
    enqueue=use_queue_logging,
    retention=1,
    rotation="300 KB",
    encoding='utf-8'
)
