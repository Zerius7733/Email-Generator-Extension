# Backend

This backend owns all provider API calls for the extension.

## Files

- `server.js`: HTTP server with `/health`, `/extract-profile-file`, `/log-application`, and `/draft-email`.
- `.env`: local runtime configuration.
- `.env.example`: template configuration.
- `package.json`: run script and parser dependencies.

## Providers

- Default provider: `openai`
- Optional provider: `ollama`

The extension can send a provider override per request. If it does not, the backend uses `DEFAULT_PROVIDER` from `.env`.

## Resume import

The options page now supports:
- `.txt`
- `.md`
- `.json`
- `.pdf`
- `.docx`

Implementation:
- PDF text extraction uses `pdf-parse`
- DOCX text extraction uses `mammoth`
- OCR is not included yet; scanned PDFs with no embedded text will return a warning that OCR may be required

## Application logging

The popup `Apply` action appends a row to `applications.csv` with these headers:
- `Company`
- `Job Title`
- `Status`
- `Date`
- `link`
- `portal`
- `EMAIL`

Defaults:
- `Status` becomes `Applied`
- `link` becomes `NA` if no URL is captured
- `portal` uses the captured page hostname or `NA`
- `EMAIL` uses the edited email field, then scanned email, then `NA`

## Environment

Required for OpenAI:
- `OPENAI_API_KEY`

Useful defaults:
- `PORT=8787`
- `DEFAULT_PROVIDER=openai`
- `OPENAI_MODEL=gpt-4.1-mini`
- `OLLAMA_BASE_URL=http://127.0.0.1:11434`
- `OLLAMA_MODEL=llama3.1:8b`

## Install and run

```powershell
cd email_generator\backend
npm install
npm start
```

## Endpoints

- `GET /health`
- `POST /extract-profile-file`
- `POST /log-application`
- `POST /draft-email`
