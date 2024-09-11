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
class ChannelBucketMetadata:
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
    end_of_today = create_end_of_day_date(now)
    start_of_tomorrow = end_of_today + timedelta(milliseconds=1)

    team_ids_for_search = get_secret_value('AIBot', 'teamIdsForSearch')
    for team_id in team_ids_for_search.split(','):
        print(f"teamId <{team_id}>")
        public_channels = get_public_channels(team_id) or []
        for public_channel in public_channels:

            channel_bucket_metadata = get_channel_bucket_metadata(
                bigquery_client, public_channel)
            current_day_to_get_messages = channel_bucket_metadata.last_download_datetime

            count = 0
            while current_day_to_get_messages < start_of_tomorrow:
                count += 1
                print(f"""Getting messages for {public_channel['name']} """
                      f"""({public_channel['id']}) for {current_day_to_get_messages}""")

                messages = get_messages_for_day(
                    slack_user_token, public_channel, current_day_to_get_messages)

                if len(messages) > 0:
                    print("Generating embeddings...")
                    messages = create_message_embeddings(messages)
                    print("Saving messages...")
                    put_messages(bigquery_client, team_id,
                                 public_channel['id'], messages)
                else:
                    print("No messages on day")

                # We have got messages for the entire day, so set the last_download_date
                # to reflect that.
                channel_bucket_metadata.last_download_datetime = create_end_of_day_date(
                    current_day_to_get_messages)
                # Saving the metadata is quite slow so only save periodically.
                # It's not a big deal if we end up with duplicate message data
                if count == 100:
                    count = 0
                    print("Saving metadata...")
                    put_channel_bucket_metadata(
                        bigquery_client, channel_bucket_metadata)

                current_day_to_get_messages += timedelta(days=1)
                print("Done.")

            # For "today" the last download datetime won't be end of day today,
            # because that hasn't happened yet.  So set the last_download_datetime to now.
            # This doesn't make any difference to the application logic
            # as we always get a full day, but it might be confusing if someone
            # looks at the metadata directly.
            channel_bucket_metadata.last_download_datetime = now
            put_channel_bucket_metadata(
                bigquery_client, channel_bucket_metadata)


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


def create_start_of_day_date(day: datetime) -> datetime:
    return day.replace(hour=0, minute=0, second=0, microsecond=0)


def create_end_of_day_date(day: datetime) -> datetime:
    return day.replace(hour=23, minute=59, second=59, microsecond=999999)


def get_messages_for_day(slack_user_token: str, channel: Dict, day: datetime) -> List[Message]:
    if not channel.get('id'):
        raise ValueError("channel.id is missing")
    start_of_day = create_start_of_day_date(day)
    end_of_day = create_end_of_day_date(day)
    messages = get_channel_messages_using_token(slack_user_token,
                                                channel['id'],
                                                int(start_of_day.timestamp()),
                                                int(end_of_day.timestamp()),
                                                True)
    return messages


def put_messages(bigquery_client: bigquery.Client, team_id: str, channel_id: str, messages: List[MessageWithEmbeddings]):
    if messages:
        @dataclass
        class BQRow:
            """Use this to marshall data into the right form for the BQ table
            """
            workspace: str
            channel: str
            ts: datetime
            text: str
            embeddings: List
        bq_rows = []
        for message in messages:
            row = BQRow(team_id, channel_id, message.ts,
                        message.text, message.embeddings)
            bq_rows.append(vars(row))
        table = bigquery_client.get_table(
            f"{DATASET_NAME}.{CONTENT_TABLE_NAME}")
        results = bigquery_client.insert_rows(
            table=table,
            rows=bq_rows,
            ignore_unknown_values=True)
        for result in results:
            print(f"put_messages result = {result}")


def put_channel_bucket_metadata(bigquery_client: bigquery.Client, channel_bucket_metadata: ChannelBucketMetadata):
    # Use query jobs rather than insert_rows so we bypass the streaming buffer.
    # Otherwise we can't delete the old rows for 90 mins.
    # TODO migrate to https://cloud.google.com/bigquery/docs/write-api-streaming#exactly-once
    query = f"""
    INSERT INTO {DATASET_NAME}.{METADATA_TABLE_NAME} (
        channel_id,
        channel_name,
        created_datetime,
        last_download_datetime
    )
    VALUES (
        "{channel_bucket_metadata.channel_id}",
        "{channel_bucket_metadata.channel_name}",
        DATETIME(TIMESTAMP("{channel_bucket_metadata.created_datetime}")),
        DATETIME(TIMESTAMP("{channel_bucket_metadata.last_download_datetime}"))
    )
    """
    query_job = bigquery_client.query(query)
    query_job.result()

    # Delete any other rows of metadata for this channel
    query = f"""
    DELETE FROM
      {DATASET_NAME}.{METADATA_TABLE_NAME}
        WHERE channel_id = "{channel_bucket_metadata.channel_id}"
        and last_download_datetime <> DATETIME(TIMESTAMP("{channel_bucket_metadata.last_download_datetime}"))
    """
    query_job = bigquery_client.query(query)
    query_job.result()


def get_channel_bucket_metadata(bigquery_client: bigquery.Client, channel: Dict) -> ChannelBucketMetadata:
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
        channel_bucket_metadata = ChannelBucketMetadata(
            channel_id=channel['id'],
            channel_name=channel['name'],
            created_datetime=created_datetime,
            last_download_datetime=created_datetime
        )
        return channel_bucket_metadata

    for row in rows:
        channel_bucket_metadata = ChannelBucketMetadata(
            channel_id=row['channel_id'],
            channel_name=row['channel_name'],
            created_datetime=row['created_datetime'].replace(
                tzinfo=timezone.utc),
            last_download_datetime=row['last_download_datetime'].replace(
                tzinfo=timezone.utc)
        )
        return channel_bucket_metadata


def create_embeddings_for_query(text: str):
    task = "RETRIEVAL_QUERY"
    output_dimensionality = 256
    model = TextEmbeddingModel.from_pretrained("text-embedding-004")

    inputs = [TextEmbeddingInput(text, task)]
    query_embeddings = model.get_embeddings(
        inputs, output_dimensionality=output_dimensionality)
    return query_embeddings[0].values


def vector_search(bigquery_client: bigquery.Client, search_embeddings: List[float]):
    query = f"""
    SELECT distinct base.workspace, base.channel, base.ts, base.text, distance
        FROM VECTOR_SEARCH(
        TABLE `aibot_slack_messages.slack_content`,
        'embeddings',
        (
           select {search_embeddings} as search_embeddings
        ),
        query_column_to_search => 'search_embeddings',
        top_k => 15,
        options => '{{"fraction_lists_to_search": 1.0}}'
        )
        order by distance
    """
    # options => '{{"fraction_lists_to_search": 0.01}}'
    print(query)
    query_job = bigquery_client.query(query)
    results = query_job.result()
    for result in results:
        print(f"result: {result}")


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
    embeddings = create_embeddings_for_query(
        "Good reviews about Atom")
    bigquery_client = bigquery.Client()
    vector_search(bigquery_client, embeddings)


if __name__ == "__main__":
    main()

# Query to delete duplicates from slack_content table
# TODO schedule this on a timer
# delete from aibot_slack_messages.slack_content as content
# where exists (
#   select content.workspace, content.channel, content.ts, content.text
#   from (
#     select count(ts) as count, workspace, channel, ts, text from aibot_slack_messages.slack_content
#       group by workspace, channel, ts, text
#       having count(ts) > 1
#   ) as dups
#   where content.workspace = dups.workspace
#   and content.channel = dups.channel
#   and content.ts = dups.ts
#   and content.text = dups.text
#   and TIMESTAMP_SECONDS(cast(content.ts as INT64)) < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 MINUTE))
