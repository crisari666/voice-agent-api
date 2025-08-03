import 'dotenv/config';
import * as express from 'express';
import type { Request, Response } from 'express';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Twilio } from 'twilio';
import * as fs from 'fs';
import * as path from 'path';
import type { 
  ServerConfig, 
  TwilioMessage, 
  MediaMessage, 
  ClearMessage
} from './types';

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
  private readonly agentConfig: any;

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

    if (!accountSid || !authToken) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');
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
              Hola, de Crédito. </Say>
          <Connect>
            <Stream url="${wsUrl}/stream"/>
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
      let streamSid: string | null = null;

      ws.on('message', (message: Buffer) => {
        try {
          const messageStr = message.toString();
          const twilioMessage = JSON.parse(messageStr);
          
          console.log('🔍 Received from Twilio:', twilioMessage.event);
          
          switch (twilioMessage.event) {
            case 'start':
              streamSid = twilioMessage.start?.streamSid;
              console.log('🎬 Stream started:', streamSid);
              break;
            case 'media':
              console.log('Track data:', twilioMessage.media.track);
              if (twilioMessage.media?.track === 'inbound') {
                const audioChunk = Buffer.from(twilioMessage.media.payload, 'base64');
                console.log('🎵 Received audio chunk:', audioChunk.length, 'bytes');
                
                // Here you can forward the audio to your Python service
                // For now, we'll just log the audio data
                this.forwardAudioToPythonService(audioChunk, streamSid);
              }
              break;
            case 'stop':
              console.log('⏹️ Stream stopped');
              break;
            case 'connected':
              console.log('🔗 Stream connected');
              break;
          }
        } catch (error) {
          console.error('❌ Error processing Twilio message:', error);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        console.log('🔌 Cliente de Twilio desconectado. Code:', code, 'Reason:', reason.toString());
        clearTimeout(connectionTimeout);
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

  private forwardAudioToPythonService(audioChunk: Buffer, streamSid: string | null): void {
    // TODO: Implement forwarding to Python service
    // This is where you would send the audio data to your Python Deepgram service
    console.log('📤 Forwarding audio to Python service...');
    
    // Example implementation:
    // - Send audio chunk to Python service via HTTP POST or WebSocket
    // - Handle responses from Python service
    // - Forward processed audio back to Twilio if needed
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