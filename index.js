import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import WebSocket from 'ws';
import fetch from 'node-fetch';
import { Readable } from 'stream';


dotenv.config();
const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, PORT } = process.env;
if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.error('Missing required ElevenLabs environment variables');
  throw new Error('Missing required environment variables');
}

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

fastify.get('/', async (_, reply) => {
  reply.send({ message: 'Server is running' });
});

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
    let isInterrupted = false;

    async function setupEleven() {
      try {
        const url = await getSignedUrl();
        elevenWs = new WebSocket(url);

        elevenWs.on('open', () => {
          console.log('[ElevenLabs] Connected');

          // 🔥 Send conversation initiation using chunked strategy
          elevenWs.send(
            JSON.stringify({
              type: 'conversation_initiation_client_data',
              audio: {
                type: 'chunked_audio', // 👈 Key: enable interruption capability
                encoding: 'pcm_f32',
                sample_rate: 16000,
              },
              interruption_config: {
                enable: true,
                mode: 'cut_off', // Optional: or 'barge_in'
              },
              dynamic_variables: {},
            })
          );
        });

        elevenWs.on('message', (data) => {
          let msg;
          try {
            msg = JSON.parse(data);
          } catch (e) {
            return console.error('[ElevenLabs] Bad JSON', e);
          }

          switch (msg.type) {
            case 'audio': {
              const chunk = msg.audio?.chunk || msg.audio_event?.audio_base_64;
              if (chunk && !isInterrupted) {
                ws.send(
                  JSON.stringify({
                    type: 'playAudio',
                    data: {
                      audioContentType: 'raw',
                      sampleRate:
                        callMetadata?.sampling_rate === '16k'
                          ? 16000
                          : callMetadata?.sampling_rate === '32k'
                          ? 32000
                          : 8000,
                      audioContent: chunk,
                    },
                  })
                );
              }
              break;
            }

            case 'interruption': {
              console.log('[ElevenLabs] Interruption detected');

              isInterrupted = true;

              // 1. Stop audio playback on Knowlarity
              ws.send(JSON.stringify({ type: 'stopAudio' }));

              // 2. End the current TTS response immediately
              elevenWs.send(
                JSON.stringify({
                  type: 'conversation_end_client_data',
                })
              );
              break;
            }

            case 'ping': {
              if (msg.ping_event?.event_id) {
                elevenWs.send(
                  JSON.stringify({
                    type: 'pong',
                    event_id: msg.ping_event.event_id,
                  })
                );
              }
              break;
            }

            default:
              console.log('[ElevenLabs] Unhandled:', msg.type);
          }
        });

        elevenWs.on('error', (err) =>
          console.error('[ElevenLabs] WebSocket Error:', err)
        );
        elevenWs.on('close', () =>
          console.log('[ElevenLabs] WebSocket Closed')
        );
      } catch (err) {
        console.error('Error setting up ElevenLabs:', err);
      }
    }

    setupEleven();

    ws.on('message', (message, isBinary) => {
      if (!metadataReceived && !isBinary) {
        try {
          callMetadata = JSON.parse(message.toString());
          metadataReceived = true;
          console.log('[Knowlarity] Metadata:', callMetadata);
        } catch (e) {
          console.error('[Knowlarity] Meta parse error', e);
        }
      } else if (isBinary && !isInterrupted) {
        // 🔥 Audio stream: encode as base64 chunk
        if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
          ws.pause(); // Flow control
          const audioBase64 = message.toString('base64');

          elevenWs.send(
            JSON.stringify({ user_audio_chunk: audioBase64 }),
            () => ws.resume()
          );
        }
      } else {
        // Handle control messages from Knowlarity
        try {
          const ctrl = JSON.parse(message.toString());
          console.log('[Knowlarity] Control:', ctrl);
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
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`[Server] Listening on ${port}`);
});
