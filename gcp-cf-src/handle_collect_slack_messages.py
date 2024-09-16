""" Module containing code to collect Slack messages from public channels.
    They are stored in BigQuery for use by RAG search etc.
"""
from typing import List, Dict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from vertexai.language_models import TextEmbeddingInput, TextEmbeddingModel

from dotenv import load_dotenv

from google.cloud import bigquery

from gcp_api import get_secret_value
from slack_api import get_public_channels, get_channel_messages_using_token, Message

DATASET_NAME = "aibot_slack_messages"
CONTENT_TABLE_NAME = "slack_content"
METADATA_TABLE_NAME = "slack_content_metadata"


class MessageWithEmbeddings(Message):
    embeddings: List[float]

    def __init__(self, message: Message):
        super().__init__(message.user, message.text, message.date, message.ts)


@dataclass
class ChannelMetadata:
    """Metadata about the data downloaded from a channel.
    """
    channel_id: str
    channel_name: str
    created_datetime: datetime
    last_download_datetime: datetime

    def to_dict(self):
        return {
            'channel_id': self.channel_id,
            'channel_name': self.channel_name,
            'created_datetime': self.created_datetime.isoformat(),
            'last_download_datetime': self.last_download_datetime.isoformat()
        }

    @classmethod
    def from_dict(cls, data: Dict):
        return cls(
            data['channel_id'],
            data['channel_name'],
            datetime.fromisoformat(data['created_datetime']),
            datetime.fromisoformat(data['last_download_datetime'])
        )


def download_slack_content():
    slack_user_token = get_secret_value('AIBot', 'slackUserToken')
    bigquery_client = bigquery.Client()

    now = datetime.now(timezone.utc)

    team_ids_for_search = get_secret_value('AIBot', 'teamIdsForSearch')
    for team_id in team_ids_for_search.split(','):
        print(f"teamId <{team_id}>")
        public_channels = get_public_channels(team_id) or []
        channels_metadata = get_channels_metadata(
            bigquery_client, public_channels)
        for public_channel in public_channels:
            print(f"Checking {public_channel['name']} "
                  f"({public_channel['id']})...")
            channel_metadata = channels_metadata[public_channel['id']]
            last_download_datetime = channel_metadata.last_download_datetime
            time_diff = now - last_download_datetime
            # Don't bother downloading if we have done so within last 10 mins.
            # Main thing this gains is skipping channels which have been shared
            # across workspaces.  Many of ours are so this is a big optimisation.
            if time_diff.total_seconds() < 600:
                print(f"Last downloaded at "
                      f"{last_download_datetime} so skipping...")
                continue

            print(f"Getting messages from "
                  f"{last_download_datetime} to {now}...")

            oldest = f"{int(last_download_datetime.timestamp())}"
            latest = f"{int(now.timestamp())}"
            messages = get_channel_messages_using_token(slack_user_token,
                                                        public_channel['id'],
                                                        oldest,
                                                        latest,
                                                        True)

            if len(messages) > 0:
                print("Generating embeddings...")
                messages = create_message_embeddings(messages)
                print("Saving messages...")
                put_channel_messages(
                    bigquery_client, public_channel['id'], messages)
            else:
                print("No messages in time range")

            print("Saving metadata...")
            channel_metadata.last_download_datetime = now
            put_channel_metadata(
                bigquery_client, channel_metadata)
            print("Done.")


def create_message_embeddings(messages: List[Message]) -> List[MessageWithEmbeddings]:
    task = "RETRIEVAL_QUERY"
    model = TextEmbeddingModel.from_pretrained("text-embedding-004")

    messages_with_embeddings: List[MessageWithEmbeddings] = list()
    for message in messages:
        message_with_embeddings = MessageWithEmbeddings(message)
        inputs = [TextEmbeddingInput(message_with_embeddings.text, task)]
        embeddings = model.get_embeddings(inputs)

        message_with_embeddings.embeddings = embeddings[0].values
        messages_with_embeddings.append(message_with_embeddings)
    return messages_with_embeddings


def put_channel_messages(bigquery_client: bigquery.Client, channel_id: str, messages: List[MessageWithEmbeddings]):
    if messages:
        @dataclass
        class BQRow:
            """Use this to marshall data into the right form for the BQ table
            """
            channel: str
            ts: datetime
            embeddings: List
        bq_rows = []
        for message in messages:
            row = BQRow(channel_id, message.ts,
                        message.embeddings)
            bq_rows.append(vars(row))
        table = bigquery_client.get_table(
            f"{DATASET_NAME}.{CONTENT_TABLE_NAME}")
        results = bigquery_client.insert_rows(
            table=table,
            rows=bq_rows,
            ignore_unknown_values=True)
        for result in results:
            print(f"put_messages result = {result}")


def put_channel_metadata(bigquery_client: bigquery.Client, channel_metadata: ChannelMetadata):

    # TODO migrate to https://cloud.google.com/bigquery/docs/write-api-streaming#exactly-once
    bq_rows = [vars(channel_metadata)]
    table = bigquery_client.get_table(
        f"{DATASET_NAME}.{METADATA_TABLE_NAME}")
    results = bigquery_client.insert_rows(
        table=table,
        rows=bq_rows,
        ignore_unknown_values=True)
    for result in results:
        print(f"put_channel_metadata result = {result}")


def delete_stale_metadata(bigquery_client: bigquery.Client, channel_metadata: ChannelMetadata):
    # Delete any other rows of metadata for this channel
    query = f"""
    DELETE FROM
      {DATASET_NAME}.{METADATA_TABLE_NAME}
        WHERE channel_id = "{channel_metadata.channel_id}"
        and last_download_datetime <> DATETIME(TIMESTAMP("{channel_metadata.last_download_datetime}"))
        and last_download_datetime < DATETIME_SUB(CURRENT_DATETIME(), INTERVAL 90 MINUTE)
    """
    print(query)
    query_job = bigquery_client.query(query)
    query_job.result()


def get_channels_metadata(bigquery_client: bigquery.Client, channels: list[Dict]) -> dict[str, ChannelMetadata]:

    sql_channel_ids = ', '.join(
        [f"\"{channel["id"]}\"" for channel in channels])
    # The query uses max to deal with the case of multiple rows of metadata for the same channel.
    # BQ is an append-only database (mainly) so need to deal with this case.
    query = f"""
    SELECT      channel_id, channel_name, created_datetime, MAX(last_download_datetime) as last_download_datetime
    FROM        {DATASET_NAME}.{METADATA_TABLE_NAME}
    WHERE       channel_id in ({sql_channel_ids})
    GROUP BY    channel_id, channel_name, created_datetime
    """

    query_job = bigquery_client.query(query)
    rows = query_job.result()
    all_metadata: dict[str, ChannelMetadata] = dict()
    for row in rows:
        channel_metadata = ChannelMetadata(
            channel_id=row['channel_id'],
            channel_name=row['channel_name'],
            # The replace below makes the datetimes offset-aware.
            created_datetime=row['created_datetime'].replace(
                tzinfo=timezone.utc),
            last_download_datetime=row['last_download_datetime'].replace(
                tzinfo=timezone.utc))
        all_metadata[channel_metadata.channel_id] = channel_metadata

    # Set default metadata if channel doesn't have any metadata yet.
    for channel in channels:
        if not channel['id'] in all_metadata:
            created_datetime = datetime.fromtimestamp(
                channel['created'], tz=timezone.utc)
            all_metadata[channel['id']] = ChannelMetadata(
                channel_id=channel['id'],
                channel_name=channel['name'],
                created_datetime=created_datetime,
                last_download_datetime=created_datetime)

    return all_metadata


def get_channel_metadata(bigquery_client: bigquery.Client, channel: Dict) -> ChannelMetadata:
    # The query uses max to deal with the case of multiple rows of metadata for the same channel.
    # This shouldn't really happen but best to be defensive anyway.
    query = f"""
    SELECT      channel_id, channel_name, created_datetime, MAX(last_download_datetime) as last_download_datetime
    FROM        {DATASET_NAME}.{METADATA_TABLE_NAME}
    WHERE       channel_id = '{channel["id"]}'
    GROUP BY    channel_id, channel_name, created_datetime
    """
    query_job = bigquery_client.query(query)
    rows = query_job.result()
    if (rows.total_rows == 0):
        print(f"Returning default metadata for {channel["name"]}")
        created_datetime = datetime.fromtimestamp(
            channel['created'], tz=timezone.utc)
        channel_metadata = ChannelMetadata(
            channel_id=channel['id'],
            channel_name=channel['name'],
            created_datetime=created_datetime,
            last_download_datetime=created_datetime
        )
        return channel_metadata

    for row in rows:
        channel_metadata = ChannelMetadata(
            channel_id=row['channel_id'],
            channel_name=row['channel_name'],
            created_datetime=row['created_datetime'].replace(
                tzinfo=timezone.utc),
            last_download_datetime=row['last_download_datetime'].replace(
                tzinfo=timezone.utc)
        )
        return channel_metadata


def handle_collect_slack_messages(request):
    """Entry point when called as a GCP Cloud Function
    """
    print(f"handle_collect_slack_messages: {request}!")
    return "OK"


def main():
    """Entry point for local testing.
    """
    load_dotenv()
    download_slack_content()


if __name__ == "__main__":
    main()
