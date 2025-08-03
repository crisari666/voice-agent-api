const WebSocket = require('ws');

// Debug WebSocket connection with detailed logging
const debugWebSocketConnection = () => {
  console.log('🔍 Debugging WebSocket connection...');
  console.log('📍 Target URL: ws://localhost:8881/ws');
  
  const ws = new WebSocket('ws://localhost:8881/ws', {
    headers: {
      'User-Agent': 'Twilio-WebSocket-Test/1.0',
      'Origin': 'https://twilio.com'
    }
  });
  
  console.log('🔗 WebSocket object created');
  
  ws.on('open', () => {
    console.log('✅ WebSocket connection opened successfully');
    console.log('📊 Ready state:', ws.readyState);
    console.log('🔗 URL:', ws.url);
    
    // Send a test message that mimics Twilio format
    const twilioTestMessage = {
      event: 'start',
      start: {
        streamSid: 'test-stream-sid-123'
      }
    };
    
    ws.send(JSON.stringify(twilioTestMessage));
    console.log('📤 Sent Twilio-style test message:', twilioTestMessage);
    
    // Send another test message
    setTimeout(() => {
      const mediaTestMessage = {
        event: 'media',
        media: {
          payload: Buffer.from('test audio data').toString('base64'),
          track: 'inbound'
        }
      };
      
      ws.send(JSON.stringify(mediaTestMessage));
      console.log('📤 Sent media test message');
    }, 1000);
    
    // Close connection after 3 seconds
    setTimeout(() => {
      console.log('🔌 Closing test connection...');
      ws.close(1000, 'Test completed');
    }, 3000);
  });
  
  ws.on('message', (data) => {
    console.log('📥 Received message:', data.toString());
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
    console.error('❌ Error details:', error);
  });
  
  ws.on('close', (code, reason) => {
    console.log('🔌 WebSocket closed.');
    console.log('📊 Close code:', code);
    console.log('📝 Close reason:', reason.toString());
    console.log('📊 Final ready state:', ws.readyState);
    process.exit(0);
  });
  
  // Log connection attempt
  console.log('🚀 Attempting to connect...');
  
  // Timeout after 10 seconds
  setTimeout(() => {
    console.log('⏰ Debug timeout - connection taking too long');
    if (ws.readyState === WebSocket.CONNECTING) {
      console.log('⚠️ Still connecting after 10 seconds');
      ws.close();
    }
    process.exit(1);
  }, 10000);
};

// Run the debug
debugWebSocketConnection(); 