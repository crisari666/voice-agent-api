import { WebSocket } from 'ws';

export interface TwilioAudioProcessorConfig {
  readonly bufferSize: number;
}

export class TwilioAudioProcessor {
  private readonly config: TwilioAudioProcessorConfig;
  private inBuffer: Buffer;
  private streamSid: string | null;

  constructor(config: TwilioAudioProcessorConfig) {
    this.config = config;
    this.inBuffer = Buffer.alloc(0);
    this.streamSid = null;
  }

  public processMessage(message: any, deepgramConnection: WebSocket): void {
    if (message.type === 'utf8') {
      const data = JSON.parse(message.utf8Data);
      this.handleTwilioEvent(data, deepgramConnection);
    }
  }

  private handleTwilioEvent(data: any, deepgramConnection: WebSocket): void {
    switch (data.event) {
      case 'connected':
        // Continue like Python code
        break;
      case 'start':
        console.log('get our streamsid');
        const start = data.start;
        this.streamSid = start.streamSid;
        break;
      case 'media':
        this.handleMediaEvent(data, deepgramConnection);
        break;
      case 'stop':
        break;
      default:
        console.log('Unknown event:', data.event);
    }
  }

  private handleMediaEvent(data: any, deepgramConnection: WebSocket): void {
    const media = data.media;
    if (media.track === 'inbound') {
      const chunk = Buffer.from(media.payload, 'base64');
      this.inBuffer = Buffer.concat([this.inBuffer, chunk]);
      
      // Process buffer when we have enough data (exactly like Python)
      while (this.inBuffer.length >= this.config.bufferSize) {
        const audioChunk = this.inBuffer.slice(0, this.config.bufferSize);
        this.inBuffer = this.inBuffer.slice(this.config.bufferSize);
        
        // Send raw audio chunk to Deepgram (like Python)
        if (deepgramConnection.readyState === WebSocket.OPEN) {
          deepgramConnection.send(audioChunk);
        }
      }
    }
  }

  public getStreamSid(): string | null {
    return this.streamSid;
  }
} 