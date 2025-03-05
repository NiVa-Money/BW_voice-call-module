import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import WebSocket from 'ws';
import fetch from 'node-fetch';

// Load environment variables from .env file
dotenv.config();

// Ensure required ElevenLabs environment variables are provided
const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, PORT } = process.env;
if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.error('Missing required ElevenLabs environment variables');
  throw new Error('Missing required environment variables');
}

// Initialize Fastify server
const fastify = Fastify();

fastify.register(fastifyCors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
});
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const port = PORT || 8000;

// Root route for health check
fastify.get('/', async (_, reply) => {
  reply.send({ message: 'Server is running' });
});

// Helper: Get a signed URL from ElevenLabs for the conversation
async function getSignedUrl() {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: 'GET',
        headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      }
    );
    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }
    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error('Error getting signed URL:', error);
    throw error;
  }
}

/**
 * WebSocket endpoint for Knowlarity.
 *
 * According to the Knowlarity documentation:
 *  - On connection, the first message will be a JSON text frame containing metadata.
 *  - After that, the call audio stream is transmitted as binary frames (16-bit PCM) at the configured sampling rate.
 *  - The server can also send JSON text frames back to Knowlarity to play audio, transfer, or disconnect the call.
 *
 * This implementation bridges the incoming Knowlarity audio to ElevenLabs and
 * sends back ElevenLabs responses to Knowlarity in the expected format.
 */
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get('/knowlarity-media-stream', { websocket: true }, (ws, req) => {
    console.info('[Server] Knowlarity connected to media stream');

    // To hold the metadata received from Knowlarity
    let callMetadata = null;
    let metadataReceived = false;
    let elevenLabsWs = null;

    // Setup the ElevenLabs WebSocket connection
    async function setupElevenLabsConnection() {
      try {
        const signedUrl = await getSignedUrl();
        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on('open', () => {
          console.log('[ElevenLabs] Connected to Conversational AI');

          // Prepare initial configuration using metadata (if available)
          const initialConfig = {
            type: 'conversation_initiation_client_data',
            dynamic_variables: {
              // Optionally include additional client data
            },
            conversation_config_override: {
              agent: {
                prompt: {
                  // Use a prompt from metadata if provided; otherwise a default prompt
                  prompt: callMetadata?.prompt || 'Botwot customer service',
                },
                first_message:
                  callMetadata?.first_message ||
                  'Hello, how can Botwot help you today?',
              },
            },
          };

          console.log('[ElevenLabs] Sending initial configuration:', initialConfig);
          elevenLabsWs.send(JSON.stringify(initialConfig));
        });

        elevenLabsWs.on('message', (data) => {
          try {
            const message = JSON.parse(data);
            // Process responses from ElevenLabs and forward them to Knowlarity
            switch (message.type) {
              case 'audio':
                // Extract audio payload from ElevenLabs response
                const audioPayload =
                  message.audio?.chunk ||
                  message.audio_event?.audio_base_64;
                if (audioPayload) {
                  // Wrap the audio payload in a JSON command as per Knowlarity's spec.
                  // For raw PCM, include the sampleRate.
                  const responsePayload = {
                    type: 'playAudio',
                    data: {
                      audioContentType: 'raw', // or "wave" as required
                      sampleRate:
                        callMetadata?.sampling_rate === '16k'
                          ? 16000
                          : callMetadata?.sampling_rate === '32k'
                          ? 32000
                          : 8000, // default to 8k if not provided
                      audioContent: audioPayload,
                    },
                  };
                  ws.send(JSON.stringify(responsePayload));
                }
                break;

              case 'interruption':
                // Forward interruption as a disconnect command to Knowlarity
                ws.send(JSON.stringify({ type: 'disconnect' }));
                break;

              case 'ping':
                if (message.ping_event?.event_id) {
                  elevenLabsWs.send(
                    JSON.stringify({
                      type: 'pong',
                      event_id: message.ping_event.event_id,
                    })
                  );
                }
                break;

              default:
                console.log('[ElevenLabs] Unhandled message type:', message.type);
            }
          } catch (error) {
            console.error('[ElevenLabs] Error processing message:', error);
          }
        });

        elevenLabsWs.on('error', (error) => {
          console.error('[ElevenLabs] WebSocket error:', error);
        });

        elevenLabsWs.on('close', () => {
          console.log('[ElevenLabs] Connection closed');
        });
      } catch (error) {
        console.error('Error setting up ElevenLabs connection:', error);
      }
    }

    setupElevenLabsConnection();

    // Handle messages from Knowlarity
    ws.on('message', (message, isBinary) => {
      if (!metadataReceived && !isBinary) {
        // The very first text message is expected to be metadata.
        try {
          const meta = JSON.parse(message.toString());
          console.log('[Knowlarity] Metadata received:', meta);
          callMetadata = meta;
          metadataReceived = true;
        } catch (err) {
          console.error('[Knowlarity] Error parsing metadata:', err);
        }
      } else if (isBinary) {
        // Incoming binary data is call audio.
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
          // Convert the binary audio frame to base64 encoding.
          const audioBase64 = message.toString('base64');
          const audioMessage = {
            user_audio_chunk: audioBase64,
          };
          elevenLabsWs.send(JSON.stringify(audioMessage));
        }
      } else {
        // If additional text frames are received after metadata,
        // they might be control messages (e.g., transfer or disconnect) from Knowlarity.
        try {
          const controlMsg = JSON.parse(message.toString());
          console.log('[Knowlarity] Control message received:', controlMsg);
          // Process control commands if needed.
          // For example, if a transfer command is received:
          // { type: "transfer", data: { textContent: "+918770915486" } }
        } catch (err) {
          console.error('[Knowlarity] Error parsing control message:', err);
        }
      }
    });

    ws.on('close', () => {
      console.log('[Knowlarity] Client disconnected');
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    });
  });
});

// Start the Fastify server
fastify.listen({ port: port }, (err) => {
  if (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${port}`);
});
