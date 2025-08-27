import http from 'http';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';

/**
 * Twilio ↔ ElevenLabs bridge (hardened baseline)
 * - WS server at /twilio accepts Twilio Media Streams
 * - Connects to ElevenLabs ConvAI WS after Twilio "start"
 * - μ-law 8kHz ⇄ PCM16 16kHz conversion
 * - /healthz and /metrics endpoints
 * - Validates Twilio accountSid and presence of a per-call token
 */

const PORT = process.env.PORT || 8080;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const app = express();
let metrics = {
  twilioConnections: 0,
  elevenConnections: 0,
  bytesFromTwilio: 0,
  bytesToTwilio: 0,
  chunksFrom11L: 0,
  chunksFromTwilio: 0,
};

app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/metrics', (_req, res) => res.json(metrics));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

/* ---------- Audio helpers ---------- */
function muLawDecode(uVal) {
  uVal = ~uVal & 0xff;
  const sign = (uVal & 0x80) ? -1 : 1;
  const exponent = (uVal >> 4) & 0x07;
  const mantissa = uVal & 0x0F;
  const magnitude = ((mantissa << 1) + 1) << (exponent + 2);
  return sign * (magnitude - 0x84);
}
function muLawEncode(sample) {
  sample = Math.max(-32768, Math.min(32767, sample));
  let sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  sample += 0x84;
  if (sample > 0x7fff) sample = 0x7fff;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
function upsample8kTo16k(pcm8) {
  const out = new Int16Array(pcm8.length * 2 - 1);
  let j = 0;
  for (let i = 0; i < pcm8.length - 1; i++) {
    const a = pcm8[i], b = pcm8[i + 1];
    out[j++] = a;
    out[j++] = (a + b) >> 1;
  }
  out[j] = pcm8[pcm8.length - 1];
  return out;
}
function downsample16kTo8k(pcm16) {
  const out = new Int16Array(Math.floor(pcm16.length / 2));
  for (let i = 0, j = 0; j < out.length; i += 2, j++) {
    const a = pcm16[i], b = pcm16[i + 1];
    out[j] = (a + b) >> 1;
  }
  return out;
}
function twilioB64MuLawToPcm8k(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = muLawDecode(buf[i]);
  return out;
}
function pcm8kToTwilioB64MuLaw(pcm) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = muLawEncode(pcm[i]);
  return out.toString('base64');
}
function b64Pcm16ToInt16(b64) {
  const buf = Buffer.from(b64, 'base64');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const arr = new Int16Array(buf.byteLength / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = view.getInt16(i * 2, true);
  return arr;
}
function int16ToB64Pcm16(arr) {
  const buf = Buffer.alloc(arr.length * 2);
  for (let i = 0; i < arr.length; i++) buf.writeInt16LE(arr[i], i * 2);
  return buf.toString('base64');
}

/* ---------- Helpers ---------- */
function getCustomParams(start) {
  const cp = start?.customParameters;
  if (!cp) return {};
  if (Array.isArray(cp)) {
    // Twilio may send [{name, value}, ...]
    return cp.reduce((a, c) => { a[c.name] = c.value; return a; }, {});
  }
  return cp; // object form { key: value }
}

/* ---------- Bridge wiring ---------- */
wss.on('connection', (twilioWS, request) => {
  metrics.twilioConnections++;

  let streamSid = null;
  let agentId = null;
  let elevenWS = null;

  const send11 = (obj) => {
    if (elevenWS && elevenWS.readyState === WebSocket.OPEN) {
      elevenWS.send(JSON.stringify(obj));
    }
  };
  const sendTw = (obj) => {
    if (twilioWS.readyState === WebSocket.OPEN) {
      twilioWS.send(JSON.stringify(obj));
    }
  };

  const connectEleven = (resolvedAgentId) => {
    const elevenUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(resolvedAgentId)}`;
    const headers = {};
    if (process.env.ELEVENLABS_API_KEY) headers['xi-api-key'] = process.env.ELEVENLABS_API_KEY;
    elevenWS = new WebSocket(elevenUrl, { headers });
    metrics.elevenConnections++;

    elevenWS.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'ping' && msg.ping_event?.event_id != null) {
          send11({ type: 'pong', event_id: msg.ping_event.event_id });
          return;
        }

        if (msg.type === 'audio' && msg.audio_event?.audio_base_64) {
          metrics.chunksFrom11L++;
          const pcm16 = b64Pcm16ToInt16(msg.audio_event.audio_base_64);
          const pcm8  = downsample16kTo8k(pcm16);
          const b64Mu = pcm8kToTwilioB64MuLaw(pcm8);
          if (streamSid) {
            const payload = { event: 'media', streamSid, media: { payload: b64Mu } };
            metrics.bytesToTwilio += Buffer.from(b64Mu, 'base64').length;
            sendTw(payload);
            sendTw({ event: 'mark', streamSid, mark: { name: `ll-${Date.now()}` } });
          }
        }
      } catch (e) {
        console.error('11L parse error', e);
      }
    });

    elevenWS.on('close', () => { try { twilioWS.close(1000, '11L closed'); } catch {} });
    elevenWS.on('error', (e) => console.error('11L WS error', e));
  };

  twilioWS.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.event === 'start') {
        streamSid = msg.start?.streamSid || msg.streamSid;
        const twAcct = msg.start?.accountSid;

        // Security: Twilio account must match
        if (process.env.TWILIO_ACCOUNT_SID && twAcct !== process.env.TWILIO_ACCOUNT_SID) {
          console.warn('Blocked start: accountSid mismatch', { got: twAcct });
          try { twilioWS.close(1008, 'bad account'); } catch {}
          return;
        }

        const cp = getCustomParams(msg.start);
        const token = cp.token;
        agentId = cp.agent_id || process.env.ELEVENLABS_AGENT_ID;

        if (!agentId) { try { twilioWS.close(1008, 'Missing agent_id'); } catch {}; return; }
        if (!token)   { try { twilioWS.close(1008, 'Missing token'); } catch {}; return; }
        // TODO (harden): verify token signature / replay-protect with CallSid

        connectEleven(agentId);
        if (LOG_LEVEL === 'debug') console.log('TW start ok', { streamSid, agentId });

      } else if (msg.event === 'media' && msg.media?.payload) {
        metrics.bytesFromTwilio += Buffer.from(msg.media.payload, 'base64').length;
        metrics.chunksFromTwilio++;
        const pcm8  = twilioB64MuLawToPcm8k(msg.media.payload);
        const pcm16 = upsample8kTo16k(pcm8);
        send11({ user_audio_chunk: int16ToB64Pcm16(pcm16) });

      } else if (msg.event === 'stop') {
        try { if (elevenWS) elevenWS.close(1000, 'Twilio stop'); } catch {}
      }
    } catch (e) {
      console.error('TW parse error', e);
    }
  });

  twilioWS.on('close', () => { try { if (elevenWS) elevenWS.close(1000, 'TW closed'); } catch {} });
  twilioWS.on('error', (e) => console.error('TW WS error', e));
});

server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/twilio')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Bridge listening on :${PORT}`);
});
