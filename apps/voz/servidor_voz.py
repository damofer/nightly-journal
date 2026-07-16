"""
Sidecar de voz para el diario conversacional (parallelme).

Expone STT (Whisper) y TTS (Kokoro-82M) como HTTP local. Corre con el
.venv de chatterbox porque ahí viven torch/transformers/kokoro — el motor
de voz clonada de Chatterbox (la voz de "Laris") se retiró: Kokoro es
~10x más rápido y tiene voces en español e inglés.

Endpoints:
  GET  /salud   -> {"stt": bool, "kokoro": bool, "error": str|None, "voces_kokoro": [...], "voz_defecto": {...}}
  POST /tts     -> body {"texto": "...", "voz": "...", "idioma": "es|en"} -> audio/wav
  POST /stt     -> body binario (webm/wav/ogg), ?idioma=es|en -> {"texto": "..."}
  POST /extraer -> body binario (pdf) -> {"texto": "..."}
"""

import io
import os
import re
import shutil
import sys
import threading

# --- ffmpeg en PATH (necesario para decodificar webm del navegador) ---
if os.name == "nt" and not shutil.which("ffmpeg"):
    import winreg
    for _root, _subkey in [
        (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        (winreg.HKEY_CURRENT_USER, r"Environment"),
    ]:
        try:
            with winreg.OpenKey(_root, _subkey) as _key:
                os.environ["PATH"] += ";" + winreg.QueryValueEx(_key, "Path")[0]
        except OSError:
            pass
# Sin ffmpeg del sistema: el binario de imageio-ffmpeg trae nombre
# versionado (ffmpeg-win-x86_64-v7.1.exe), así que añadir su carpeta al
# PATH no basta — transformers invoca literalmente "ffmpeg" (medido: STT
# fallaba en máquinas limpias con TTS funcionando). Se copia UNA vez junto
# a este script con el nombre canónico y se antepone esta carpeta al PATH.
if not shutil.which("ffmpeg"):
    try:
        import imageio_ffmpeg
        _exe = imageio_ffmpeg.get_ffmpeg_exe()
        _dir = os.path.dirname(os.path.abspath(__file__))
        _destino = os.path.join(_dir, "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        if not os.path.exists(_destino):
            shutil.copyfile(_exe, _destino)
            if os.name != "nt":
                os.chmod(_destino, 0o755)
        os.environ["PATH"] = _dir + os.pathsep + os.environ["PATH"]
    except Exception:
        pass

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
import uvicorn

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
PUERTO = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
# En GPU el turbo grande va sobrado; en CPU (portátiles) el small responde en
# segundos con calidad digna en es/en. WHISPER_MODEL en el entorno lo fuerza.
WHISPER_MODEL = os.environ.get("WHISPER_MODEL") or (
    "openai/whisper-large-v3-turbo" if DEVICE == "cuda" else "openai/whisper-small"
)

# Voces de Kokoro por idioma. El prefijo del id decide el pipeline:
# e* = español, a* = inglés americano. genero: f/m (la UI lo traduce).
KOKORO_VOCES = [
    {"id": "ef_dora", "nombre": "Dora", "genero": "f", "idioma": "es"},
    {"id": "em_alex", "nombre": "Alex", "genero": "m", "idioma": "es"},
    {"id": "em_santa", "nombre": "Santa", "genero": "m", "idioma": "es"},
    {"id": "af_heart", "nombre": "Heart", "genero": "f", "idioma": "en"},
    {"id": "am_michael", "nombre": "Michael", "genero": "m", "idioma": "en"},
]
KOKORO_VOZ_DEFECTO = {"es": "em_santa", "en": "af_heart"}
_KOKORO_IDS = {v["id"] for v in KOKORO_VOCES}
IDIOMAS = {"es", "en"}

estado = {"stt": False, "kokoro": False, "error": None}
whisper_pipe = None
kokoro_pipes = {}  # letra de lang_code de Kokoro ('e' español, 'a' inglés) -> KPipeline
_tts_lock = threading.Lock()


def cargar_modelos():
    global whisper_pipe
    # Kokoro primero: es diminuto (82M) y deja la voz disponible en segundos
    try:
        print("[voz] Cargando Kokoro-82M...")
        from kokoro import KPipeline
        kokoro_pipes["e"] = KPipeline(lang_code="e", repo_id="hexgrad/Kokoro-82M", device=DEVICE)
        # el pipeline inglés reusa los pesos del español (solo cambia el G2P)
        try:
            kokoro_pipes["a"] = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", model=kokoro_pipes["e"].model)
        except Exception as e:
            print(f"[voz] pipeline inglés con modelo compartido falló ({e}); cargando aparte")
            kokoro_pipes["a"] = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", device=DEVICE)
        # warmup de todas las voces: descarga cada .pt una vez, así cambiar de
        # voz en la UI es instantáneo (no espera la descarga en el primer uso)
        for v in KOKORO_VOCES:
            try:
                _generar_kokoro("Hola." if v["idioma"] == "es" else "Hello.", v["id"])
            except Exception as e:
                print(f"[voz] warmup de voz {v['id']} falló (no crítico): {e}")
        estado["kokoro"] = True
        print("[voz] Kokoro listo")
    except Exception as e:
        estado["error"] = f"Kokoro: {e}"
        print(f"[voz] Error cargando Kokoro: {e}")
    try:
        print(f"[voz] Cargando Whisper ({WHISPER_MODEL})...")
        from transformers import pipeline
        whisper_pipe = pipeline(
            "automatic-speech-recognition",
            model=WHISPER_MODEL,
            device=DEVICE,
        )
        estado["stt"] = True
        print("[voz] STT listo")
    except Exception as e:
        estado["error"] = (estado["error"] or "") + f" STT: {e}"
        print(f"[voz] Error cargando STT: {e}")


# --- Normalización de texto (los números en español van a palabras) ---

_units = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve']
_teens = ['diez', 'once', 'doce', 'trece', 'catorce', 'quince',
          'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve']
_tens = ['', 'diez', 'veinte', 'treinta', 'cuarenta', 'cincuenta',
         'sesenta', 'setenta', 'ochenta', 'noventa']


def _num_a_palabras(n: int) -> str:
    if n < 0:
        return 'menos ' + _num_a_palabras(-n)
    if n == 0:
        return 'cero'
    if n < 10:
        return _units[n]
    if n < 20:
        return _teens[n - 10]
    if n < 100:
        t, u = divmod(n, 10)
        if n == 21:
            return 'veintiuno'
        if 21 < n < 30:
            return 'veinti' + _units[u]
        return _tens[t] + (' y ' + _units[u] if u else '')
    if n < 1000:
        c, r = divmod(n, 100)
        if c == 1 and r == 0:
            return 'cien'
        if c == 1:
            return 'ciento ' + _num_a_palabras(r)
        if c == 5:
            return 'quinientos' + (' ' + _num_a_palabras(r) if r else '')
        if c == 7:
            return 'setecientos' + (' ' + _num_a_palabras(r) if r else '')
        if c == 9:
            return 'novecientos' + (' ' + _num_a_palabras(r) if r else '')
        return _units[c] + 'cientos' + (' ' + _num_a_palabras(r) if r else '')
    if n < 1000000:
        t, r = divmod(n, 1000)
        prefix = 'mil' if t == 1 else _num_a_palabras(t) + ' mil'
        return prefix + (' ' + _num_a_palabras(r) if r else '')
    return str(n)


def normalizar(texto: str, idioma: str = "es") -> str:
    # markdown y emojis fuera: el TTS los lee literal
    texto = re.sub(r'[*_#`~\[\]]', '', texto)
    texto = re.sub(r'[\U0001F000-\U0001FAFF☀-➿⬀-⯿◆✦●☾]', ' ', texto)
    texto = re.sub(r'\s{2,}', ' ', texto)
    if idioma != "es":
        # en inglés los motores leen bien los dígitos (misaki los normaliza)
        return texto
    texto = re.sub(r'\b(\d{1,6})\b', lambda m: _num_a_palabras(int(m.group(1))), texto)
    abrevs = {
        'Sr.': 'Señor', 'Sra.': 'Señora', 'Dr.': 'Doctor', 'Dra.': 'Doctora',
        'etc.': 'etcétera', 'aprox.': 'aproximadamente', 'No.': 'Número',
    }
    for a, b in abrevs.items():
        texto = texto.replace(a, b)
    return texto


def _generar_kokoro(texto: str, voz: str):
    """Genera audio con Kokoro-82M (~50ms por frase en GPU). El prefijo del
    id de la voz elige el pipeline (e=español, a=inglés)."""
    pipe = kokoro_pipes.get(voz[0]) or next(iter(kokoro_pipes.values()))
    partes = []
    for resultado in pipe(texto, voice=voz, speed=1.0):
        audio = resultado.audio if hasattr(resultado, "audio") else resultado[2]
        if torch.is_tensor(audio):
            audio = audio.detach().cpu().numpy()
        partes.append(audio.astype(np.float32))
    return np.concatenate(partes) if partes else np.zeros(1, dtype=np.float32)


app = FastAPI()


@app.get("/salud")
def salud():
    return {
        **estado,
        "voces_kokoro": KOKORO_VOCES if estado["kokoro"] else [],
        "voz_defecto": KOKORO_VOZ_DEFECTO,
    }


@app.post("/tts")
async def tts(req: Request):
    datos = await req.json()
    texto = (datos.get("texto") or "").strip()
    if not texto:
        return JSONResponse({"error": "texto vacío"}, status_code=400)
    if not estado["kokoro"]:
        return JSONResponse({"error": "la voz aún no está lista"}, status_code=503)
    idioma = datos.get("idioma") if datos.get("idioma") in IDIOMAS else "es"
    voz = datos.get("voz") or KOKORO_VOZ_DEFECTO[idioma]
    if voz not in _KOKORO_IDS:  # nunca pasar un id arbitrario al modelo
        voz = KOKORO_VOZ_DEFECTO[idioma]
    with _tts_lock:
        audio = _generar_kokoro(normalizar(texto, idioma), voz)

    buf = io.BytesIO()
    sf.write(buf, audio, 24000, format="WAV", subtype="PCM_16")
    return Response(content=buf.getvalue(), media_type="audio/wav")


@app.post("/extraer")
async def extraer(req: Request):
    """Extrae texto de un PDF (PyMuPDF, ya presente en el venv de chatterbox)."""
    cuerpo = await req.body()
    if not cuerpo:
        return JSONResponse({"error": "pdf vacío"}, status_code=400)
    try:
        import fitz
        with fitz.open(stream=cuerpo, filetype="pdf") as doc:
            texto = "\n".join(pagina.get_text() for pagina in doc)
        return {"texto": texto[:20000]}
    except Exception as e:
        return JSONResponse({"error": f"no pude leer el PDF: {e}"}, status_code=400)


@app.post("/stt")
async def stt(req: Request):
    if not estado["stt"]:
        return JSONResponse({"error": "STT aún no está listo"}, status_code=503)
    cuerpo = await req.body()
    if not cuerpo:
        return JSONResponse({"error": "audio vacío"}, status_code=400)
    idioma = req.query_params.get("idioma")
    if idioma not in IDIOMAS:
        idioma = "es"
    try:
        resultado = whisper_pipe(
            cuerpo,
            generate_kwargs={"language": idioma},
            return_timestamps=True,
        )
    except Exception as e:  # típico: ffmpeg ausente o audio corrupto
        return JSONResponse({"error": f"stt: {e}"}, status_code=500)
    return {"texto": resultado["text"].strip()}


if __name__ == "__main__":
    print(f"[voz] Sidecar de voz del diario · puerto {PUERTO} · dispositivo {DEVICE}")
    threading.Thread(target=cargar_modelos, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=PUERTO, log_level="warning")
