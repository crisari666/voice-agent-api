import * as express from 'express';
import type { Request, Response } from 'express';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Twilio } from 'twilio';
import * as fs from 'fs';
import * as path from 'path';
import type { ExpressServerConfig } from '../types/server-config';
import { WebsocketsHandler } from './websockets-handler';

export class VoiceAgentExpressServer {
  private readonly config: ExpressServerConfig;
  private readonly app: express.Application;
  private readonly server: http.Server;
  private readonly wss: WebSocketServer;
  private readonly twilioClient: Twilio;
  private readonly agentConfig: any;
  private readonly websocketsHandler: WebsocketsHandler;

  constructor(config: ExpressServerConfig) {
    
    this.config = config;
    this.app = express();
    this.server = http.createServer(this.app);
    
    this.websocketsHandler = new WebsocketsHandler();
    // Create WebSocket server with specific path to avoid conflicts
    this.wss = new WebSocketServer({ 
      server: this.server,
      path: '/twilio'  // Specify the path here
    });

    const accountSid = process.env.TWILIO_ACCOUNT_SID_PROD;
    const authToken = process.env.TWILIO_AUTH_TOKEN_PROD;
    const deepgramApiKey = process.env.DEEPGRAM_API_KEY;

    if (!accountSid || !authToken) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');
    }

    // if (!deepgramApiKey) {
    //   throw new Error('DEEPGRAM_API_KEY is required');
    // }

    this.twilioClient = new Twilio(accountSid, authToken);
    this.agentConfig = this.loadAgentConfig();

    this.setupExpressMiddleware();
    this.setupExpressRoutes();
    this.setupWebSocketHandlers();
  }

  private loadAgentConfig(): any {
    try {
      const configPath = path.join(process.cwd(), 'config_lotes.json');
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
    
    // Webhook endpoints
    this.app.post('/call-income', this.handleCallIncome.bind(this));
    this.app.post('/handle-fails', this.handleFails.bind(this));
    this.app.post('/status-change', this.handleStatusChange.bind(this));
    this.app.post('/status-change-2', this.handleStatusChange2.bind(this));
    this.app.post('/request', this.handleRequest.bind(this));
    this.app.post('/amd-status', this.handleAmdStatus.bind(this));
    
    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
  }

  private async handleRequest(req: Request, res: Response): Promise<void> {
    console.log('📥 Request received:', req.body);
    res.status(200).json({ status: 'ok' });
  }

  private async handleIniciarLlamada(req: Request, res: Response): Promise<void> {
    console.log('📞 Iniciando llamada...');
    
    const { websocketUrl, fromNumber, toNumber, ...additionalParams  } = req.body;
    const customerPhoneNumber = toNumber || process.env.CUSTOMER_PHONE_NUMBER;
    const twilioPhoneNumber = fromNumber || process.env.TWILIO_PHONE_NUMBER;

    if (!customerPhoneNumber || !twilioPhoneNumber) {
      res.status(500).send('Error: Phone numbers are required. Either provide fromNumber and toNumber in request body or set CUSTOMER_PHONE_NUMBER and TWILIO_PHONE_NUMBER environment variables');
      return;
    }
    console.log({websocketUrl, additionalParams});
    if (!websocketUrl) {
      res.status(400).send('Error: websocketUrl parameter is required');
      return;
    }

    try {
      // Build query parameters including websocketUrl and any additional params
      const queryParams = new URLSearchParams();
      queryParams.append('websocketUrl', websocketUrl);

      
      // Add any additional parameters from the request body
      Object.entries(additionalParams).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          queryParams.append(key, String(value));
        }
      });
      
      // const url = `${req.protocol}s://${req.get('host')}/twiml?${queryParams.toString()}`;
      // console.log('📞 URL:', url);
      console.log('🔗 Calling from:', twilioPhoneNumber, 'to:', customerPhoneNumber);

      const twiml = `
        <Response>
            <Say voice="alice" language="es-ES">Hola, esta es una llamada de prueba.</Say>
            <Connect>
            <Stream url="${websocketUrl}">
                ${Object.entries(additionalParams).map(([key, value]) => `<Parameter name="${key}" value="${value}" />`).join('\n')}
              </Stream>
            </Connect>
        </Response>
      `

      await this.twilioClient.calls.create({
        //url: url,
        to: customerPhoneNumber,
        from: twilioPhoneNumber,
        twiml: twiml,
        statusCallback: `${process.env.TWILIO_STATUS_CALLBACK_URL}/status-change-2`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['queued', 'no-answer', 'ringing', 'answered', 'canceled', 'failed', 'completed', 'busy'],

      }).then((call) => {
        console.log('📞 Llamada iniciada:', call.sid);
      }).catch((error) => {
        console.error('❌ Error al iniciar la llamada:', error);
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
    console.log('📋 All query parameters:', req.query);
    
    const twiml = `
      <Response>
          <Say voice="alice" language="es-ES"> Hola. </Say>
          <Connect>
            <Stream url="${encodeURIComponent(websocketUrl)}"/>
          </Connect>
      </Response>
    `;
    console.log({twiml});

    res.type('text/xml');
    res.send(twiml);
  }

  private handleWebhook(req: Request, res: Response): void {
    console.log('📥 Webhook received:', req.body);
    res.status(200).json({ status: 'ok' });
  }

  private handleCallIncome(req: Request, res: Response): void {
    console.log('📞 Call income received:', req.body);
    res.status(200).json({ status: 'ok' });
  }

  private handleFails(req: Request, res: Response): void {
    console.log('❌ Handle fails received:', req.body);
    res.status(200).json({ status: 'ok' });
  }

  private handleStatusChange(req: Request, res: Response): void {
    console.log('🔄 Status change received 2:', req.body);
    res.status(200).json({ status: 'ok' });
  }
  
  private handleStatusChange2(req: Request, res: Response): void {
    console.log('🔄 Status secod change received:', req.body);
    res.status(200).json({ status: 'ok' });
  }

  private handleAmdStatus(req: Request, res: Response): void {
    const { AnsweredBy, CallSid } = req.body;
    console.log(`🤖 AMD status for call ${CallSid}: ${AnsweredBy}`);

    if (AnsweredBy === 'machine_start') {
      console.log(`🤖 Answering machine detected for call ${CallSid}. Hanging up.`);
      this.twilioClient.calls(CallSid).update({ status: 'completed' })
        .then(call => console.log(`📞 Call ${call.sid} terminated.`))
        .catch(error => console.error(`❌ Error terminating call ${CallSid}:`, error));
    } else if (AnsweredBy === 'human') {
      console.log(`🧑 Human answered call ${CallSid}.`);
    }

    res.status(200).send('OK');
  }

  private setupWebSocketHandlers(): void {
    this.wss.on('connection', (ws: WebSocket) => {      
      const connectionTimeout = setTimeout(() => {
        console.log('⏰ WebSocket connection timeout');
        ws.close();
      }, 30000);
      this.websocketsHandler.handleTwilioConnection(ws, connectionTimeout, this.agentConfig);
    });

    this.wss.on('error', (error) => {
      console.error('❌ WebSocket server error:', error);
    });
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