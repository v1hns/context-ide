# Context IDE

A dependency-free local prototype for working across agent personas without losing shared context.

## Features

- Chrome-style task tabs with independent conversation histories
- Switchable, user-defined agents and models
- Universal context visible to every agent
- Tab attachments that inject related task conversations into the active task
- A context graph and exact context preview
- Browser-local persistence
- Server-side OpenAI API calls, keeping the API key out of the browser

## Run

Requires Node.js 18 or newer.

```bash
cd /Users/vihaanshringi/context-ide
OPENAI_API_KEY="your-key" npm start
```

Then open <http://127.0.0.1:4173>.

Without `OPENAI_API_KEY`, the interface and persistence work, but sending a message shows a configuration error.

## Architecture

The workspace is stored under one versioned `localStorage` key. Each request sends the active agent definition, universal context, the current tab history, and condensed histories from attached tabs to the local server. The server adds these as model instructions and calls the OpenAI Responses API.

This is intentionally dependency-free for a fast local start. A production version should add accounts, encrypted server-side workspace storage, context indexing/retrieval, streaming, tool permissions, and provider-specific adapters.
