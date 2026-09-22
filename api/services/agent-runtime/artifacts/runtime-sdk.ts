/** Compiler-owned bootstrap. Only handshake, theme and bounded sizing cross the sandbox. */
export function artifactSdkSource(): string {
  return String.raw`(() => {
    const meta = document.querySelector('meta[name="synax-artifact-runtime"]');
    let config;
    try { config = JSON.parse(meta?.content || 'null'); } catch {}
    meta?.remove();
    if (!config || config.protocol !== 1 || !['instanceId','prototypeId','nonce'].every(k => typeof config[k] === 'string' && config[k].length)) return;
    let port, connected = false, serial = 0, lastHeight = 0;
    const pending = new Map(), themes = new Set();
    let resolveReady, rejectReady;
    const ready = new Promise((resolve,reject) => { resolveReady = resolve; rejectReady = reject; });
    ready.catch(() => {});
    const deadline = setTimeout(() => rejectReady(new Error('Prototype connection timed out')),5000);
    const valid = m => m && m.protocol === 1 && m.instanceId === config.instanceId && m.prototypeId === config.prototypeId && m.nonce === config.nonce;
    const send = message => {
      if (new TextEncoder().encode(JSON.stringify(message)).length > 32768) throw new Error('Prototype message too large');
      if (config.transport === 'desktop') window.postMessage(message,'*');
      else port?.postMessage(message);
    };
    const envelope = (type,payload,requestId) => ({...config,type,payload,...(requestId ? {requestId} : {})});
    const request = (type,payload) => new Promise((resolve,reject) => {
      if (!connected || pending.size >= 32) return reject(new Error('Prototype is not connected or busy'));
      const id=String(++serial), timer=setTimeout(()=>{pending.delete(id);reject(new Error('Prototype request timed out'));},5000);
      pending.set(id,{resolve,reject,timer}); send(envelope(type,payload,id));
    });
    let theme='light';
    function setTheme(next) {
      theme=next==='dark'?'dark':'light';
      document.documentElement.dataset.theme=theme;
      document.documentElement.style.colorScheme=theme;
      document.documentElement.style.setProperty('--synax-bg',theme==='dark'?'#141820':'#ffffff');
      document.documentElement.style.setProperty('--synax-fg',theme==='dark'?'#e9edf4':'#24242b');
      themes.forEach(fn=>fn(theme));
    }
    function receive(m) {
      if (!valid(m)) return;
      if (m.type==='theme') setTheme(m.payload?.theme);
      if (m.type==='response') {
        const item=pending.get(m.requestId); if(!item) return;
        clearTimeout(item.timer);pending.delete(m.requestId);
        if(m.payload?.error) item.reject(new Error(m.payload.error)); else item.resolve(m.payload?.result);
      }
    }
    function connect(event) {
      if (!valid(event.data)) return;
      if (config.transport==='desktop') {
        if(event.source!==window) return;
        if(event.data.type!=='connect') { receive(event.data);return; }
      } else if(event.source!==parent || event.data.type!=='connect' || !event.ports?.[0]) return;
      if(connected) return;
      if(config.transport!=='desktop') { port=event.ports[0];port.onmessage=e=>receive(e.data);port.start();window.removeEventListener('message',connect); }
      connected=true;
      request('ready',{}).then(info=>{clearTimeout(deadline);setTheme(info?.theme);resolveReady({theme,locale:info?.locale||navigator.language});measure();},rejectReady);
    }
    window.addEventListener('message',connect);
    const api=Object.freeze({
      ready:()=>ready,
      onThemeChange(fn){themes.add(fn);return()=>themes.delete(fn);},
      reportHeight(height){
        if(!connected || typeof height!=='number' || !Number.isFinite(height)) return;
        const next=Math.max(96,Math.min(720,Math.ceil(height)));
        if(next===lastHeight)return;lastHeight=next;
        request('resize',{height:next}).catch(()=>{});
      }
    });
    Object.defineProperty(window,'synaxWidget',{value:api,writable:false,configurable:false});
    let queued=false;
    function measure(){
      if(queued)return;queued=true;
      requestAnimationFrame(()=>{queued=false;const body=document.body;if(!body||!document.documentElement.clientWidth)return;
        const range=document.createRange();range.selectNodeContents(body);
        const r=body.getBoundingClientRect(),content=range.getBoundingClientRect(),s=getComputedStyle(body),px=v=>parseFloat(v)||0;
        api.reportHeight(Math.max(r.bottom,content.bottom+px(s.paddingBottom)+px(s.borderBottomWidth))+scrollY+px(s.marginBottom));
      });
    }
    function observe(){if(typeof ResizeObserver!=='undefined')new ResizeObserver(measure).observe(document.body);measure();}
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',observe,{once:true});else observe();
    window.addEventListener('pagehide',()=>{port?.close();clearTimeout(deadline);for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Prototype closed'));}pending.clear();},{once:true});
    if(config.transport==='desktop')window.postMessage(envelope('hello',{}),'*');else parent.postMessage(envelope('hello',{}),'*');
  })();`;
}
