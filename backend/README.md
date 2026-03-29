# Backend

This backend owns all provider API calls for the extension.

## Files

- `server.js`: HTTP server with `/health` and `/draft-email`.
- `.env`: local runtime configuration.
- `.env.example`: template configuration.
- `package.json`: run script.

## Providers

- Default provider: `openai`
- Optional provider: `ollama`

The extension can send a provider override per request. If it does not, the backend uses `DEFAULT_PROVIDER` from `.env`.

## Environment

Required for OpenAI:
- `OPENAI_API_KEY`

Useful defaults:
- `PORT=8787`
- `DEFAULT_PROVIDER=openai`
- `OPENAI_MODEL=gpt-4.1-mini`
- `OLLAMA_BASE_URL=http://127.0.0.1:11434`
- `OLLAMA_MODEL=llama3.1:8b`

## Run

```powershell
cd email_generator\backend
npm start
```

## Endpoints

- `GET /health`
- `POST /draft-email`

### `POST /draft-email` body

```json
{
  "provider": "openai",
  "capture": {
    "jobTitle": "AI Intern",
    "company": "Example Co"
  },
  "profileText": "resume text here",
  "settings": {
    "applicantName": "Yibin",
    "applicantEmail": "you@example.com",
    "tone": "professional and concise",
    "model": "",
    "maxProfileChunks": 4
  }
}
```
