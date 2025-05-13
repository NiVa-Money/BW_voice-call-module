import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import WebSocket from 'ws';
import fetch from 'node-fetch';

// Load environment variables
dotenv.config();
const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, PORT } = process.env;
if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.error('Missing required ElevenLabs environment variables');
  throw new Error('Missing required environment variables');
}

const fastify = Fastify();
fastify.register(fastifyCors, {
  origin: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
});
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const port = PORT || 8000;

// Health check
fastify.get('/', async (_, reply) => {
  reply.send({ message: 'Server is running' });
});

// Fetch a signed Conversational AI URL from ElevenLabs
async function getSignedUrl() {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
    { method: 'GET', headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
  );
  if (!res.ok) throw new Error(`Failed to get signed URL: ${res.statusText}`);
  const { signed_url } = await res.json();
  return signed_url;
}

fastify.register(async (instance) => {
  instance.get('/knowlarity-media-stream', { websocket: true }, (ws, req) => {
    console.info('[Server] Knowlarity connected');

    let callMetadata = null;
    let metadataReceived = false;
    let elevenWs = null;

    // Set up ElevenLabs WebSocket
    async function setupEleven() {
      try {
        const url = await getSignedUrl();
        elevenWs = new WebSocket(url);

        elevenWs.on('open', () => {
          console.log('[ElevenLabs] Connected');
          // Send start config
          elevenWs.send(JSON.stringify({
            type: 'conversation_initiation_client_data',
            dynamic_variables: {}
          }));
        });

        elevenWs.on('message', (data) => {
          let msg;
          try { msg = JSON.parse(data); } 
          catch (e) { return console.error('[ElevenLabs] Bad JSON', e); }

          console.log('[ElevenLabs] Message:', msg);
          switch (msg.type) {
            case 'audio': {
              const chunk = msg.audio?.chunk || msg.audio_event?.audio_base_64;
              if (chunk) {
                ws.send(JSON.stringify({
                  type: 'playAudio',
                  data: {
                    audioContentType: 'raw',
                    sampleRate:
                      callMetadata?.sampling_rate === '16k' ? 16000 :
                      callMetadata?.sampling_rate === '32k' ? 32000 : 8000,
                    audioContent: chunk,
                  }
                }));
              }
              break;
            }

            case 'interruption':
              console.log('[ElevenLabs] Interruption received. Assistant should stop speaking and listen.');
              
              // 1. Stop the current audio playback on Knowlarity side
              const stopAudioCommand = {
                type: 'stopAudio',
                data: {
                  reason: 'userInterruption'
                }
              };
              ws.send(JSON.stringify(stopAudioCommand));
              
              // 2. Send an interruption acknowledgment to ElevenLabs (if their API supports it)
              if (message.interruption_event?.event_id) {
                elevenLabsWs.send(JSON.stringify({
                  type: 'interruption_acknowledgment',
                  event_id: message.interruption_event.event_id
                }));
              }
              
              // 3. Optional: Set a flag to indicate the assistant was interrupted
              // This can be used to modify subsequent behavior
              const wasInterrupted = true;
              
              break;

            case 'ping': {
              if (msg.ping_event?.event_id) {
                elevenWs.send(JSON.stringify({
                  type: 'pong',
                  event_id: msg.ping_event.event_id
                }));
              }
              break;
            }

            default:
              console.log('[ElevenLabs] Unhandled:', msg.type);
          }
        });

        elevenWs.on('error', (err) => console.error('[ElevenLabs] Error', err));
        elevenWs.on('close', () => console.log('[ElevenLabs] Closed'));
      } catch (err) {
        console.error('Error setting up ElevenLabs:', err);
      }
    }

    setupEleven();

    // Handle Knowlarity WS messages
    ws.on('message', (message, isBinary) => {
      if (!metadataReceived && !isBinary) {
        // First text frame is call metadata
        try {
          callMetadata = JSON.parse(message.toString());
          metadataReceived = true;
          console.log('[Knowlarity] Metadata:', callMetadata);
        } catch (e) {
          console.error('[Knowlarity] Meta parse error', e);
        }
      }
      else if (isBinary) {
        // Audio chunk from caller → forward to ElevenLabs
        if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
          ws.pause();  // prevent back-pressure; resume after send if needed
          const audioBase64 = message.toString('base64');
          elevenWs.send(JSON.stringify({ user_audio_chunk: audioBase64 }), () => {
            ws.resume();
          });
        }
      }
      else {
        // Further JSON control messages from Knowlarity
        try {
          const ctrl = JSON.parse(message.toString());
          console.log('[Knowlarity] Control:', ctrl);
          // handle transfers, hangups, etc.
        } catch (e) {
          console.error('[Knowlarity] Ctrl parse error', e);
        }
      }
    });

    ws.on('close', () => {
      console.log('[Knowlarity] Disconnected');
      if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
        elevenWs.close();
      }
    });
  });
});

fastify.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`[Server] Listening on ${port}`);
});
