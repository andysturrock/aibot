import json

from tools.mcp_proxy import format_slack_messages, process_tool_result


class MockResult:
    def __init__(
        self, content, isError=False, structuredContent=None, model_extra=None
    ):
        self.content = content
        self.isError = isError
        self.structuredContent = structuredContent
        self.model_extra = model_extra or {}


class MockContent:
    def __init__(self, type, text):
        self.type = type
        self.text = text


def test_process_tool_result_slack_search_transformation():
    """Test that slack search results are correctly transformed into Markdown table."""
    name = "search_slack"
    raw_data = [
        {
            "text": "Hello world",
            "user_name": "Andy",
            "channel_name": "general",
            "ts": "123.456",
        }
    ]
    result = MockResult(
        content=[MockContent(type="text", text="Found 1 message.")],
        structuredContent={"result": raw_data},
    )

    final_res = process_tool_result(name, result)

    assert final_res.isError is False
    assert len(final_res.content) == 1
    # Should be the Markdown table
    assert "| Date | User | Channel | Message |" in final_res.content[0].text
    assert "Andy" in final_res.content[0].text


def test_process_tool_result_empty_structured_content():
    """Test resiliency against empty structured content."""
    name = "search_slack"
    result = MockResult(
        content=[MockContent(type="text", text="No messages found.")],
        structuredContent={"result": []},
    )

    final_res = process_tool_result(name, result)

    assert final_res.isError is False
    assert len(final_res.content) == 1
    assert "No Slack messages found." in final_res.content[0].text


def test_format_slack_messages_table():
    """Test that the table formatter produces correct headers and content."""
    messages = [{"user_name": "Andy", "text": "Testing 123", "channel_name": "tech"}]
    output = format_slack_messages(json.dumps(messages))

    assert "| Date | User | Channel | Message |" in output
    assert "| :--- | :--- | :--- | :--- |" in output
    assert "Andy" in output
    assert "Testing 123" in output
    assert "#tech" in output


def test_process_tool_result_error_pass_through():
    """Test that errors from remote server are preserved and not re-formatted."""
    name = "search_slack"
    result = MockResult(
        content=[MockContent(type="text", text="Remote error message.")], isError=True
    )

    final_res = process_tool_result(name, result)

    assert final_res.isError is True
    assert len(final_res.content) == 1
    assert final_res.content[0].text == "Remote error message."
