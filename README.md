# Voice Agent Server

A TypeScript implementation of a voice agent server that integrates with Deepgram's Speech-to-Speech API and Twilio for real-time voice interactions.

## Features

- Real-time voice processing with Deepgram Speech-to-Speech
- WebSocket-based communication with Twilio
- Function calling capabilities for custom business logic
- Audio streaming and buffering
- Graceful shutdown handling
- TypeScript with strict type checking

## Prerequisites

- Node.js (v16 or higher)
- Yarn or npm
- Deepgram API key
- Twilio account (for voice calls)

## Installation

1. Clone the repository and install dependencies:
```bash
yarn install
```

2. Copy the environment example and configure your API keys:
```bash
cp env.example .env
```

3. Edit `.env` and add your Deepgram API key:
```
DEEPGRAM_API_KEY=your_actual_deepgram_api_key_here
```

## Configuration

### Environment Variables

- `DEEPGRAM_API_KEY`: Your Deepgram API key (required)
- `SERVER_PORT`: Server port (default: 5000)
- `SERVER_HOST`: Server host (default: localhost)

### Config File

The `config.json` file contains the Deepgram agent configuration including:
- Agent name and description
- Voice model settings
- Function definitions for custom business logic

## Usage

### Development

Run the server in development mode:
```bash
yarn dev
```

### Production

Build and run the production server:
```bash
yarn build
yarn start
```

## Architecture

The voice agent server consists of several key components:

### 1. WebSocket Server
- Listens for incoming Twilio WebSocket connections
- Handles multiple concurrent voice sessions

### 2. Deepgram Integration
- Establishes connection to Deepgram's Speech-to-Speech API
- Sends audio streams for real-time processing
- Receives transcribed text and function call requests

### 3. Audio Processing
- Buffers incoming audio from Twilio
- Streams processed audio back to Twilio
- Handles audio format conversion (base64 encoding/decoding)
- **Noise reduction and audio preprocessing**
- **Dynamic noise gating to reduce background noise**
- **Audio validation to filter out invalid chunks**

### 4. Function Calling
- Executes custom functions based on voice commands
- Supports dynamic function registration
- Returns results to Deepgram for voice response

## Custom Functions

To add your own functions, modify the `FUNCTION_MAP` in `src/index.ts`:

```typescript
const FUNCTION_MAP: FunctionMap = {
  getMedicationInfo: (medicationName: string) => {
    // Your custom logic here
    return { name: medicationName, dosage: "10mg" };
  },
  checkDrugInteraction: (medication1: string, medication2: string) => {
    // Your interaction checking logic
    return { interaction: "None detected" };
  }
};
```

Also update the `config.json` file to include your function definitions for Deepgram.

## API Endpoints

The server runs a WebSocket server on the configured port (default: 5000) that accepts connections from Twilio's Media Streams API.

## Error Handling

The server includes comprehensive error handling for:
- WebSocket connection failures
- Deepgram API errors
- Function execution errors
- Audio processing issues
- Audio validation and noise reduction errors

## Noise Reduction

The server includes advanced audio processing to reduce noise and improve call quality:

### Audio Preprocessing
- **Dynamic noise gating**: Automatically detects and removes background noise
- **Audio validation**: Filters out invalid or corrupted audio chunks
- **Buffer optimization**: Smaller buffer sizes for lower latency
- **Silence detection**: Skips processing of silent audio segments

### Configuration
- Adjustable noise threshold (default: 0.005)
- Minimum audio chunk size validation (20 bytes)
- Dynamic amplitude-based noise gating
- Error handling for audio processing failures

## Logging

The server provides detailed logging for:
- Connection events
- Function calls and results
- Audio processing status
- Error conditions
- Audio chunk processing and noise reduction

## Graceful Shutdown

The server handles SIGINT and SIGTERM signals for graceful shutdown, ensuring all connections are properly closed.

## TypeScript Features

- Strict type checking enabled
- Comprehensive interface definitions
- Proper error handling with typed exceptions
- Async/await patterns throughout

## Contributing

1. Follow the TypeScript guidelines in the project
2. Add proper type definitions for new features
3. Include error handling for all async operations
4. Test thoroughly before submitting changes

## License

MIT License - see LICENSE file for details 