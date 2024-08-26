"""
    Main module for GCP cloud functions.
    Provides multiple entry points which simply call the relevant module.
"""
import functions_framework
from handle_collect_slack_messages \
    import handle_collect_slack_messages as _handle_collect_slack_messages


@functions_framework.http
def handle_collect_slack_messages(request):
    """Entry point for handle_collect_slack_messages Cloud Function."""
    return _handle_collect_slack_messages(request)
