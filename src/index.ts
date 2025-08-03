import 'dotenv/config';
import * as express from 'express';
import type { Request, Response } from 'express';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Twilio } from 'twilio';
import { AgentEvents, createClient, DeepgramClient } from '@deepgram/sdk';
import type { 
  ServerConfig, 
  FunctionCall, 
  FunctionCallResponse, 
  TwilioMessage, 
  MediaMessage, 
  ClearMessage, 
  FunctionMap 
} from './types';

const FUNCTION_MAP: FunctionMap = {
  // Add your pharmacy functions here
  // Example:
  // getMedicationInfo: (medicationName: string) => ({ name: medicationName, dosage: "10mg" })
};

interface ExpressServerConfig extends ServerConfig {
  readonly expressPort: number;
  readonly ngrokUrl?: string;
}

class VoiceAgentExpressServer {
  private readonly config: ExpressServerConfig;
  private readonly app: express.Application;
  private readonly server: http.Server;
  private readonly wss: WebSocketServer;
  private readonly twilioClient: Twilio;
  private readonly deepgramWebSocket: WebSocket;
  private readonly deepgramClient: DeepgramClient;

  constructor(config: ExpressServerConfig) {
    this.config = config;
    this.app = express();
    this.server = http.createServer(this.app);
    
    // Create WebSocket server with specific path to avoid conflicts
    this.wss = new WebSocketServer({ 
      server: this.server,
      path: '/stream'  // Specify the path here
    });

    
    
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const deepgramApiKey = process.env.DEEPGRAM_API_KEY;

    //console.log({accountSid, authToken, deepgramApiKey});

    if (!accountSid || !authToken) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');
    }

    if (!deepgramApiKey) {
      throw new Error('DEEPGRAM_API_KEY is required');
    }

    this.twilioClient = new Twilio(accountSid, authToken);

    this.setupExpressMiddleware();
    this.setupExpressRoutes();
    this.setupWebSocketHandlers();
  }


  private setupExpressMiddleware(): void {
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(express.json());
    
    // Remove CORS middleware that might interfere with WebSocket upgrade
    // Only add CORS for specific routes that need it
  }

  private setupExpressRoutes(): void {
    this.app.post('/iniciar-llamada', this.handleIniciarLlamada.bind(this));
    this.app.post('/twiml', this.handleTwiML.bind(this));
    
    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
    
    // Remove the /ws GET route as it might interfere with WebSocket upgrade
  }

  private async handleIniciarLlamada(req: Request, res: Response): Promise<void> {
    console.log('📞 Iniciando llamada...');
    
    const ngrokUrl = this.config.ngrokUrl;
    const customerPhoneNumber = process.env.CUSTOMER_PHONE_NUMBER;
    const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

    if (!customerPhoneNumber || !twilioPhoneNumber) {
      res.status(500).send('Error: CUSTOMER_PHONE_NUMBER and TWILIO_PHONE_NUMBER are required');
      return;
    }

    try {
      await this.twilioClient.calls.create({
        url: `${ngrokUrl}/twiml`,
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
    
    const ngrokUrl = this.config.ngrokUrl;

    console.log({ngrokUrl});

    
    let wsUrl: string;
    
    if (ngrokUrl.startsWith('https://')) {
      wsUrl = ngrokUrl.replace('https://', 'wss://');
    } else if (ngrokUrl.startsWith('http://')) {
      wsUrl = ngrokUrl.replace('http://', 'ws://');
    } else {
      wsUrl = `wss://${ngrokUrl}`;
    }
    
    console.log('🔗 WebSocket URL for TwiML:', `${wsUrl}`);
    
    const twiml = `
      <Response>
          <Say voice="alice" language="es-ES">
              Hola, te llamamos de la Cooperativa de Crédito. </Say>
          <Connect>
            <Stream url="${wsUrl}/stream" />
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
    
    this.wss.on('headers', (headers) => {
      //console.log('📋 WebSocket response headers:', headers);
    });
  }

  private async handleTwilioConnection(ws: WebSocket, connectionTimeout: NodeJS.Timeout): Promise<void> {
    try {

      const deepgramConnection = new WebSocket('wss://agent.deepgram.com/v1/agent/converse',
        {headers: {'Authorization': `token 72a3fd0225d4010cdd4c7522bf349482a3eaa10b`}}
      );

      deepgramConnection.on('open', () => {
        console.log('✅ Conexión con Deepgram establecida.');
        clearTimeout(connectionTimeout);

        deepgramConnection.send()

        deepgramConnection.on('message', (data: any) => {
          console.log({data});
          
          const transcript = data.channel.alternatives[0].transcript;
          if (transcript) {
            console.log('🎤 Transcripción:', transcript);
            this.handleTranscript(transcript);
          }
        });

        deepgramConnection.on('close', () => {
          console.log('🚪 Conexión con Deepgram cerrada.');
        });

        deepgramConnection.on('error', (error) => {
          console.error('❌ Deepgram connection error:', error);
        });

        ws.on('message', (message: string) => {
          try {
            console.log('🔍 Received message from Twilio');
            const twilioMessage = JSON.parse(message);
            
            if (twilioMessage.event === 'media') {
              const audio = Buffer.from(twilioMessage.media.payload, 'base64');
              // Convert Uint8Array to ArrayBuffer for Deepgram compatibility
              const audioData = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
              deepgramConnection.send(audioData);
            } else if (twilioMessage.event === 'start') {
              console.log('🎬 Stream started:', twilioMessage.start?.streamSid);
            } else if (twilioMessage.event === 'stop') {
              console.log('⏹️ Stream stopped');
            }
          } catch (error) {
            console.error('❌ Error processing Twilio message:', error);
          }
        });

        ws.on('close', (code: number, reason: Buffer) => {
          console.log('🔌 Cliente de Twilio desconectado. Code:', code, 'Reason:', reason.toString());
          deepgramConnection.close();
        });
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

  private handleTranscript(transcript: string): void {
    // ✨ Aquí va tu lógica de negocio.
    // Ejemplo: if (transcript.includes("saldo")) { /* responder con el saldo */ }
    console.log('🎯 Procesando transcripción:', transcript);
  }

  public start(): void {
    const port = this.config.expressPort;
    this.server.listen(port, () => {
      // console.log(`🚀 Servidor Express escuchando en http://localhost:${port}`);
      // console.log(`🔗 WebSocket endpoint disponible en ws://localhost:${port}/ws`);
      // console.log(`🏥 Health check disponible en http://localhost:${port}/health`);
      console.log('📝 Ready to process voice commands...');
    });
  }

  public stop(): void {
    console.log('🛑 Voice Agent Express Server stopped');
    this.server.close();
    this.wss.close();
  }
}

const main = (): void => {
  const serverConfig: ExpressServerConfig = {
    port: 8881,
    host: 'localhost',
    expressPort: parseInt(process.env.PORT || '8881'),
    ngrokUrl: process.env.NGROK_URL
  };

  const server = new VoiceAgentExpressServer(serverConfig);
  server.start();

  // Graceful shutdown handling
  process.on('SIGINT', () => {
    console.log('\n🔄 Received SIGINT, shutting down gracefully...');
    server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n🔄 Received SIGTERM, shutting down gracefully...');
    server.stop();
    process.exit(0);
  });
};

main(); 