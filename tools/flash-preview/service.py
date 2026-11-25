import asyncio
import base64
import hashlib
import json
import os
import re
import time
from pathlib import Path
from aiohttp import ClientSession, ClientTimeout, web

HERE = Path(__file__).resolve().parent
BASE = 'http://127.0.0.1:3082'
ORIGIN = 'https://overleaf-plus.axgu.top:26009'
sessions = {}
starting = set()

async def drop(key):
    state = sessions.pop(key,None)
    if state:
        state['proc'].stdin.close()
        await asyncio.create_subprocess_exec('docker','kill',state['name'],stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)

async def handle(r):
    if r.headers.get('Origin') != ORIGIN or r.content_type != 'application/json':
        raise web.HTTPForbidden()
    pid = r.match_info['pid']
    cookie = r.headers.get('Cookie','')
    data = await r.json()
    tab = data.get('tab','')
    if not re.fullmatch('[0-9a-f-]{36}',tab) or not cookie:
        raise web.HTTPForbidden()
    key = hashlib.sha256((pid+tab+cookie).encode()).hexdigest()
    headers = {'Cookie':cookie,'Host':'overleaf-plus.axgu.top:26009','X-Forwarded-Proto':'https'}
    async with ClientSession(headers=headers,timeout=ClientTimeout(total=90)) as client:
        async with client.get(BASE+'/project/'+pid+'/entities',allow_redirects=False) as res:
            if res.status != 200 or res.content_type != 'application/json':
                raise web.HTTPForbidden()
            paths = {e['path'].lstrip('/') for e in (await res.json())['entities'] if e['type']=='doc'}
        if data.get('close'):
            await drop(key)
            return web.json_response({})
        if data.get('path') not in paths or data.get('main') not in paths:
            raise web.HTTPBadRequest(text='Unknown source path')
        if key not in sessions:
            if key in starting or len(starting)+len(sessions)>=4:
                raise web.HTTPServiceUnavailable(text='Preview workers busy')
            starting.add(key)
            try:
                async with client.get(BASE+'/Project/'+pid+'/download/zip',allow_redirects=False) as res:
                    if res.status!=200: raise web.HTTPForbidden()
                    archive=bytearray()
                    async for part in res.content.iter_chunked(65536):
                        archive.extend(part)
                        if len(archive)>140_000_000: raise web.HTTPBadRequest(text='Project too large')
                name='overleaf-hot-'+key[:18]
                proc=await asyncio.create_subprocess_exec('docker','run','--rm','-i','--name',name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','100','--memory','3g','--cpus','2','--user','1000:1000','--tmpfs','/work:uid=1000,gid=1000,size=1g','--tmpfs','/tmp:size=128m','-v',str(HERE/'runtime')+':/opt/flash:ro','-v','/home/axgu/overleaf-toolkit/data/texlive:/usr/local/texlive:ro','-e','FLASHTEX_POOL=/opt/flash/pdftex.pool','-e','HOME=/work','-w','/work','--entrypoint','python3','overleafcep/sharelatex:6.3.0-ext-v5.1','/opt/flash/worker.py',stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,limit=12_000_000)
                sessions[key]=dict(proc=proc,name=name,lock=asyncio.Lock(),used=time.monotonic())
                proc.stdin.write(base64.b64encode(archive)+b'\n')
                await proc.stdin.drain()
            finally:
                starting.discard(key)
    state=sessions[key]
    async with state['lock']:
        state['used']=time.monotonic()
        try:
            state['proc'].stdin.write(json.dumps(data).encode()+b'\n')
            await state['proc'].stdin.drain()
            line=await asyncio.wait_for(state['proc'].stdout.readline(),90)
            result=json.loads(line)
        except Exception:
            await drop(key)
            raise web.HTTPServiceUnavailable(text='Preview worker stopped')
    return web.json_response(result,headers={'Cache-Control':'no-store'})

async def lifecycle(app):
    async def sweep():
        while True:
            await asyncio.sleep(60)
            for k,s in list(sessions.items()):
                if time.monotonic()-s['used']>600 and not s['lock'].locked(): await drop(k)
    task=asyncio.create_task(sweep())
    yield
    task.cancel()
    for k in list(sessions): await drop(k)

app=web.Application(client_max_size=5_000_000)
app.cleanup_ctx.append(lifecycle)
app.router.add_post('/flash-preview/{pid:[a-f0-9]{24}}',handle)
if os.environ.get('PREVIEW_SOCKET'):
    path = os.environ['PREVIEW_SOCKET']
    import socket
    endpoint = socket.socket(socket.AF_UNIX)
    Path(path).unlink(missing_ok=True)
    endpoint.bind(path)
    os.chmod(path,0o666)
    web.run_app(app,sock=endpoint,access_log=None)
else:
    web.run_app(app,host='127.0.0.1',port=3094,access_log=None)
