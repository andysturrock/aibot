import json
import logging
import sys
from io import StringIO

from shared.logging import GCPJSONFormatter, SilenceGenAIWarningFilter, setup_logging


def test_gcp_json_formatter():
    formatter = GCPJSONFormatter()
    log_record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname="test.py",
        lineno=10,
        msg="test message",
        args=None,
        exc_info=None,
        func="test_func",
    )
    # Add an extra attribute
    log_record.custom_attr = "custom_value"

    formatted = formatter.format(log_record)
    data = json.loads(formatted)

    assert data["severity"] == "INFO"
    assert data["message"] == "test message"
    assert data["custom_attr"] == "custom_value"
    assert "timestamp" in data
    assert data["logging.googleapis.com/sourceLocation"]["file"] == "test.py"


def test_gcp_json_formatter_exception():
    formatter = GCPJSONFormatter()
    try:
        raise ValueError("test error")
    except ValueError:
        log_record = logging.LogRecord(
            name="test",
            level=logging.ERROR,
            pathname="test.py",
            lineno=10,
            msg="error happened",
            args=None,
            exc_info=sys.exc_info(),
            func="test_func",
        )

    formatted = formatter.format(log_record)
    data = json.loads(formatted)
    assert "stack_trace" in data
    assert "ValueError: test error" in data["stack_trace"]


def test_silence_genai_warning_filter():
    filter_ = SilenceGenAIWarningFilter()

    # record with warning
    record_warning = logging.LogRecord(
        "test", logging.WARNING, "x", 1, "non-text parts in the response", None, None
    )
    assert filter_.filter(record_warning) is False

    # other record
    record_other = logging.LogRecord(
        "test", logging.WARNING, "x", 1, "something else", None, None
    )
    assert filter_.filter(record_other) is True


def test_setup_logging():
    # Capture stdout
    old_stdout = sys.stdout
    sys.stdout = StringIO()
    try:
        setup_logging(level=logging.DEBUG)
        logger = logging.getLogger("test_logger")
        logger.debug("hello debug")

        output = sys.stdout.getvalue()
        # Verify it's JSON
        data = json.loads(output.splitlines()[-1])
        assert data["message"] == "hello debug"
        assert data["severity"] == "DEBUG"
    finally:
        sys.stdout = old_stdout
