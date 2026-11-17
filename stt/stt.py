#!/usr/bin/env python3
# 语音转文字的小服务：只在本机 127.0.0.1 上听，调度台把录音发过来，这里用本地的 SenseVoice 模型认出文字。
# 录音不出这台服务器，也不落盘。
import glob, json, os, subprocess, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = sorted(glob.glob(os.path.join(HERE, 'sherpa-onnx-sense-voice*')))[0]
PORT = int(os.environ.get('STT_PORT', '4795'))
MAX_BYTES = 12 * 1024 * 1024
MAX_SECONDS = 90

recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=os.path.join(MODEL_DIR, 'model.int8.onnx'),
    tokens=os.path.join(MODEL_DIR, 'tokens.txt'),
    num_threads=4, use_itn=True, language='zh',   # 固定认中文：让它自己猜语言的话，一个字的中文会被猜成英文、日文、韩文
)
lock = threading.Lock()   # 一次只认一段，免得把 CPU 占满

# 语音合成（把 CEO Agent 的回答念出来）：本地的 MeloTTS 中英文模型，同样不出这台服务器。
import io, wave
tts = None
_tts_dirs = sorted(glob.glob(os.path.join(HERE, 'vits-melo-tts-zh_en*')))
if _tts_dirs:
    _d = _tts_dirs[0]
    _fsts = ','.join(p for p in [os.path.join(_d, n) for n in ('date.fst', 'number.fst', 'phone.fst')] if os.path.exists(p))
    tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(model=os.path.join(_d, 'model.onnx'), lexicon=os.path.join(_d, 'lexicon.txt'), tokens=os.path.join(_d, 'tokens.txt'), dict_dir=os.path.join(_d, 'dict')),
            num_threads=4, provider='cpu'),
        rule_fsts=_fsts, max_num_sentences=1))
tts_lock = threading.Lock()


def speak(text):
    with tts_lock:
        a = tts.generate(text, sid=0, speed=1.05)
    pcm = (np.clip(np.array(a.samples, dtype=np.float32), -1, 1) * 32767).astype(np.int16).tobytes()
    buf = io.BytesIO()
    w = wave.open(buf, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(a.sample_rate); w.writeframes(pcm); w.close()
    # 压成 mp3 传得快；压不了就直接给 wav。
    try:
        p = subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1'], input=buf.getvalue(), capture_output=True, timeout=30)
        if p.returncode == 0 and p.stdout:
            return 'audio/mpeg', p.stdout
    except Exception:
        pass
    return 'audio/wav', buf.getvalue()


def to_pcm(data):
    # 浏览器录的是 webm/ogg/mp4，统一让 ffmpeg 转成 16k 单声道。
    p = subprocess.run(
        ['ffmpeg', '-loglevel', 'error', '-i', 'pipe:0', '-t', str(MAX_SECONDS), '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
        input=data, capture_output=True, timeout=60)
    if p.returncode != 0 or not p.stdout:
        raise ValueError('这段录音读不出来')
    return np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32) / 32768.0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_tts(self, raw):
        text = str(json.loads(raw.decode('utf-8') or '{}').get('text') or '').strip()[:500]
        if not text or tts is None:
            return self.reply(400, {'error': '没有要念的内容，或者语音合成没有装好'})
        kind, body = speak(text)
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(200, {'ok': True})

    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
            if self.path.startswith('/tts'):
                return self.do_tts(self.rfile.read(min(n, 20000)))
            if n <= 0 or n > MAX_BYTES:
                return self.reply(400, {'error': '录音是空的或者太大'})
            samples = to_pcm(self.rfile.read(n))
            seconds = len(samples) / 16000
            if seconds < 0.3:
                return self.reply(200, {'text': '', 'seconds': seconds})
            with lock:
                s = recognizer.create_stream()
                s.accept_waveform(16000, samples)
                recognizer.decode_stream(s)
                text = s.result.text.strip()
            print('认出 %.1f 秒的录音，%d 个字' % (seconds, len(text)), flush=True)
            self.reply(200, {'text': text, 'seconds': round(seconds, 1)})
        except Exception as e:
            self.reply(500, {'error': str(e)[:200]})


if __name__ == '__main__':
    print('语音识别已就绪：127.0.0.1:%d，模型 %s' % (PORT, os.path.basename(MODEL_DIR)), flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
