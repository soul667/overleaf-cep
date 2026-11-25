#!/usr/bin/env python3
"""Local-only configuration UI; it never serves stored API keys to browsers."""
import argparse
import hmac
import json
import os
import secrets
import tempfile
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import yaml

PAGE = Path(__file__).with_name('index.html').read_text(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--config', required=True)
parser.add_argument('--port', type=int, default=18974)
parser.add_argument('--runtime-env', default='')
args = parser.parse_args()
config_path = Path(args.config)
csrf = secrets.token_urlsafe(32)
origin = f'http://127.0.0.1:{args.port}'
TEXT_MODELS = ('gpt-6.1-terra', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol')
VOICE_MODELS = ('gpt-transcribe', 'gpt-live-transcribe', 'gpt-realtime-whisper')
EFFORTS = {model: (('none', 'low', 'medium', 'high', 'xhigh', 'max') if model == 'gpt-6.1-terra' or model == 'gpt-6-sol' else ('low', 'medium', 'high', 'xhigh', 'max')) for model in TEXT_MODELS}

def read_config():
    with config_path.open(encoding='utf-8') as file:
        data = yaml.safe_load(file) or {}
    if not isinstance(data, dict) or not isinstance(data.get('openai', {}), dict):
        raise ValueError('Invalid configuration')
    return data

def save_config(data):
    config_path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.ai-config-', dir=config_path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            yaml.safe_dump(data, out, allow_unicode=True, sort_keys=False)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, config_path)
    finally:
        if os.path.exists(name): os.unlink(name)

def save_runtime(data):
    if not args.runtime_env: return
    settings = data.get('openai', {})
    alpha = data.get('alphaxiv', {})
    values = {'OPENAI_API_KEY': settings.get('api_key', ''), 'OVERLEAF_AI_MODEL': settings.get('model', ''), 'OVERLEAF_AI_REASONING_EFFORT': settings.get('reasoning_effort', 'medium'), 'ALPHAXIV_API_KEY': alpha.get('api_key', '') if alpha.get('enabled') else ''}
    if any(not isinstance(x, str) or '\n' in x or '\r' in x for x in values.values()): raise ValueError('Invalid runtime configuration')
    path = Path(args.runtime_env)
    fd, temp = tempfile.mkstemp(prefix='.ai-runtime-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            for name, value in values.items(): f.write(name + '=' + value + '\n')
            f.flush(); os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp): os.unlink(temp)

def model_list(key):
    request = urllib.request.Request('https://api.openai.com/v1/models', headers={'Authorization': 'Bearer ' + key})
    with urllib.request.urlopen(request, timeout=15) as response:
        data = json.load(response)
    available = {x['id'] for x in data.get('data', []) if isinstance(x.get('id'), str)}
    return {'text': [x for x in TEXT_MODELS if x in available], 'voice': [x for x in VOICE_MODELS if x in available]}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def reply(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Cache-Control', 'no-store'); self.send_header('X-Content-Type-Options', 'nosniff'); self.end_headers(); self.wfile.write(body)
    def valid_host(self): return self.headers.get('Host') == f'127.0.0.1:{args.port}'
    def do_GET(self):
        if not self.valid_host(): return self.reply(403, {'error':'Invalid host'})
        if self.path == '/':
            body = PAGE.replace('__CSRF__', csrf).encode()
            self.send_response(200); self.send_header('Content-Type','text/html; charset=utf-8'); self.send_header('Cache-Control','no-store'); self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"); self.end_headers(); self.wfile.write(body); return
        if self.path == '/api/status':
            try:
                d=read_config(); settings=d.get('openai', {})
                return self.reply(200, {'key_configured': bool(settings.get('api_key')), 'model':settings.get('model',''), 'reasoning_effort':settings.get('reasoning_effort','medium'), 'transcription_model':settings.get('transcription_model',''), 'alphaxiv_enabled':bool(d.get('alphaxiv',{}).get('enabled',False) and d.get('alphaxiv',{}).get('api_key'))})
            except Exception: return self.reply(500, {'error':'配置读取失败'})
        self.reply(404, {'error':'Not found'})
    def do_POST(self):
        if not self.valid_host() or self.headers.get('Origin') != origin or not hmac.compare_digest(self.headers.get('X-Local-CSRF',''),csrf) or self.headers.get('Content-Type','').split(';')[0] != 'application/json': return self.reply(403, {'error':'请求被拒绝'})
        try:
            size=int(self.headers.get('Content-Length','0'))
            if size <= 0 or size > 16384: return self.reply(400, {'error':'请求格式错误'})
            data=json.loads(self.rfile.read(size)); config=read_config(); settings=config.setdefault('openai', {})
            if self.path == '/api/save':
                key=data.get('key',''); model=data.get('model',''); effort=data.get('reasoning_effort',''); voice=data.get('transcription_model','')
                if not isinstance(key,str) or not isinstance(model,str) or len(key)>512 or len(model)>150 or '\n' in key or '\n' in model: return self.reply(400, {'error':'输入格式错误'})
                if model not in TEXT_MODELS or effort not in EFFORTS.get(model, ()) or voice not in ('', *VOICE_MODELS): return self.reply(400, {'error':'请选择有效的文字模型、思考额度和语音模型'})
                if key.strip(): settings['api_key']=key.strip()
                settings['model']=model; settings['reasoning_effort']=effort; settings['transcription_model']=voice; save_config(config); save_runtime(config)
                return self.reply(200, {'ok':True,'key_configured':bool(settings.get('api_key'))})
            if self.path == '/api/models':
                key=data.get('key','') or settings.get('api_key','')
                if not isinstance(key,str) or not key.strip() or len(key)>512: return self.reply(400, {'error':'请先填写 API 密钥'})
                return self.reply(200, {'models':model_list(key.strip())})
            self.reply(404, {'error':'Not found'})
        except (urllib.error.URLError,TimeoutError): self.reply(502, {'error':'无法连接 OpenAI，或密钥不可用'})
        except Exception: self.reply(500, {'error':'操作失败，请检查配置文件权限或网络'})

if __name__ == '__main__':
    server=ThreadingHTTPServer(('127.0.0.1',args.port), Handler)
    print(f'配置页面：{origin}/', flush=True)
    server.serve_forever()
