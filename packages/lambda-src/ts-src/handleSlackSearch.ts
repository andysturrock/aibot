import { helpers, PredictionServiceClient } from '@google-cloud/aiplatform';
import { google } from '@google-cloud/aiplatform/build/protos/protos';
import { BigQuery, BigQueryOptions } from '@google-cloud/bigquery';
import { Citation, CitationMetadata } from '@google-cloud/vertexai';
import { GenerateContentParameters, Part } from '@google/genai';
import util from 'util';
import { getSecretValue } from './awsAPI';
import { ModelFunctionCallArgs } from './aiService';
import { getChannelName, getPermaLink, getThreadMessagesUsingToken, Message } from './slackAPI';
// Set default options for util.inspect to make it work well in CloudWatch
util.inspect.defaultOptions.maxArrayLength = null;
util.inspect.defaultOptions.depth = null;
util.inspect.defaultOptions.colors = false;

export async function handleSlackSearch(slackSummaryModel: any,
  modelFunctionCallArgs: ModelFunctionCallArgs,
  generateContentRequest: GenerateContentParameters) {

  if (!modelFunctionCallArgs.prompt) {
    throw new Error("modelFunctionCallArgs missing prompt");
  }
  const searchEmbeddings = await generateEmbeddings(modelFunctionCallArgs.prompt);
  const project = await getSecretValue('AIBot', 'gcpProjectId');
  // Region is something like eu-west2, multi-region is when you can specify "eu" or "us"
  const location = await getSecretValue('AIBot', 'gcpMultiRegion');
  const bigQueryOptions: BigQueryOptions = {
    projectId: project,
    location,
    scopes: ['https://www.googleapis.com/auth/bigquery']
  };
  const bigQuery = new BigQuery(bigQueryOptions);

  type Row = {
    channel: string,
    ts: number,
    distance: number
  };
  const query = `
    SELECT distinct base.channel, base.ts, distance
        FROM VECTOR_SEARCH(
        TABLE aibot_slack_messages.slack_content,
        'embeddings',
        (
           select ${util.inspect(searchEmbeddings, false, null)} as search_embeddings
        ),
        query_column_to_search => 'search_embeddings',
        top_k => 15,
        options => '{"fraction_lists_to_search": 1.0}'
        )
        order by distance
  `;

  // For all options, see https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query
  const options = {
    query: query,
    useLegacySql: false
  };

  const [job] = await bigQuery.createQueryJob(options);
  const queryRowsResponse = await job.getQueryResults();
  const rows = queryRowsResponse[0] as Row[];

  const slackUserToken = await getSecretValue('AIBot', 'slackUserToken');
  // For each row returned by the vector search, pull back the entire thread.
  // Assuming people are using Slack "correctly" and using threads, then
  // the thread should contain relevant information to the original selected message.
  // This increases the context given to the main model to summarise.
  // It also means we don't store the text of the message in the BQ table as we get it here.
  // That keeps things more secure.
  type QuotedMessage = Message & {
    quotedChannel: string;
    quotedUser: string
  };
  const messages: QuotedMessage[] = [];

  for (const row of rows) {
    try {
      const threadRows = await getThreadMessagesUsingToken(slackUserToken, row.channel, `${row.ts}`);
      // Turn the raw channel ids and user ids into quoted versions so they show up properly in the results.
      // eg turn U012AB3CD into <@U012AB3CD> and C123ABC456 into <#C123ABC456>
      for (const threadRow of threadRows) {
        const quotedMessage: QuotedMessage = {
          quotedChannel: `<#${threadRow.channel}>`,
          quotedUser: `<@${threadRow.user}>`,
          ...threadRow
        };
        messages.push(quotedMessage);
      }
    }
    catch {
      console.error(`Error fetching messages from channel ${row.channel} thread ${row.ts}`);
    }
  }

  const prompt = `
    The data below is a set of Slack messages.  The messages have been pre-selected to contain relevant content about the question.
    The format is json with the following fields:
    {
      quotedChannel: 'Slack channel id in output format',
      quotedUser: 'Slack user id in output format',
      channel: 'The Slack channel id',
      user: 'The Slack user id',
      text: 'The text of the message',
      date: 'The date of the message in ISO 8601 format',
      ts: A Unix timestamp (ie seconds after the epoch) for the message.  You can ignore the part after the decimal point.
      threadTs: An optional Unix timestamp (ie seconds after the epoch) if message is in a thread.  You can ignore the part after the decimal point.
    }
    In your response convert the Unix timestamps and date fields into normal dates (eg 19th September 2024).
    In your response use the quotedChannel and quotedUser fields to refer to channels or users.  Use the field name directly, ie keep the <> and # and @ characters.

    Using these messages below, respond to the request: ${modelFunctionCallArgs.prompt}.
    ${util.inspect(messages, false, null)}
  `;

  // Search backwards through the content until we find the most recent user part, which should be the original prompt.
  // Then add a text part to that with all the detail above.
  const lastUserContent = (generateContentRequest.contents as any).findLast((content: any) => content.role == 'user');
  if (!lastUserContent) {
    throw new Error(`Could not find user content in generateContentRequest: ${util.inspect(generateContentRequest, false, null)}`);
  }
  const promptPart: Part = {
    text: prompt
  };
  lastUserContent.parts.push(promptPart);

  const content = await slackSummaryModel.generateContent(generateContentRequest);
  // Add the set of messages we've considered in as Citations.
  const citations: Citation[] = [];
  // Use to keep track whether citations are duplicates.
  const citationSet = new Set<string>();
  for (const message of messages) {
    // Create the citation if we haven't already cited the parent message or this message.
    if (!citationSet.has(message.threadTs ?? message.ts)) {
      // Slack has a handy API for getting a permalink to a message given its channel and timestamp.
      // If the message is in a thread create the link to the parent message of the thread.
      const uri = await getPermaLink(message.channel, message.threadTs ?? message.ts);
      const channelName = await getChannelName(message.channel);
      const citation: Citation = {
        uri,
        title: channelName
      };
      citations.push(citation);
      citationSet.add(message.threadTs ?? message.ts);
    }
  }
  if (content.response.candidates?.[0]) {
    if (content.response.candidates[0].citationMetadata) {
      content.response.candidates[0].citationMetadata.citations = citations;
    }
    else {
      const citationMetadata: CitationMetadata = {
        citations
      };
      content.response.candidates[0].citationMetadata = citationMetadata;
    }
  }
  return content;
}

async function generateEmbeddings(text: string) {
  const gcpProjectId = await getSecretValue('AIBot', 'gcpProjectId');
  const gcpLocation = await getSecretValue('AIBot', 'gcpLocation');
  const apiEndpoint = `${gcpLocation}-aiplatform.googleapis.com`;
  const clientOptions = { apiEndpoint: apiEndpoint };
  const model = "text-embedding-004";
  const endpoint = `projects/${gcpProjectId}/locations/${gcpLocation}/publishers/google/models/${model}`;
  const taskType = "RETRIEVAL_QUERY";

  const instances = [helpers.toValue({ content: text, task_type: taskType })] as google.protobuf.IValue[];

  // From @google-cloud/aiplatform/build/protos/protos.d.ts
  type IPredictRequest = {
    endpoint?: (string | null);
    instances?: (google.protobuf.IValue[] | null);
    parameters?: (google.protobuf.IValue | null);
  };
  const request: IPredictRequest = { endpoint, instances };
  const client = new PredictionServiceClient(clientOptions);
  const [response] = await client.predict(request);
  const predictions = response.predictions;
  const embeddings: number[] = [];
  if (predictions) {
    for (const prediction of predictions) {
      const embeddingsProto = prediction.structValue?.fields?.embeddings;
      if (embeddingsProto) {
        const valuesProto = embeddingsProto.structValue?.fields?.values;
        for (const value of valuesProto?.listValue?.values ?? []) {
          if (value.numberValue) {
            embeddings.push(value.numberValue);
          }
        }
      }
    }
  }
  return embeddings;
}


