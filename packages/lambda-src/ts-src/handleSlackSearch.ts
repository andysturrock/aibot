import { helpers, PredictionServiceClient } from '@google-cloud/aiplatform';
import { google } from '@google-cloud/aiplatform/build/protos/protos';
import { BigQuery, BigQueryOptions } from '@google-cloud/bigquery';
import { Citation, CitationMetadata, GenerateContentRequest, GenerativeModel, GenerativeModelPreview, TextPart } from '@google-cloud/vertexai';
import util from 'util';
import { getSecretValue } from './awsAPI';
import { ModelFunctionCallArgs } from './handleAICommon';
import { getPermaLink } from './slackAPI';
// Makes util.inspect print large structures (eg embeddings arrays) in full rather than truncating.
util.inspect.defaultOptions.maxArrayLength = null;

async function generateEmbeddings(text: string) {
  const gcpProjectId = await getSecretValue('AIBot', 'gcpProjectId');
  const gcpLocation = await getSecretValue('AIBot', 'gcpLocation');
  const apiEndpoint = `${gcpLocation}-aiplatform.googleapis.com`;
  const clientOptions = {apiEndpoint: apiEndpoint};
  const model = "text-embedding-004";
  const endpoint = `projects/${gcpProjectId}/locations/${gcpLocation}/publishers/google/models/${model}`;
  const taskType = "RETRIEVAL_QUERY";

  const instances = [helpers.toValue({content: text, task_type: taskType})] as google.protobuf.IValue[];
  
  // From @google-cloud/aiplatform/build/protos/protos.d.ts
  type IPredictRequest = {
    endpoint?: (string|null);
    instances?: (google.protobuf.IValue[]|null);
    parameters?: (google.protobuf.IValue|null);
  };
  const request: IPredictRequest = {endpoint, instances};
  const client = new PredictionServiceClient(clientOptions);
  const [response] = await client.predict(request);
  const predictions = response.predictions;
  const embeddings: number[] = [];
  if(predictions) {
    for(const prediction of predictions) {
      const embeddingsProto = prediction.structValue?.fields?.embeddings;
      if(embeddingsProto) {
        const valuesProto = embeddingsProto.structValue?.fields?.values;
        // const thing = valuesProto?.listValue?.values?.map(v => v.numberValue);
        for(const value of valuesProto?.listValue?.values ?? []) {
          if(value.numberValue) {
            embeddings.push(value.numberValue);
          }
        }
      }
    }
  }
  return embeddings;
}

export async function handleSlackSearch(slackSummaryModel: GenerativeModel | GenerativeModelPreview,
  modelFunctionCallArgs: ModelFunctionCallArgs,
  generateContentRequest: GenerateContentRequest) {

  if(!modelFunctionCallArgs.prompt) {
    throw new Error("modelFunctionCallArgs missing prompt");
  }
  console.log(`Generating embeddings...`);
  const searchEmbeddings  = await generateEmbeddings(modelFunctionCallArgs.prompt);
  const project = await getSecretValue('AIBot', 'gcpProjectId');
  // Region is something like eu-west2, multi-region is when you can specify "eu" or "us"
  const location = await getSecretValue('AIBot', 'gcpMultiRegion');
  const bigQueryOptions: BigQueryOptions = {
    projectId: project,
    location,
    scopes: ['https://www.googleapis.com/auth/bigquery']
  };
  const bigQuery = new BigQuery(bigQueryOptions);

  const query = `
    SELECT distinct base.workspace, base.channel, base.ts, base.text, distance
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

  console.log(`Doing vector query ${query}...`);
  const [job] = await bigQuery.createQueryJob(options);
  type Row = {
    workspace: string,
    channel: string,
    ts: number,
    text: string,
    distance: number
  };
  const queryRowsResponse = await job.getQueryResults();
  const rows = queryRowsResponse[0] as Row[];
  
  const prompt = `
    The data below is a set of Slack messages.  The messages have been pre-selected to contain relevant content about the question.
    Using the content below, respond to the request "${modelFunctionCallArgs.prompt}".
    ${util.inspect(rows, false, null)}
  `;
  console.log(`prompt: ${prompt}`);

  // Search backwards through the content until we find the most recent user part, which should be the original prompt.
  // Then add a text part to that with all the detail above.
  const lastUserContent = generateContentRequest.contents.findLast(content => content.role == 'user');
  if(!lastUserContent) {
    throw new Error(`Could not find user content in generateContentRequest: ${util.inspect(generateContentRequest, false, null)}`);
  }
  const promptPart: TextPart = {
    text: prompt
  };
  lastUserContent.parts.push(promptPart);

  const content = await slackSummaryModel.generateContent(generateContentRequest);
  // Add the original set of messages in as Citations
  const citations: Citation[] = [];
  for(const row of rows) {
    // Slack has a handy API for getting a permalink to a message given its channel and timestamp
    const uri = await getPermaLink(row.channel, `${row.ts}`);
    const citation: Citation = {
      uri,
      title: row.text
    };
    citations.push(citation);
  }
  if(content.response.candidates?.[0]) {
    if(content.response.candidates[0].citationMetadata) {
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
