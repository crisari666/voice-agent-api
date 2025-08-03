import type { ExpressServerConfig } from './types/server-config';
import { VoiceAgentExpressServer } from './server/voice-agent-server';

const main = (): void => {
  const serverConfig: ExpressServerConfig = {
    port: 8881,
    host: 'localhost',
    expressPort: parseInt(process.env.PORT || '8881')
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