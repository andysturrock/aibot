import json
import logging
import sys
from datetime import datetime


class GCPJSONFormatter(logging.Formatter):
    """
    Formatter that outputs JSON in a format that GCP Cloud Logging can parse.
    Specifically handles multi-line tracebacks and 'extra' fields.
    """

    # Standard LogRecord attributes to exclude from extra
    RESERVED_ATTRS = {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "module",
        "msecs",
        "message",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "thread",
        "threadName",
    }

    def format(self, record):
        # Map Python logging levels to GCP severity levels
        severity_map = {
            logging.DEBUG: "DEBUG",
            logging.INFO: "INFO",
            logging.WARNING: "WARNING",
            logging.ERROR: "ERROR",
            logging.CRITICAL: "CRITICAL",
        }

        # Base log record
        log_record = {
            "severity": severity_map.get(record.levelno, "DEFAULT"),
            "message": record.getMessage(),
            "timestamp": datetime.fromtimestamp(record.created).isoformat() + "Z",
            "logging.googleapis.com/sourceLocation": {
                "file": record.pathname,
                "line": record.lineno,
                "function": record.funcName,
            },
        }

        # Add trace/span if available (for log correlation)
        # Not implemented here but can be added via OpenTelemetry middleware

        # Handle exception info: Use 'stack_trace' so GCP captures it as one entry
        if record.exc_info:
            log_record["stack_trace"] = self.formatException(record.exc_info)

        # Handle 'extra' fields by including everything not in RESERVED_ATTRS
        extra = {
            k: v
            for k, v in record.__dict__.items()
            if k not in self.RESERVED_ATTRS and not k.startswith("_")
        }
        if extra:
            log_record.update(extra)

        return json.dumps(log_record)


class SilenceGenAIWarningFilter(logging.Filter):
    """
    Selective filter to silence the specific 'non-text parts' warning from GenAI SDK
    while leaving other warnings enabled.
    """

    def filter(self, record):
        if "non-text parts in the response" in record.getMessage():
            return False
        return True


def setup_logging(level=logging.INFO):
    """
    Configures the root logger to use the GCPJSONFormatter and output to stdout.
    This is the standard entry point for all services.
    """
    # Use stdout for all logs to ensure Cloud Run captures them
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(GCPJSONFormatter())
    # Apply selective silence filter
    handler.addFilter(SilenceGenAIWarningFilter())

    root_logger = logging.getLogger()
    # Remove existing handlers to avoid duplicate logs (especially from FastAPI/Uvicorn)
    for h in root_logger.handlers[:]:
        root_logger.removeHandler(h)

    root_logger.addHandler(handler)
    root_logger.setLevel(level)

    # Specific tweaks for Uvicorn/FastAPI to ensure they use our formatter
    for logger_name in ["uvicorn", "uvicorn.error", "uvicorn.access", "fastapi"]:
        lgr = logging.getLogger(logger_name)
        lgr.handlers = [handler]
        lgr.propagate = False

    # Ensure GenAI loggers respect the requested log level
    logging.getLogger("google.genai").setLevel(level)
    logging.getLogger("google.generativeai").setLevel(level)
