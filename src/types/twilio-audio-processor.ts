import { WebSocket } from 'ws';

export interface TwilioAudioProcessorConfig {
  readonly bufferSize: number;
  readonly minChunkSize: number;
  readonly noiseThreshold: number;
}

export class TwilioAudioProcessor {
  private readonly config: TwilioAudioProcessorConfig;
  private readonly inBuffer: Buffer[];
  private hasSeenMedia: boolean;
  private messageCount: number;
  private isProcessingAudio: boolean;
  private streamSid: string | null;

  constructor(config: TwilioAudioProcessorConfig) {
    this.config = config;
    this.inBuffer = [];
    this.hasSeenMedia = false;
    this.messageCount = 0;
    this.isProcessingAudio = false;
    this.streamSid = null;
  }

  public processMessage(message: any, deepgramConnection: WebSocket): void {
    if (message.type === 'utf8') {
      const data = JSON.parse(message.utf8Data);
      this.handleTwilioEvent(data, deepgramConnection);
      this.messageCount++;
    } else if (message.type === 'binary') {
      console.log('Media WS: binary message received (not supported)');
    }
  }

  private handleTwilioEvent(data: any, deepgramConnection: WebSocket): void {
    console.log('Media WS: Event received:', data);
    switch (data.event) {
      case 'connected':
        console.log('Media WS: Connected event received:', data);
        break;
      case 'start':
        console.log('Media WS: Start event received:', data);
        this.streamSid = data.start?.streamSid;
        break;
      case 'media':
        this.handleMediaEvent(data, deepgramConnection);
        break;
      case 'stop':
        console.log('Media WS: Stop event received:', data);
        this.resetState();
        break;
      default:
        console.log('Media WS: Unknown event:', data.event);
    }
  }

  private handleMediaEvent(data: any, deepgramConnection: WebSocket): void {
    if (!this.hasSeenMedia) {
      console.log('Media WS: Media event received:', data);
      console.log('Media WS: Suppressing additional messages...');
      this.hasSeenMedia = true;
    }

    if (data.media?.track === 'inbound' && !this.isProcessingAudio) {
      this.isProcessingAudio = true;
      
      try {
        const audioChunk = Buffer.from(data.media.payload, 'base64');
        
        // Only process audio chunks that are not too small (likely silence)
        if (audioChunk.length > this.config.minChunkSize) {
          // Validate audio format before processing
          if (this.isValidAudioChunk(audioChunk)) {
            this.inBuffer.push(audioChunk);
            
            // Process buffer when we have enough data
            while (this.getBufferSize() >= this.config.bufferSize) {
              const chunk = this.extractChunk(this.config.bufferSize);
              if (chunk) {
                // Apply noise reduction preprocessing
                const processedChunk = this.preprocessAudio(chunk);
                if (processedChunk.length > 0) {
                  // Only send audio if Deepgram connection is ready
                  if (this.isDeepgramReady(deepgramConnection)) {
                    try {
                      deepgramConnection.send(processedChunk);
                      console.log('🎵 Sent processed audio chunk:', processedChunk.length, 'bytes');
                    } catch (sendError) {
                      console.error('❌ Error sending audio to Deepgram:', sendError);
                    }
                  } else {
                    console.log('⏳ Skipping audio - Deepgram not ready');
                  }
                } else {
                  console.log('🔇 Skipped silent audio chunk');
                }
              }
            }
          } else {
            console.log('🔇 Skipped invalid audio chunk');
          }
        } else {
          console.log('🔇 Skipped small audio chunk:', audioChunk.length, 'bytes');
        }
      } catch (error) {
        console.error('❌ Error processing audio chunk:', error);
      } finally {
        this.isProcessingAudio = false;
      }
    }
  }

  private getBufferSize(): number {
    return this.inBuffer.reduce((total, chunk) => total + chunk.length, 0);
  }

  private extractChunk(size: number): Buffer | null {
    let totalSize = 0;
    let chunkCount = 0;
    
    // Count how many chunks we need
    for (let i = 0; i < this.inBuffer.length; i++) {
      totalSize += this.inBuffer[i].length;
      if (totalSize >= size) {
        chunkCount = i + 1;
        break;
      }
    }
    
    if (chunkCount === 0) return null;
    
    // Extract the chunks
    const chunks = this.inBuffer.splice(0, chunkCount);
    const result = Buffer.concat(chunks);
    
    // If we have more data than needed, put the excess back
    if (result.length > size) {
      const excess = result.slice(size);
      this.inBuffer.unshift(excess);
      return result.slice(0, size);
    }
    
    return result;
  }

  private preprocessAudio(audioBuffer: Buffer): Buffer {
    // Simple noise gate: remove very quiet audio that's likely noise
    const threshold = this.config.noiseThreshold;
    
    try {
      // Convert buffer to 16-bit PCM samples for processing
      const samples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.length / 2);
      const processedSamples = new Int16Array(samples.length);
      
      let hasSignificantAudio = false;
      let maxAmplitude = 0;
      
      // Find the maximum amplitude in the buffer
      for (let i = 0; i < samples.length; i++) {
        const amplitude = Math.abs(samples[i]);
        if (amplitude > maxAmplitude) {
          maxAmplitude = amplitude;
        }
      }
      
      // Apply noise gate with dynamic threshold
      const gateThreshold = Math.max(maxAmplitude * threshold, 100); // Minimum threshold
      
      for (let i = 0; i < samples.length; i++) {
        const amplitude = Math.abs(samples[i]);
        if (amplitude > gateThreshold) {
          processedSamples[i] = samples[i];
          hasSignificantAudio = true;
        } else {
          processedSamples[i] = 0; // Silence noise
        }
      }
      
      // If no significant audio was found, return empty buffer
      if (!hasSignificantAudio) {
        return Buffer.alloc(0);
      }
      
      return Buffer.from(processedSamples.buffer);
    } catch (error) {
      console.error('❌ Error preprocessing audio:', error);
      // Return original buffer if processing fails
      return audioBuffer;
    }
  }

  private isValidAudioChunk(audioChunk: Buffer): boolean {
    // Basic validation for audio chunk
    // Check if the chunk has reasonable size and is not all zeros
    if (audioChunk.length < 20) {
      return false;
    }
    
    // Check if the chunk contains any non-zero data (not complete silence)
    let hasNonZeroData = false;
    for (let i = 0; i < Math.min(audioChunk.length, 100); i++) {
      if (audioChunk[i] !== 0) {
        hasNonZeroData = true;
        break;
      }
    }
    
    return hasNonZeroData;
  }

  private isDeepgramReady(connection: WebSocket): boolean {
    return connection.readyState === WebSocket.OPEN;
  }

  private resetState(): void {
    this.hasSeenMedia = false;
    this.messageCount = 0;
    this.isProcessingAudio = false;
    this.streamSid = null;
    this.inBuffer.length = 0;
  }

  public getMessageCount(): number {
    return this.messageCount;
  }

  public getStreamSid(): string | null {
    return this.streamSid;
  }
} 