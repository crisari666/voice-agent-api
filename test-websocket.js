const WebSocket = require('ws');

// Test WebSocket connection locally
const testWebSocketConnection = () => {
  console.log('🧪 Testing WebSocket connection...');
  
  const ws = new WebSocket('ws://localhost:8881/ws');
  
  ws.on('open', () => {
    console.log('✅ WebSocket connection opened successfully');
    
    // Send a test message
    const testMessage = {
      event: 'test',
      message: 'Hello from test client'
    };
    
    ws.send(JSON.stringify(testMessage));
    console.log('📤 Sent test message:', testMessage);
    
    // Close connection after 2 seconds
    setTimeout(() => {
      console.log('🔌 Closing test connection...');
      ws.close();
    }, 2000);
  });
  
  ws.on('message', (data) => {
    console.log('📥 Received message:', data.toString());
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
  });
  
  ws.on('close', (code, reason) => {
    console.log('🔌 WebSocket closed. Code:', code, 'Reason:', reason.toString());
    process.exit(0);
  });
  
  // Timeout after 5 seconds
  setTimeout(() => {
    console.log('⏰ Test timeout');
    ws.close();
    process.exit(1);
  }, 5000);
};

// Run the test
testWebSocketConnection(); 