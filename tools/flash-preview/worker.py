"""One private, network-isolated FlashTeX process per editor tab."""
import base64
import io
import json
import os
import socket
import struct
import subprocess
import sys
import time
import zipfile
from pathlib import Path

root = Path('/work/src')
out = Path('/work/out')
root.mkdir()
out.mkdir()
archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(sys.stdin.buffer.readline())))
if sum(f.file_size for f in archive.infolist()) > 350_000_000:
    raise ValueError('Project too large')
for item in archive.infolist():
    path = Path(item.filename)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Invalid project path')
    if item.is_dir():
        continue
    dest = root / path
    dest.parent.mkdir(parents=True, exist_ok=True)
    (out / path.parent).mkdir(parents=True, exist_ok=True)
    dest.write_bytes(archive.read(item))
del archive
sockpath = '/work/engine.sock'
host = subprocess.Popen(['/opt/flash/host', '--socket', sockpath, '--once', '--profile', 'high-performance'], stdout=sys.stderr)
for _ in range(300):
    if os.path.exists(sockpath):
        break
    if host.poll() is not None:
        raise RuntimeError('Engine stopped')
    time.sleep(.1)
sock = socket.socket(socket.AF_UNIX)
sock.connect(sockpath)
stream = sock.makefile('rb')

def send(kind, data):
    body = json.dumps(data).encode()
    sock.sendall(struct.pack('<IB', len(body)+1, kind) + body)

def frame():
    size, kind = struct.unpack('<IB', stream.read(5))
    if not 1 <= size <= 2**28:
        raise ValueError('Invalid engine frame')
    return kind, stream.read(size-1)

send(1, dict(protocol='display-list-v3',version=[3,2],client='Overleaf preview'))
assert frame()[0] == 0x41
def render(page):
    pdf = str(out/'preview.pdf')
    args = ['-f',str(page),'-l',str(page)]
    subprocess.run(['pdftoppm',*args,'-scale-to','1150','-singlefile','-png',pdf,'/work/page'],check=True,stdout=subprocess.DEVNULL)
    return dict(page=page,image=base64.b64encode(Path('/work/page.png').read_bytes()).decode())

revision = None
count = 0
for line in sys.stdin.buffer:
    req = json.loads(line)
    try:
        if 'renderRevision' in req:
            if req['renderRevision'] != revision or not 1 <= req['page'] <= count:
                raise ValueError('Preview revision expired')
            print(json.dumps(render(req['page'])),flush=True)
            continue
        revision = None
        file = root / req['path']
        if not file.resolve().is_relative_to(root) or not file.is_file():
            raise ValueError('Unknown document')
        old = file.read_bytes()
        new = req['text'].encode()
        # A bounded splice preserves the incremental engine's edit location.
        i = 0
        while i < min(len(new),len(old)) and new[i] == old[i]:
            i += 1
        while i and i < len(new) and new[i] & 0xc0 == 0x80:
            i -= 1
        j = 0
        while j < min(len(new),len(old))-i and new[-1-j] == old[-1-j]:
            j += 1
        while j and new[len(new)-j] & 0xc0 == 0x80:
            j -= 1
        edits = [] if old == new else [dict(path=req['path'], offset=i, delete=len(old)-i-j, insert=new[i:len(new)-j].decode())]
        main = req['main']
        if not (root/main).resolve().is_relative_to(root) or not (root/main).is_file():
            raise ValueError('Unknown main document')
        request = dict(id=req['id'], root=str(root),main=main,output_dir=str(out),jobname='preview',shell_escape='off',external_tools='off',incremental=True,edits=edits)
        cold = not (out/'preview.pdf').exists()
        for attempt in range(4 if cold else 1):
            send(2, request)
            pages = []
            while True:
                k,b = frame()
                if k == 0x45:
                    pages.append(struct.unpack_from('<I',b)[0])
                if k == 0x4a:
                    raise ValueError('Engine error')
                if k == 0x49:
                    done = json.loads(b)
                    break
            if done['status'] != 'ok' or not cold or done.get('mode') == 'unchanged':
                break
            if attempt == 0 and (out/'preview.aux').exists() and b'\\bibdata' in (out/'preview.aux').read_bytes():
                subprocess.run(['bibtex','preview'],cwd=out,env=dict(os.environ,BIBINPUTS=str(root)+'//:',BSTINPUTS=str(root)+'//:'),stdout=sys.stderr,timeout=30)
            request['edits'] = []
        if done['status'] != 'ok':
            raise ValueError('Typesetting failed')
        page = req.get('page') or (pages[0]+1 if pages else 1)
        page = max(1,min(page,done['pages']))
        revision = req['id']
        count = done['pages']
        result = dict(render(page),count=count,revision=revision,engine=done['elapsed_ms'],first=done.get('first_page_ms'))
    except (ValueError, OSError, subprocess.SubprocessError) as e:
        result = dict(error=str(e)[:120])
    print(json.dumps(result),flush=True)
