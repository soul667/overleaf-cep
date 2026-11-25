"""Add the preview inside Overleaf's authenticated project router."""
import os,shutil,subprocess,tempfile
from pathlib import Path
here=Path(__file__).resolve().parent
home=Path.home()
deploy=home/'overleaf-ceplus-test'
dest=home/'.local/share/overleaf-flash-preview'
def run(*args,**kw):return subprocess.run(args,check=True,**kw)
dest.mkdir(exist_ok=True)
runtime=dest/'runtime'
runtime.mkdir(exist_ok=True)
socket_dir=dest/'ipc'
socket_dir.mkdir(mode=0o755,exist_ok=True)
shutil.copy2(here/'service.py',dest/'service.py')
for original,name in [(here/'worker.py','worker.py'),(Path('/tmp/flashtex-review/png-candidate-host'),'host'),(Path('/tmp/flashtex-review/latest/crates/flashtex-engine/pdftex.pool'),'pdftex.pool')]:shutil.copy2(original,runtime/name)
unit=home/'.config/systemd/user/overleaf-flash-preview.service'
unit.write_text('[Unit]\nDescription=Overleaf FlashTeX editing preview\n[Service]\nEnvironment=PREVIEW_SOCKET='+str(socket_dir/'worker.sock')+'\nExecStart=/usr/bin/python3 '+str(dest/'service.py')+'\nRestart=on-failure\nUMask=0077\n[Install]\nWantedBy=default.target\n')
compose=deploy/'compose.yml'
old=compose.read_text()
image=run('docker','inspect','--format={{.Image}}','overleaf-ceplus-test',capture_output=True,text=True).stdout.strip()
with tempfile.TemporaryDirectory() as td:
    ctx=Path(td)
    for filename,rel in [('router.mjs','app/src/router.mjs'),('ide.pug','app/views/project/ide-react.pug')]:
        run('docker','cp','overleaf-ceplus-test:/overleaf/services/web/'+rel,str(ctx/filename))
    f=ctx/'router.mjs'
    s=f.read_text()
    i=s.index("  webRouter.get(\n    '/project/:Project_id/entities'")
    f.write_text("import { preview } from './Features/FlashPreview.mjs'\n"+s[:i]+"""  webRouter.post(
    '/project/:Project_id/flash-preview',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanReadProject,
    preview
  )
"""+s[i:])
    f=ctx/'ide.pug'
    f.write_text(f.read_text()+"\nblock append foot-scripts\n\tscript(nonce=scriptNonce src='/flash-preview-editor.js' defer)\n")
    shutil.copy2(here/'preview.js',ctx/'preview.js')
    shutil.copy2(here/'controller.mjs',ctx/'controller.mjs')
    base=run('docker','inspect','--format={{.Config.Image}}','overleaf-ceplus-test',capture_output=True,text=True).stdout.strip()
    assert run('docker','image','inspect','--format={{.Id}}',base,capture_output=True,text=True).stdout.strip()==image
    (ctx/'Dockerfile').write_text('FROM '+base+'\nCOPY router.mjs /overleaf/services/web/app/src/router.mjs\nCOPY controller.mjs /overleaf/services/web/app/src/Features/FlashPreview.mjs\nCOPY ide.pug /overleaf/services/web/app/views/project/ide-react.pug\nCOPY preview.js /overleaf/services/web/public/flash-preview-editor.js\n')
    run('docker','build','--network=none','-t','overleaf-ceplus-flash:local',str(ctx))
assert old.count('image: '+base)==1
marker='      - ./data/overleaf:/var/lib/overleaf'
assert old.count(marker)==1
updated=old.replace('image: '+base,'image: overleaf-ceplus-flash:local').replace(marker,marker+'\n      - '+str(socket_dir)+':/run/flash-preview:ro')
backup=deploy/'compose.before-flash-preview.yml'
assert not backup.exists()
shutil.copy2(compose,backup)
run('systemctl','--user','daemon-reload')
run('systemctl','--user','enable','--now',unit.name)
compose.write_text(updated)
try:run('docker','compose','-f',str(compose),'up','-d','--no-deps','app')
except Exception:
    compose.write_text(old)
    run('docker','compose','-f',str(compose),'up','-d','--no-deps','app')
    raise
