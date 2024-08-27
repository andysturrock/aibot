""" Module containing code to collect Slack messages from public channels.
    They are stored in a GCP Bucket for use by RAG search etc.
"""
import json
from typing import List, Dict
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv

from google.cloud import storage
from google.cloud.storage.retry import DEFAULT_RETRY

import jsonpickle

from gcp_api import get_secret_value
from slack_api import get_public_channels, get_channel_messages_using_token, Message

# Change the default retry settings so we don't get 429 errors.
# modified_retry = DEFAULT_RETRY.with_deadline(500.0)
# modified_retry = modified_retry.with_delay(multiplier=10)
modified_retry = DEFAULT_RETRY.with_delay(multiplier=5)


def handle_collect_slack_messages(request):
    return f"Hello {request}!"


class ChannelBucketMetadata:
    def __init__(self, channel_id: str, channel_name: str, created_date: datetime, last_download_date: datetime):
        self.channel_id = channel_id
        self.channel_name = channel_name
        self.created_date = created_date
        self.last_download_date = last_download_date

    def to_dict(self):
        return {
            'channel_id': self.channel_id,
            'channel_name': self.channel_name,
            'created_date': self.created_date.isoformat(),
            'last_download_date': self.last_download_date.isoformat()
        }

    @classmethod
    def from_dict(cls, data: Dict):
        return cls(
            data['channel_id'],
            data['channel_name'],
            datetime.fromisoformat(data['created_date']),
            datetime.fromisoformat(data['last_download_date'])
        )


def download_slack_content():
    slack_user_token = get_secret_value('AIBot', 'slackUserToken')
    slack_search_bucket_name = get_secret_value(
        'AIBot', 'slackSearchBucketName')

    now = datetime.now(timezone.utc)
    end_of_today = create_end_of_day_date(now)
    start_of_tomorrow = end_of_today + timedelta(milliseconds=1)

    storage_client = storage.Client()
    slack_search_bucket = storage_client.bucket(slack_search_bucket_name)

    team_ids_for_search = get_secret_value('AIBot', 'teamIdsForSearch')
    for team_id in team_ids_for_search.split(','):
        print(f"teamId <{team_id}>")
        public_channels = get_public_channels(team_id) or []
        for public_channel in public_channels:

            channel_bucket_metadata = get_channel_bucket_metadata(
                slack_search_bucket, public_channel)
            current_day_to_get_messages = channel_bucket_metadata.last_download_date

            while current_day_to_get_messages < start_of_tomorrow:
                messages = get_messages_for_day(
                    slack_user_token, public_channel, current_day_to_get_messages)

                # We have got messages for the entire day, so set the last_download_date
                # to reflect that.
                channel_bucket_metadata.last_download_date = create_end_of_day_date(
                    current_day_to_get_messages)
                put_messages(slack_search_bucket,
                             channel_bucket_metadata, messages)
                put_channel_bucket_metadata(
                    slack_search_bucket, channel_bucket_metadata)
                current_day_to_get_messages += timedelta(days=1)

            # For "today" the last download date won't be end of day today,
            # because that hasn't happened yet.  So set the last_download_date to now.
            # This doesn't make any difference to the application logic
            # as we always get a full day, but it might be confusing if someone
            # looks at the metadata file.
            channel_bucket_metadata.last_download_date = now
            put_channel_bucket_metadata(
                slack_search_bucket, channel_bucket_metadata)


def create_start_of_day_date(day: datetime) -> datetime:
    return day.replace(hour=0, minute=0, second=0, microsecond=0)


def create_end_of_day_date(day: datetime) -> datetime:
    return day.replace(hour=23, minute=59, second=59, microsecond=999999)


def get_messages_for_day(slack_user_token: str, channel: Dict, day: datetime) -> List[Dict]:
    if not channel.get('id'):
        raise ValueError("channel.id is missing")
    start_of_day = create_start_of_day_date(day)
    end_of_day = create_end_of_day_date(day)
    print(f"Getting messages for {channel.get('name', 'Unknown')} ({channel['id']}) between {
          start_of_day.isoformat()} and {end_of_day.isoformat()}...")
    messages = get_channel_messages_using_token(slack_user_token,
                                                channel['id'],
                                                int(start_of_day.timestamp()),
                                                int(end_of_day.timestamp()),
                                                True)
    return messages


def put_messages(slack_search_bucket: storage.Bucket, channel_bucket_metadata: ChannelBucketMetadata, messages: List[Message]):
    if messages:
        last_download_date = channel_bucket_metadata.last_download_date
        date_string = last_download_date.strftime("%Y_%m_%d")
        messages_file_name = f"{
            channel_bucket_metadata.channel_id}/{date_string}_messages.json"
        messages_file = slack_search_bucket.blob(messages_file_name)
        messages_json = jsonpickle.encode(messages, unpicklable=False)
        messages_file.upload_from_string(messages_json, retry=modified_retry)


def put_channel_bucket_metadata(slack_search_bucket: storage.Bucket, channel_bucket_metadata: ChannelBucketMetadata):
    metadata_file_name = f"{channel_bucket_metadata.channel_id}/metadata.json"
    metadata_file = slack_search_bucket.blob(metadata_file_name)
    metadata_file.upload_from_string(
        json.dumps(channel_bucket_metadata.to_dict()), retry=modified_retry)


def get_channel_bucket_metadata(slack_search_bucket: storage.Bucket, channel: Dict) -> ChannelBucketMetadata:
    if not channel.get('id'):
        raise ValueError("channel.id is missing")
    if not channel.get('name'):
        raise ValueError("channel.name is missing")
    if not channel.get('created'):
        raise ValueError("channel.created is missing")

    # Default version if the file doesn't exist.
    created_date = datetime.fromtimestamp(channel['created'], tz=timezone.utc)
    channel_bucket_metadata = ChannelBucketMetadata(
        channel['id'],
        channel['name'],
        created_date=created_date,
        last_download_date=created_date
    )

    channel_bucket_metadata_file_name = f"{channel['id']}/metadata.json"
    channel_bucket_metadata_file = slack_search_bucket.blob(
        channel_bucket_metadata_file_name)
    if channel_bucket_metadata_file.exists():
        channel_bucket_metadata = ChannelBucketMetadata.from_dict(
            json.loads(channel_bucket_metadata_file.download_as_string()))
        # Make the dates timezone aware.  Everything is in GMT so just use that.
        channel_bucket_metadata.created_date = channel_bucket_metadata.created_date.replace(
            tzinfo=timezone.utc)
        channel_bucket_metadata.last_download_date = channel_bucket_metadata.last_download_date.replace(
            tzinfo=timezone.utc)

    return channel_bucket_metadata


if __name__ == "__main__":
    load_dotenv()
    download_slack_content()
