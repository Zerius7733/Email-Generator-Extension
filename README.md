# Job Email Draft Generator

## Structure

- `manifest.json`: root Chrome manifest.
- `frontend/`: the unpacked Chrome extension UI and client-side logic.
- `backend/`: local Node backend that handles provider calls and resume file parsing.

## Current flow

1. Open a job posting page.
2. Click the extension to capture a screenshot and extract job details from the page HTML.
3. Import your resume/profile into the options page. PDF and DOCX imports are parsed by the backend.
4. The extension sends the captured job details and your stored resume/profile text to the local backend.
5. The backend retrieves the most relevant profile chunks and generates the email draft using OpenAI by default.
6. If desired, switch the provider to Ollama in the extension settings.
7. The extension shows the draft and can open Gmail compose.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the `email_generator` folder.

## Start the backend

1. Open `email_generator/backend/.env`.
2. Set `OPENAI_API_KEY`.
3. From `email_generator/backend`, run `npm install` once.
4. Run `npm start`.
5. Confirm `http://127.0.0.1:8787/health` returns JSON.

## Configure the extension

1. Open the extension's Options page.
2. Set `Backend URL` to your running backend, usually `http://127.0.0.1:8787`.
3. Choose `OpenAI` or `Ollama` as the provider override.
4. Optionally set a model override, or leave it blank to use the backend default.
5. Import or paste your resume text and project notes into the knowledge base box.
6. Save settings.

## Notes

- Provider API keys stay in `backend/.env`, not in the extension.
- OpenAI is the default backend provider.
- Ollama works when you have an Ollama server running locally.
- PDF OCR is not included; scanned PDFs may need OCR later.
