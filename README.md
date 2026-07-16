# Diario Nocturno

**A local AI interviews you at the end of your day and writes your journal for you.** You chat for two minutes; it writes structured notes — daily entries, people, projects — after showing you a writing plan you can edit. Everything runs on your machine via [Ollama](https://ollama.com): no cloud, no accounts, no data leaving your computer.

*[Español más abajo](#español).*

## Features

- **Nightly interview** — a short, warm conversation ("how was your day?") with follow-up questions. Type, talk (🎙️), or go hands-free (🎤): it detects when you pause and answers out loud.
- **Writing plan you confirm** — before touching your vault it shows exactly what it will write, item by item, with checkboxes. Untick anything; nothing is written without your OK.
- **Structured notes** — daily note with mood/energy frontmatter, summary, wins and to-dos; person notes (`People/Mari.md`) and project notes with wikilinks that build your graph.
- **Long-term memory (RAG)** — with a local embeddings model, the interviewer remembers your old notes ("is this the tooth you said they were going to pull?").
- **Ask your journal** — a 🔍 tab where you ask questions about your own past and it answers *only* from your notes, citing the date, with clickable sources that open the note. If it doesn't know, it says so honestly.
- **Attachments become memory** — drop in a photo, PDF or text file. PDF text is extracted and images are described by the local model, so you can ask about them later.
- **Voice (optional)** — local text-to-speech (Kokoro) and speech-to-text (Whisper) via a small Python sidecar. Without it, the plugin is text-only.
- **Streak & energy** — 🔥 consecutive nights and a 7-day energy sparkline.
- **Undo (optional)** — with git auto-commit enabled, every session is one commit and the undo button reverts it.
- **English or Spanish** — follows your Obsidian language by default; switchable in settings.

## Requirements

- Obsidian **desktop** (the plugin runs a local model; mobile is not supported).
- [Ollama](https://ollama.com/download) running locally, with the interview model:

```
ollama pull gemma3:4b
```

Optional, recommended:

```
ollama pull embeddinggemma   # long-term memory + "ask your journal"
ollama pull gemma3:12b       # higher-quality extraction (set it as extraction model in settings)
```

If Ollama or the model is missing, the plugin shows a friendly first-run card with instructions instead of an error.

## Quick start

1. Install and enable the plugin.
2. Click the 🌙 moon icon in the ribbon (or run the command *"Abrir diario nocturno"*).
3. Tell it about your day. When you're done, press *"close the day and save"*.
4. Review the writing plan, untick what you don't want, confirm.

## Voice sidecar (optional, advanced)

Voice uses a local FastAPI sidecar with [Kokoro](https://github.com/hexgrad/kokoro) (TTS) and Whisper (STT), included in this repo at `apps/voz/servidor_voz.py`.

```
python -m venv .venv
.venv/Scripts/pip install fastapi uvicorn kokoro faster-whisper pymupdf soundfile num2words
.venv/Scripts/python apps/voz/servidor_voz.py 8765
```

Then in the plugin settings set the sidecar URL (`http://127.0.0.1:8765`). If you fill in the *advanced* paths (python, script, working dir), the plugin starts the sidecar by itself when needed.

## Privacy

Everything is local: the interview (Ollama), the memory index (`.indice/rag.json` inside your vault), voice, and PDF extraction. The plugin makes no network requests beyond `localhost`.

## Development

```
cd apps/diario && npm install     # core (interview, extraction, RAG, vault writer)
cd ../obsidian && npm install
npm run build                     # typecheck + bundle to main.js
```

The plugin reuses the core of the standalone diary app; `main.js` is a self-contained CJS bundle.

---

## Español

**Una IA local te entrevista al final del día y escribe tu diario por ti.** Charlas dos minutos; ella escribe notas estructuradas — diario, personas, proyectos — después de mostrarte un plan de escritura que puedes editar. Todo corre en tu máquina con [Ollama](https://ollama.com): sin nube, sin cuentas, sin que tus datos salgan de tu computador.

- **Entrevista nocturna** por texto, voz 🎙️ o manos libres 🎤 (detecta tus pausas y responde hablando).
- **Plan de escritura confirmable**: nada se escribe sin tu OK, ítem por ítem.
- **Notas estructuradas** con frontmatter de ánimo/energía, personas y proyectos con wikilinks.
- **Memoria de largo plazo (RAG)** con `embeddinggemma`: recuerda tus notas viejas y las conecta.
- **Pestaña 🔍 consultar**: pregúntale a tu pasado y responde solo con tus notas, citando la fecha, con fuentes clicables. Si no lo sabe, lo dice.
- **Adjuntos con memoria**: el texto de los PDF se extrae y las imágenes se describen con el modelo local — luego puedes preguntar por ellos.
- **Voz opcional** (Kokoro + Whisper, 100% local) y **deshacer opcional** con git auto-commit.
- **Español o inglés**: hereda el idioma de Obsidian por defecto.

Requisitos: Obsidian de escritorio + [Ollama](https://ollama.com/download) con `ollama pull gemma3:4b` (opcional: `embeddinggemma` para la memoria y `gemma3:12b` para extraer con más calidad).

## License

MIT
