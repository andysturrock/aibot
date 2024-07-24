import {
  Content,
  FunctionCall,
  Part,
  StartChatParams,
  TextPart
} from '@google-cloud/vertexai';
import * as dotenv from 'dotenv';
import readline from 'node:readline/promises';
import util from 'util';
import { callModelFunction, getGenerativeModel } from '../ts-src/handleAICommon';
import { _handlePromptCommand } from '../ts-src/handlePromptCommand';
import { PromptCommandPayload } from '../ts-src/slackAPI';
dotenv.config();

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function callCustomGroundedModel(prompt: string) {
  const functionCall: FunctionCall = {
    name: "call_custom_search_grounded_model",
    args: {prompt}
  };
  const functionResponse = await callModelFunction(functionCall);
  console.log(`functionResponse: ${util.inspect(functionResponse, false, null, true)}`);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function callGoogleGroundedModel(prompt: string) {
  const functionCall: FunctionCall = {
    name: "call_google_search_grounded_model",
    args: {prompt}
  };
  const functionResponse = await callModelFunction(functionCall);
  console.log(`functionResponse: ${util.inspect(functionResponse, false, null, true)}`);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function chat() {
  try {
    const generativeModel = await getGenerativeModel();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Do all this so we can copy/paste the main loop from handlePromptCommand
    let contentHistory: Content[] = [];
    const threadTs = "";
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    function getHistory(slackId: string, threadTs: string): Promise<Content[]> {
      return new Promise((resolve) => {
        resolve(contentHistory);
      });
    }
    const getHistoryFunction = getHistory;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    function putHistory(slackId: string, threadTs: string, newHistory: Content[]): Promise<void> {
      return new Promise((resolve) => {
        contentHistory = newHistory;
        resolve();
      });
    }
    const putHistoryFunction = putHistory;
    type Event = {
      user_id: string,
      text: string
    };
    const event: Event = {
      user_id: "",
      text: ""
    };

    event.text = await rl.question(`Input:`);
    while(event.text != "bye") {
      await handleEvent(event);
      event.text = await rl.question(`Input:`);
    }

    async function handleEvent(event: Event) {

      const startChatParams: StartChatParams = { };
      let history = await getHistoryFunction(event.user_id, threadTs);
      startChatParams.history = history;
      const chatSession = generativeModel.startChat(startChatParams);

      const textPart: TextPart = {
        text: event.text
      };
      let array = new Array<Part>();
      array.push(textPart);
      let response: string | undefined = undefined;
      while(response == undefined) {
        console.log(`array input to chat: ${util.inspect(array, false, null, true)}`);
        const generateContentResult = await chatSession.sendMessage(array);
        // await putHistory("andy_test", "test", history);

        const contentResponse = generateContentResult.response;
        console.log(`contentResponse: ${util.inspect(contentResponse, false, null, true)}`);
        response = contentResponse.candidates?.[0].content.parts[0].text;

        // reply and function calls should be mutually exclusive, but if we have a reply
        // then use that rather than call the functions.
        if(!response) {
          const functionCalls: FunctionCall[] = [];
          // if(contentResponse.candidates?.[0].content.parts) {
          contentResponse.candidates?.[0].content.parts.reduce((functionCalls, part) => {
          // console.log(`part: ${util.inspect(part, false, null, true)}`);
            if(part.functionCall) {
              functionCalls.push(part.functionCall);
            }
            return functionCalls;
          }, functionCalls);
          console.log(`functionCalls: ${util.inspect(functionCalls, false, null, true)}`);
          array = new Array<Part>();
          for (const functionCall of functionCalls) {
            console.log(`***** functionCall: ${util.inspect(functionCall, false, null, true)}`);
            const functionResponsePart = await callModelFunction(functionCall);
            console.log(`functionResponsePart: ${util.inspect(functionResponsePart, false, null, true)}`);
            array.push(functionResponsePart);
          }
        }
      }
      history = await chatSession.getHistory();
      await putHistoryFunction(event.user_id, threadTs, history);
      console.log(`response: <<<${response}>>>`);
    }
  }
  catch(error) {
    console.log(`Error: ${util.inspect(error, false, null, true)}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function testHandlePromptCommand() {
  const event: PromptCommandPayload = {
    user_id: '',
    text: '',
    bot_id: '',
    bot_user_id: '',
    team_id: '',
    thread_ts: '1'
  };
  let history: Content[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function getHistory(slackId: string, threadTs: string): Promise<Content[]> {
    return new Promise((resolve) => {
      resolve(history);
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function putHistory(slackId: string, threadTs: string, newHistory: Content[]): Promise<void> {
    return new Promise((resolve) => {
      history = newHistory;
      resolve();
    });
  }
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let text = await rl.question(`Input:`);
  while(text != "bye") {
    event.text = text;
    await _handlePromptCommand(event, getHistory, putHistory);
    text = await rl.question(`Input:`);
  }
}

// void chat();
// void callCustomGroundedModel("What is the daily meal rate for expenses?");
// void callGoogleGroundedModel("You are the CTO of a digital bank. Write a paper for the board advising them about AI and the approach the bank should take in adopting it.");
void testHandlePromptCommand();
