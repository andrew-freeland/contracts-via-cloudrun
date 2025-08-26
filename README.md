# Twilio ↔ ElevenLabs WebSocket Proxy (Cloud Run, Node 22)

This service bridges **Twilio Media Streams** and **ElevenLabs ConvAI** over WebSockets.
It converts audio both ways (Twilio μ-law @ 8kHz ⇄ ElevenLabs PCM16 @ 16kHz) and adds basic
health/metrics endpoints and structured logging.

## Quick start

```bash
# build & deploy via gcloud (manual)
gcloud builds submit --tag gcr.io/$(gcloud config get-value project)/twi2elevenlabs
gcloud run deploy twi2elevenlabs   --image gcr.io/$(gcloud config get-value project)/twi2elevenlabs   --platform managed --region us-central1 --allow-unauthenticated   --port 8080 --concurrency 20 --timeout 3600 --min-instances 1 --max-instances 20   --set-env-vars ELEVENLABS_AGENT_ID=YOUR_AGENT_ID,LOG_LEVEL=info
```

### TwiML

Point your `<Stream>` at the service (replace host):
```xml
<Connect>
  <Stream
    url="wss://YOUR_SERVICE_HOST/twilio?agent_id=YOUR_AGENT_ID&from_number=+14152728956"
    statusCallback="https://builders.app.n8n.cloud/webhook/stream-status"
    statusCallbackMethod="POST">
    <Parameter name="is_returning" value="true"/>
  </Stream>
</Connect>
```

### Endpoints
- `GET /healthz` → `ok`
- `GET /metrics` → minimal JSON counters
- `WS /twilio` → Twilio connects here; the service dials ElevenLabs
