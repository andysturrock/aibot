/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// import {SearchServiceClient} from '@google-cloud/discoveryengine';
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-member-access
const {SearchServiceClient} = require('@google-cloud/discoveryengine').v1beta;
import util from 'util';

const projectId = 'PROJECT_ID_PLACEHOLDER';
const location = 'eu';              // Options: 'global', 'us', 'eu'
const collectionId = 'default_collection';     // Options: 'default_collection'
const dataStoreId = 'atomsearch1-ds_1708613557783';       // Create in Cloud Console
const servingConfigId = 'default_config';      // Options: 'default_config'
const searchQuery = 'What monitors FRS?';

const apiEndpoint = `${location}-discoveryengine.googleapis.com`;

// Instantiates a client
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
const client = new SearchServiceClient({apiEndpoint: apiEndpoint});
console.log(`client: ${util.inspect(client)}`);
// const client = new DiscoveryEngine.v1beta.SearchServiceClient({apiEndpoint: apiEndpoint});

export async function search() {
  // The full resource name of the search engine serving configuration.
  // Example: projects/{projectId}/locations/{location}/collections/{collectionId}/dataStores/{dataStoreId}/servingConfigs/{servingConfigId}
  // You must create a search engine in the Cloud Console first.
  const name = client.projectLocationCollectionDataStoreServingConfigPath(
    projectId,
    location,
    collectionId,
    dataStoreId,
    servingConfigId
  );

  const request = {
    pageSize: 10,
    query: searchQuery,
    servingConfig: name,
  };

  const IResponseParams = {
    ISearchResult: 0,
    ISearchRequest: 1,
    ISearchResponse: 2,
  };

  // Perform search request
  const response = await client.search(request, {
    // Warning: Should always disable autoPaginate to avoid iterate through all pages.
    //
    // By default NodeJS SDK returns an iterable where you can iterate through all
    // search results instead of only the limited number of results requested on
    // pageSize, by sending multiple sequential search requests page-by-page while
    // iterating, until it exhausts all the search results. This will be unexpected and
    // may cause high Search API usage and long wait time, especially when the matched
    // document numbers are huge.
    autoPaginate: false,
  });
  const results = response[IResponseParams.ISearchResponse].results;

  for(const result of results) {
    console.log(result);
  }
}