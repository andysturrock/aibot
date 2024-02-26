import {Auth, discoveryengine_v1alpha, google} from 'googleapis';
import {getGCalToken} from './tokenStorage';
import {getSecretValue} from './awsAPI';
import {postMessage, postEphmeralErrorMessage, postErrorMessageToResponseUrl, postToResponseUrl, SlashCommandPayload} from './slackAPI';
import {KnownBlock, SectionBlock} from '@slack/bolt';
import util from 'util';

export async function handlePromptCommand(event: SlashCommandPayload): Promise<void> {
  console.log(`event: ${util.inspect(event)}`);
  const responseUrl = event.response_url;
  const channelId = event.channel_id;
  try {
    const gcalRefreshToken = await getGCalToken(event.user_id);
    if(!gcalRefreshToken) {
      if(responseUrl) {
        await postErrorMessageToResponseUrl(responseUrl, `Log into Google, either with the slash command or the bot's Home tab.`);
      }
      else if(channelId) {
        await postEphmeralErrorMessage(channelId, event.user_id, `Log into Google, either with the slash command or the bot's Home tab.`);
      }
      return;
    }

    // User is logged into both Google so now we can use those APIs to call Vertex AI.
    const gcpClientId = await getSecretValue('AIBot', 'gcpClientId');
    const gcpClientSecret = await getSecretValue('AIBot', 'gcpClientSecret');
    const aiBotUrl = await getSecretValue('AIBot', 'aiBotUrl');
    const gcpRedirectUri = `${aiBotUrl}/google-oauth-redirect`;
    // Something like projects/<projectid>/locations/<region>/collections/default_collection/dataStores/<datastore>/servingConfigs/default_search
    const servingConfig = await getSecretValue('AIBot', 'servingConfig');
    // Something like https://eu-discoveryengine.googleapis.com/v1alpha - ie contains the region
    const rootUrl = await getSecretValue('AIBot', 'rootUrl');

    const oAuth2ClientOptions: Auth.OAuth2ClientOptions = {
      clientId: gcpClientId,
      clientSecret: gcpClientSecret,
      redirectUri: gcpRedirectUri
    };
    const oauth2Client = new Auth.OAuth2Client(oAuth2ClientOptions);
  
    oauth2Client.setCredentials({
      refresh_token: gcalRefreshToken
    });
    const options: discoveryengine_v1alpha.Options = {
      version: 'v1alpha',
      auth: oauth2Client,
      rootUrl
    };
    const discoveryengine = google.discoveryengine(options);
    const requestBody: discoveryengine_v1alpha.Schema$GoogleCloudDiscoveryengineV1alphaSearchRequest = {
      query: event.text,
      pageSize: 5,
      spellCorrectionSpec: {
        mode: "AUTO"
      },
      queryExpansionSpec: {
        condition: "AUTO"
      },
      contentSearchSpec: {
        // extractiveContentSpec: {
        //   maxExtractiveAnswerCount: 5
        // },
        summarySpec: {
          summaryResultCount: 5,
          ignoreAdversarialQuery: true,
          includeCitations: true
        },
        snippetSpec: {
          returnSnippet: true
        }
      }
    };
    const params: discoveryengine_v1alpha.Params$Resource$Projects$Locations$Collections$Datastores$Servingconfigs$Search = {
      servingConfig,
      requestBody
    };
    
    const searchResults = await discoveryengine.projects.locations.collections.dataStores.servingConfigs.search(params);
    console.log(`Search results: ${util.inspect(searchResults, false, null)}`);

    // Create some Slack blocks to display the results in a reasonable format
    const blocks: KnownBlock[] = [];
    
    // Summary first
    const summary = searchResults.data.summary;
    if(summary) {
      const sectionBlock: SectionBlock = {
        type: "section",
        text: {
          type: "mrkdwn",
          text: summary.summaryWithMetadata?.summary || "I don't know."
          // TODO put citations in here
        }
      };
      blocks.push(sectionBlock);
    }

    // Now the individual documents
    if(!searchResults.data.results) {
      const sectionBlock: SectionBlock = {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "No results returned for query"
        }
      };
      blocks.push(sectionBlock);
    }
    else {
      for(const result of searchResults.data.results) {
        if(result.document?.derivedStructData) {
          type Snippet = {
            snippet: string,
            snippet_status: "SUCCESS" | "NO_SNIPPET_AVAILABLE"
          };
          const snippets = result.document?.derivedStructData["snippets"] as Snippet[];
          let link = result.document?.derivedStructData["link"] as string;
          // The link is in form gs://datastore/documentname, eg gs://searchtest1-docs/Atom Bank JIRA AE-1 - AE-1175.pdf
          // We can turn that into a real link by changing the scheme and prepending the GCP storage domain.
          link = link.replace("gs://", "https://storage.cloud.google.com/");
          const title = result.document?.derivedStructData["title"] as string;
          // There only seems to be one snippet every time so just take the first.
          // They have <b></b> HTML bold tags in, so replace that with mrkdown * for bold.
          const snippet = snippets[0].snippet.replaceAll("<b>", "*").replaceAll("</b>", "*");
          const text = `<${link}|${title}>\n${snippet}`;
          const sectionBlock: SectionBlock = {
            type: "section",
            text: {
              type: "mrkdwn",
              text
            }
          };
          blocks.push(sectionBlock);
        }
      }
    }

    if(responseUrl) {
      // Use an ephemeral response if we've been called from the slash command.
      const responseType = event.command ? "ephemeral" : "in_channel";
      await postToResponseUrl(responseUrl, responseType, `Search results`, blocks);
    }
    else if(channelId) {
      await postMessage(channelId, `Search results`, blocks);
    }
  }
  catch (error) {
    console.error(error);
    if(responseUrl) {
      await postErrorMessageToResponseUrl(responseUrl, "Failed to call AI API");
    }
    else if(channelId) {
      await postEphmeralErrorMessage(channelId, event.user_id, "Failed to call AI API");
    }
  }
}