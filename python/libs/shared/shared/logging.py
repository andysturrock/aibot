import logging
import json
import sys
from datetime import datetime

class GCPJSONFormatter(logging.Formatter):
    """
    Formatter that outputs JSON in a format that GCP Cloud Logging can parse.
    """
    def format(self, record):
        # Map Python logging levels to GCP severity levels
        # https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#LogSeverity
        severity_map = {
            logging.DEBUG: "DEBUG",
            logging.INFO: "INFO",
            logging.WARNING: "WARNING",
            logging.ERROR: "ERROR",
            logging.CRITICAL: "CRITICAL",
        }

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

        # Handle exception info
        if record.exc_info:
            log_record["exception"] = self.formatException(record.exc_info)

        # Handle extra fields
        if hasattr(record, "extra"):
            log_record.update(record.extra)

        return json.dumps(log_record)

def setup_logging(level=logging.INFO):
    """
    Configures the root logger to use the GCPJSONFormatter and output to stdout.
    """
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(GCPJSONFormatter())
    
    # Reset any existing handlers on the root logger
    root_logger = logging.getLogger()
    for h in root_logger.handlers[:]:
        root_logger.removeHandler(h)
    
    root_logger.addHandler(handler)
    root_logger.setLevel(level)

    # Disable basicConfig's default handler if it was already called
    logging.getLogger().propagate = True
