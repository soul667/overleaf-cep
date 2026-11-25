(() => {
  const pid = location.pathname.match(/^\/project\/([a-f0-9]{24})\/?$/)?.[1]
  if (!pid) return
  const mount = document.createElement('div')
  mount.id = 'flash-preview-reader'
  mount.style.cssText = 'position:absolute;inset:0;overflow:auto;background:var(--pdf-bg,#525659)'
  const ui = mount.attachShadow({mode:'open'})
  ui.innerHTML = `<style>
  :host{font:13px system-ui;color:var(--content-primary,#333)}
  header{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:center;gap:.5rem;padding:4px;background:var(--bg-light-primary,#fff);border-bottom:1px solid #8885}
  button,select{font:inherit;color:inherit;background:transparent;border:0;cursor:pointer}button:disabled{opacity:.35}
  #sheet{padding:8px;display:grid;gap:10px}figure{background:white;aspect-ratio:8.5/11;width:100%;max-width:1150px;margin:auto;box-shadow:0 1px 5px #0005}img{display:block;width:100%;height:auto}
  #status:empty{display:none}
  </style><header><select aria-label="主文件"></select><span id="page"></span><span id="status" role="status"></span></header><div id="sheet"></div>`
  const el = s=>ui.querySelector(s)
  const select=el('select'), status=el('#status')
  const styles=document.createElement('style')
  styles.textContent=`
    .pdf-viewer:has(> #flash-preview-reader)>:not(#flash-preview-reader){visibility:hidden}
    .pdf:has(#flash-preview-reader) .toolbar-pdf-controls{visibility:hidden}
    .compile-button-group:has([data-hot-selected]) .flash-native-mode .dropdown-item-trailing-icon{display:none}
  `
  document.head.append(styles)
  let tab, paths=[], serial=0, busy=false, pending=false, page=0, count=0
  const store=()=>window.overleaf?.unstable?.store
  function pathFor(name) {
    const matches=paths.filter(p=>p===name || p.endsWith('/'+name))
    if(matches.length!==1) throw Error('无法唯一确定当前文件路径')
    return matches[0]
  }
  function close(){
    const previous=tab
    revision=null;count=0;tab=null;serial++;pending=false;mount.remove(); document.querySelector('[data-hot-selected]')?.removeAttribute('data-hot-selected')
    if(previous) fetch('/project/'+pid+'/flash-preview',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':document.querySelector('meta[name="ol-csrfToken"]').content},body:JSON.stringify({tab:previous,close:true})}).catch(()=>{})
  }
  let revision=null, filling=false
  const sheet=el('#sheet')
  function currentPage(){
    if(mount.scrollTop>0 && mount.scrollHeight-mount.scrollTop-mount.clientHeight<=2)return count
    const top=mount.getBoundingClientRect().top+el('header').offsetHeight
    return Array.from(sheet.children).findIndex(slot=>slot.getBoundingClientRect().bottom>top)+1 || count
  }
  function showPosition(){
    if(count)el('#page').textContent=currentPage()+' / '+count
  }
  mount.addEventListener('scroll',showPosition,{passive:true})
  async function request(data){
    const r=await fetch('/project/'+pid+'/flash-preview',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':document.querySelector('meta[name="ol-csrfToken"]').content},body:JSON.stringify(data)})
    if(!r.ok)throw Error('预览服务 '+r.status)
    const result=await r.json()
    if(result.error)throw Error(result.error)
    return result
  }
  async function paint(result,version){
    const img=new Image()
    img.alt='第 '+result.page+' 页'
    img.src='data:image/png;base64,'+result.image
    await img.decode()
    if(revision!==version || !tab)return
    const slot=sheet.children[result.page-1]
    slot.style.aspectRatio=img.naturalWidth+' / '+img.naturalHeight
    slot.replaceChildren(img)
    slot.dataset.version=String(version.id)
  }
  async function fill(){
    if(filling)return
    filling=true
    try{
      while(tab && revision && !busy && !pending){
        const version=revision
        const current=currentPage()
        const missing=Array.from(sheet.children).filter(slot=>slot.dataset.version!==String(version.id))
        if(!missing.length)break
        missing.sort((a,b)=>Math.abs(Number(a.dataset.page)-current)-Math.abs(Number(b.dataset.page)-current))
        const data={...version,renderRevision:version.id,page:Number(missing[0].dataset.page)}
        const result=await request(data)
        await paint(result,version)
      }
    }catch(e){if(tab && !busy)status.textContent=e.message}
    finally{filling=false}
  }
  async function update(){
    if(!tab)return
    const id=++serial
    if(busy){pending=true;return}
    busy=true;pending=false
    try{
      const v=store()?.get('editor.view')
      if(!v)throw Error('请先打开源码文件')
      const data={id,tab,path:pathFor(store().get('editor.open_doc_name')),main:select.value,text:v.state.doc.toString(),page}
      status.textContent='正在排版…'
      const result=await request(data)
      if(id!==serial || !tab)return
      count=result.count
      while(sheet.children.length>count)sheet.lastElementChild.remove()
      while(sheet.children.length<count){
        const slot=document.createElement('figure')
        slot.dataset.page=String(sheet.children.length+1)
        sheet.append(slot)
      }
      revision={id,tab,path:data.path,main:data.main}
      await paint(result,revision)
      page=result.page
      showPosition()
      status.textContent=''
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        if(id===serial && tab)window.dispatchEvent(new CustomEvent('flash-preview-painted',{detail:{id,page,engine:result.engine,first:result.first}}))
      }))
    }catch(e){if(id===serial)status.textContent=e.message}
    finally{busy=false;if(pending && tab)update();else fill()}
  }
  async function open(){
    if(tab)return
    tab=crypto.randomUUID()
    const opening=tab
    const viewer=document.querySelector('.pdf-viewer')
    if(!viewer){close();return}
    viewer.append(mount)
    el('#sheet').replaceChildren()
    el('#page').textContent=''
    status.textContent='正在打开热预览…'
    try{
      const r=await fetch('/project/'+pid+'/entities')
      const entities=(await r.json()).entities
      if(opening!==tab)return
      paths=entities.filter(e=>e.type==='doc').map(e=>e.path.replace(/^\//,''))
      select.replaceChildren(...paths.filter(p=>p.endsWith('.tex')).map(p=>new Option(p,p)))
      select.value=paths.includes('main.tex')?'main.tex':select.options[0]?.value
      page=0;update()
    }catch(e){status.textContent=e.message}
  }
  function syncMenu(){
    const group=document.querySelector('.compile-button-group')
    const fast=group?.querySelector('.dropdown-menu button .subdued')?.closest('li')
    if(!fast)return
    const normal=fast.previousElementSibling
    let item=fast.nextElementSibling
    if(!item?.matches('[data-hot-mode]')){
      item=document.createElement('li')
      item.dataset.hotMode=''
      item.setAttribute('role','none')
      const button=fast.querySelector('button').cloneNode(false)
      button.textContent='热'
      button.onclick=()=>{
        group.querySelector('.compile-dropdown-toggle')?.click()
        open()
      }
      item.append(button)
      fast.after(item)
    }
    for(const row of [normal,fast]){
      row.classList.add('flash-native-mode')
      if(!row.dataset.hotListener){
        row.dataset.hotListener='1'
        row.addEventListener('click',close,true)
      }
    }
    item.toggleAttribute('data-hot-selected',Boolean(tab))
    const button=item.firstElementChild
    if(tab && !button.lastElementChild){
      const check=document.createElement('span')
      check.className='material-symbols dropdown-item-trailing-icon'
      check.setAttribute('aria-hidden','true')
      check.textContent='check'
      button.append(check)
    }else if(!tab && button.lastElementChild)button.lastElementChild.remove()
  }
  const observer=new MutationObserver(syncMenu)
  observer.observe(document.body,{childList:true,subtree:true})
  syncMenu()
  select.onchange=()=>{page=0;update()}
  window.addEventListener('UNSTABLE_editor:extensions',event=>{
    const {CodeMirror,extensions}=event.detail
    extensions.push(CodeMirror.ViewPlugin.define(()=>({update(u){if(u.docChanged && tab){page=0;queueMicrotask(update)}}})))
  })
  window.dispatchEvent(new Event('editor:extension-loaded'))
})()
