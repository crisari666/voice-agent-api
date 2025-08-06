import * as express from 'express';
import type { Request, Response } from 'express';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Twilio } from 'twilio';
import * as fs from 'fs';
import * as path from 'path';
import type { FunctionMap } from '../types';
import type { ExpressServerConfig } from '../types/server-config';
import { TwilioAudioProcessor } from '../types/twilio-audio-processor';
import { FUNCTION_MAP } from '../config/function-map';

export class VoiceAgentExpressServer {
  private readonly config: ExpressServerConfig;
  private readonly app: express.Application;
  private readonly server: http.Server;
  private readonly wss: WebSocketServer;
  private readonly twilioClient: Twilio;
  private readonly agentConfig: any;

  constructor(config: ExpressServerConfig) {
    this.config = config;
    this.app = express();
    this.server = http.createServer(this.app);
    
    // Create WebSocket server with specific path to avoid conflicts
    this.wss = new WebSocketServer({ 
      server: this.server,
      path: '/twilio'  // Specify the path here
    });

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const deepgramApiKey = process.env.DEEPGRAM_API_KEY;

    if (!accountSid || !authToken) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');
    }

    if (!deepgramApiKey) {
      throw new Error('DEEPGRAM_API_KEY is required');
    }

    this.twilioClient = new Twilio(accountSid, authToken);
    this.agentConfig = this.loadAgentConfig();

    this.setupExpressMiddleware();
    this.setupExpressRoutes();
    this.setupWebSocketHandlers();
  }

  private loadAgentConfig(): any {
    try {
      const configPath = path.join(process.cwd(), 'config.json');
      const configData = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      console.error('❌ Error loading config.json:', error);
      throw new Error('Failed to load agent configuration');
    }
  }

  private setupExpressMiddleware(): void {
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(express.json());
  }

  private setupExpressRoutes(): void {
    this.app.post('/iniciar-llamada', this.handleIniciarLlamada.bind(this));
    this.app.post('/twiml', this.handleTwiML.bind(this));
    
    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
  }

  private async handleIniciarLlamada(req: Request, res: Response): Promise<void> {
    console.log('📞 Iniciando llamada...');
    
    const { websocketUrl, fromNumber, toNumber } = req.body;
    const customerPhoneNumber = toNumber || process.env.CUSTOMER_PHONE_NUMBER;
    const twilioPhoneNumber = fromNumber || process.env.TWILIO_PHONE_NUMBER;

    if (!customerPhoneNumber || !twilioPhoneNumber) {
      res.status(500).send('Error: Phone numbers are required. Either provide fromNumber and toNumber in request body or set CUSTOMER_PHONE_NUMBER and TWILIO_PHONE_NUMBER environment variables');
      return;
    }

    if (!websocketUrl) {
      res.status(400).send('Error: websocketUrl parameter is required');
      return;
    }

    try {
      console.log('📞 URL:', websocketUrl);
      console.log('🔗 Calling from:', twilioPhoneNumber, 'to:', customerPhoneNumber);
      await this.twilioClient.calls.create({
        url: websocketUrl,
        to: customerPhoneNumber,
        from: twilioPhoneNumber,
      });
      res.send('Llamada iniciada. Revisa tu teléfono.');
    } catch (error) {
      console.error('❌ Error al iniciar la llamada:', error);
      res.status(500).send('Error al iniciar la llamada.');
    }
  }

  private handleTwiML(req: Request, res: Response): void {
    console.log('📄 Generando TwiML para la llamada...');
    
    const websocketUrl = req.query.websocketUrl as string;
    
    if (!websocketUrl) {
      console.error('❌ Error: websocketUrl parameter is required');
      res.status(400).send('Error: websocketUrl parameter is required');
      return;
    }
    
    console.log('🔗 WebSocket URL for TwiML:', websocketUrl);
    
    const twiml = `
      <Response>
          <Say voice="alice" language="es-ES"> Hola. </Say>
          <Connect>
            <Stream url="${decodeURIComponent(websocketUrl)}"/>
          </Connect>
      </Response>
    `;
    console.log({twiml});

    res.type('text/xml');
    res.send(twiml);
  }

  private setupWebSocketHandlers(): void {
    this.wss.on('connection', (ws: WebSocket, req: any) => {
      console.log('🔗 Cliente de Twilio conectado al WebSocket.');
      
      const connectionTimeout = setTimeout(() => {
        console.log('⏰ WebSocket connection timeout');
        ws.close();
      }, 30000);
      
      this.handleTwilioConnection(ws, connectionTimeout);
    });

    this.wss.on('error', (error) => {
      console.error('❌ WebSocket server error:', error);
    });
  }

  private async handleTwilioConnection(ws: WebSocket, connectionTimeout: NodeJS.Timeout): Promise<void> {
    try {
      const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
      
      // Connect to Deepgram using the correct authentication method
      const deepgramConnection = new WebSocket('wss://agent.deepgram.com/v1/agent/converse', ['token', deepgramApiKey!]);

      // Initialize Twilio audio processor with optimized settings
      const audioProcessor = new TwilioAudioProcessor({
        bufferSize: 20 * 160, // Same as Python BUFFER_SIZE
      });
      
      deepgramConnection.on('open', () => {
        console.log('✅ Conexión con Deepgram establecida.');
        clearTimeout(connectionTimeout);

        // Send the agent configuration to Deepgram
        console.log('📤 Sending agent config to Deepgram...');
        deepgramConnection.send(JSON.stringify(this.agentConfig));
      });

      deepgramConnection.on('message', async (data: Buffer) => {
        try {
          const messageStr = data.toString();
          const message = JSON.parse(messageStr);
          console.log('🎤 Received from Deepgram:', message);
          
          // Handle text messages (like Python sts_receiver)
          if (typeof message === 'object') {
            await this.handleTextMessage(message, ws, deepgramConnection, audioProcessor.getStreamSid());
          }
        } catch (error) {
          // If it's not JSON, it's raw audio data from Deepgram (like Python)
          console.log('🎤 Received raw audio from Deepgram');
          const currentStreamSid = audioProcessor.getStreamSid();
          if (currentStreamSid) {
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
      });

      deepgramConnection.on('close', () => {
        console.log('🚪 Conexión con Deepgram cerrada.');
      });

      deepgramConnection.on('error', (error) => {
        console.error('❌ Deepgram connection error:', error);
      });

      ws.on('message', (message: Buffer) => {
        try {
          // Convert Buffer message to the format expected by TwilioAudioProcessor
          const messageObj = {
            type: 'utf8',
            utf8Data: message.toString()
          };
          
          // Process the message using the audio processor (like Python twilio_receiver)
          audioProcessor.processMessage(messageObj, deepgramConnection);
          
        } catch (error) {
          console.error('❌ Error processing Twilio message:', error);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        console.log('🔌 Cliente de Twilio desconectado. Code:', code, 'Reason:', reason.toString());
        deepgramConnection.close();
      });

      ws.on('error', (error) => {
        console.error('❌ Error en WebSocket de Twilio:', error);
        clearTimeout(connectionTimeout);
      });
    } catch (error) {
      console.error('❌ Error in Twilio connection handler:', error);
      clearTimeout(connectionTimeout);
    }
  }

  private async handleTextMessage(message: any, twilioWs: WebSocket, deepgramConnection: WebSocket, streamSid: string | null): Promise<void> {
    // Handle barge-in (like Python handle_barge_in)
    if (message.type === 'UserStartedSpeaking') {
      console.log('🎤 User started speaking');
      if (streamSid) {
        const clearMessage = {
          event: 'clear',
          streamSid: streamSid
        };
        twilioWs.send(JSON.stringify(clearMessage));
      }
    }

    // Handle function call requests (like Python handle_function_call_request)
    if (message.type === 'FunctionCallRequest') {
      await this.handleFunctionCallRequest(message, deepgramConnection);
    }
  }

  private async handleFunctionCallRequest(message: any, deepgramConnection: WebSocket): Promise<void> {
    try {
      for (const functionCall of message.functions) {
        const funcName = functionCall.name;
        const funcId = functionCall.id;
        const arguments_ = JSON.parse(functionCall.arguments);

        console.log(`Function call: ${funcName} (ID: ${funcId}), arguments:`, arguments_);

        let result: any;
        if (funcName in FUNCTION_MAP) {
          result = FUNCTION_MAP[funcName](arguments_);
          console.log('Function call result:', result);
        } else {
          result = { error: `Unknown function: ${funcName}` };
          console.log(result);
        }

        const functionResult = {
          type: 'FunctionCallResponse',
          id: funcId,
          name: funcName,
          content: JSON.stringify(result)
        };

        deepgramConnection.send(JSON.stringify(functionResult));
        console.log('Sent function result:', functionResult);
      }
    } catch (error) {
      console.error('Error calling function:', error);
      const errorResult = {
        type: 'FunctionCallResponse',
        id: 'unknown',
        name: 'unknown',
        content: JSON.stringify({ error: `Function call failed with: ${error}` })
      };
      deepgramConnection.send(JSON.stringify(errorResult));
    }
  }

  public start(): void {
    const port = this.config.expressPort;
    this.server.listen(port, () => {
      console.log('📝 Ready to process voice commands...');
    });
  }

  public stop(): void {
    console.log('🛑 Voice Agent Express Server stopped');
    this.server.close();
    this.wss.close();
  }
} 