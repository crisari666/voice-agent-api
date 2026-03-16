import type { WebSocket } from 'ws';
import type { DeepgramClient } from '@deepgram/sdk';
import { TwilioAudioProcessor, type DeepgramAudioSender } from '../types/twilio-audio-processor';
import { FUNCTION_MAP } from '../config/function-map';

/** Options for handling a single call over WebSocket (Twilio <-> Deepgram Agent). */
export interface CallWebSocketHandlerOptions {
  agentConfig: Record<string, unknown>;
  deepgramClient: DeepgramClient;
}

type AgentConnection = {
  readyState: number;
  sendSettings: (msg: unknown) => void;
  sendMedia: (chunk: Buffer) => void;
  sendFunctionCallResponse: (msg: unknown) => void;
  on: (event: string, cb: (data: unknown) => void) => void;
  connect: () => void;
  waitForOpen: () => Promise<unknown>;
  close: () => void;
  socket?: { addEventListener: (t: string, h: (ev: { data: unknown }) => void) => void };
};

/**
 * Handles all logic for a single call: Twilio WebSocket connection and Deepgram Agent.
 * Uses the same receive/send pattern as the sample: parse Twilio JSON, handle connected/start/media events.
 */
export async function handleCallWebSocket(
  ws: WebSocket,
  connectionTimeout: NodeJS.Timeout,
  options: CallWebSocketHandlerOptions
): Promise<void> {
  const { agentConfig, deepgramClient } = options;

  try {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      throw new Error('DEEPGRAM_API_KEY is required for voice agent');
    }

    const deepgramConnection = (await deepgramClient.agent.v1.connect({
      Authorization: `Token ${apiKey}`,
    })) as AgentConnection;

    const audioProcessor = new TwilioAudioProcessor({
      bufferSize: 20 * 160,
    });

    const sendAdapter: DeepgramAudioSender = {
      get readyState() {
        return deepgramConnection.readyState;
      },
      send(chunk: Buffer) {
        if (deepgramConnection.readyState === 1) {
          deepgramConnection.sendMedia(chunk);
        }
      },
    };

    deepgramConnection.on('open', () => {
      console.log('✅ Conexión con Deepgram establecida (SDK 5.0).');
      clearTimeout(connectionTimeout);
      console.log('📤 Sending agent config to Deepgram...');
      deepgramConnection.sendSettings(agentConfig);
    });

    const forwardAudioToTwilio = (raw: Buffer | ArrayBuffer | Uint8Array): void => {
      const currentStreamSid = audioProcessor.getStreamSid();
      if (!currentStreamSid) return;
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      ws.send(
        JSON.stringify({
          event: 'media',
          streamSid: currentStreamSid,
          media: { payload: buf.toString('base64') },
        })
      );
    };

    const underlyingSocket = deepgramConnection.socket;
    if (underlyingSocket?.addEventListener) {
      underlyingSocket.addEventListener('message', (ev: { data: unknown }) => {
        if (typeof ev.data === 'string') return;
        const d = ev.data;
        if (
          Buffer.isBuffer(d) ||
          d instanceof ArrayBuffer ||
          (typeof Uint8Array !== 'undefined' && d instanceof Uint8Array)
        ) {
          forwardAudioToTwilio(d as Buffer | ArrayBuffer | Uint8Array);
        }
      });
    }

    deepgramConnection.on('message', async (data: Buffer) => {
      try {
        const messageStr = data.toString();
        //console.log('🎤 Received from Deepgram:', messageStr);
        const message = JSON.parse(messageStr);
        //console.log('🎤 Received from Deepgram:', messageStr);
        
        // Handle text messages (like Python sts_receiver)
        if (typeof message === 'object') {
          await this.handleTextMessage(message, ws, deepgramConnection, audioProcessor.getStreamSid());
        }
      } catch (error) {
        // If it's not JSON, it's raw audio data from Deepgram (like Python)
        //console.log('🎤 Received raw audio from Deepgram');
        const currentStreamSid = audioProcessor.getStreamSid();
        console.log('🎤 Current stream SID:', currentStreamSid);
        if (currentStreamSid) {
          console.log('🎤 Sending media message to Twilio');
          const mediaMessage = {
            event: 'media',
            streamSid: currentStreamSid,
            media: {
              payload: data.toString('base64')
            }
          };
          ws.send(JSON.stringify(mediaMessage));
        }
      }
      
      // try {
      //   const isBinary =
      //     Buffer.isBuffer(data) ||
      //     data instanceof ArrayBuffer ||
      //     (typeof Uint8Array !== 'undefined' && data instanceof Uint8Array);

      //   console.log('🎤 Received from Deepgram:', {data});

      //   if (isBinary) {
      //     forwardAudioToTwilio(data as Buffer | ArrayBuffer | Uint8Array);
      //     return;
      //   }

      //   const message =
      //     typeof data === 'object' && data !== null
      //       ? (data as Record<string, unknown>)
      //       : (JSON.parse(data as string) as Record<string, unknown>);
      //   console.log('🎤 Received from Deepgram:', message);
      //   await handleTextMessage(message, ws, deepgramConnection, audioProcessor.getStreamSid());
      // } catch {
      //   console.log('🎤 Received raw audio from Deepgram');
      //   if (Buffer.isBuffer(data)) {
      //     const currentStreamSid = audioProcessor.getStreamSid();
      //     if (currentStreamSid) {
      //       ws.send(
      //         JSON.stringify({
      //           event: 'media',
      //           streamSid: currentStreamSid,
      //           media: { payload: (data as Buffer).toString('base64') },
      //         })
      //       );
      //     }
      //   }
      // }
    });

    deepgramConnection.on('close', () => {
      console.log('🚪 Conexión con Deepgram cerrada.');
    });

    deepgramConnection.on('error', (error: unknown) => {
      console.error('❌ Deepgram connection error:', error);
    });

    deepgramConnection.connect();
    await deepgramConnection.waitForOpen();

    ws.on('message', (data: Buffer | ArrayBuffer) => {
      try {
        const raw = typeof data === 'string' ? data : data.toString();
        const twilioMessage = JSON.parse(raw) as { event?: string; start?: { streamSid: string }; media?: { track?: string; payload?: string } };

        if (twilioMessage.event === 'connected' || twilioMessage.event === 'start') {
          console.log('Received Twilio connected or start event');
        }
        if (twilioMessage.event === 'media') {
          console.log('Received Twilio media event');
        }

        audioProcessor.processMessage({ type: 'utf8', utf8Data: raw }, sendAdapter);
      } catch (error) {
        console.error('❌ Error processing Twilio message:', error);
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      console.log('🔌 Cliente de Twilio desconectado. Code:', code, 'Reason:', reason.toString());
      deepgramConnection.close();
    });

    ws.on('error', (error: Error) => {
      console.error('❌ Error en WebSocket de Twilio:', error);
      clearTimeout(connectionTimeout);
    });
  } catch (error) {
    console.error('❌ Error in call WebSocket handler:', error);
    clearTimeout(connectionTimeout);
  }
}

async function handleTextMessage(
  message: Record<string, unknown>,
  twilioWs: WebSocket,
  deepgramConnection: AgentConnection,
  streamSid: string | null
): Promise<void> {
  if (message.type === 'UserStartedSpeaking') {
    console.log('🎤 User started speaking');
    if (streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: 'clear',
          streamSid,
        })
      );
    }
  }

  if (message.type === 'FunctionCallRequest') {
    await handleFunctionCallRequest(message, deepgramConnection);
  }
}

async function handleFunctionCallRequest(
  message: { functions?: Array<{ name: string; id: string; arguments: string }> },
  deepgramConnection: AgentConnection
): Promise<void> {
  try {
    const functions = message.functions ?? [];
    for (const functionCall of functions) {
      const funcName = functionCall.name;
      const funcId = functionCall.id;
      const arguments_ = JSON.parse(functionCall.arguments);

      console.log(`Function call: ${funcName} (ID: ${funcId}), arguments:`, arguments_);

      let result: unknown;
      if (funcName in FUNCTION_MAP) {
        result = FUNCTION_MAP[funcName](arguments_);
        console.log('Function call result:', result);
      } else {
        result = { error: `Unknown function: ${funcName}` };
        console.log(result);
      }

      deepgramConnection.sendFunctionCallResponse({
        type: 'FunctionCallResponse',
        id: funcId,
        name: funcName,
        content: JSON.stringify(result),
      });
      console.log('Sent function result');
    }
  } catch (error) {
    console.error('Error calling function:', error);
    deepgramConnection.sendFunctionCallResponse({
      type: 'FunctionCallResponse',
      id: 'unknown',
      name: 'unknown',
      content: JSON.stringify({ error: `Function call failed with: ${error}` }),
    });
  }
}
