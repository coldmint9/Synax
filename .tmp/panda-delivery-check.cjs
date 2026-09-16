const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const capture = process.argv.includes('--screenshots');
app.disableHardwareAcceleration();
const errors = [];
const assert = (ok, message) => { if (!ok) throw new Error(message); };
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width:1440, height:1030, show:false, webPreferences:{ offscreen:true, backgroundThrottling:false, nodeIntegration:false, contextIsolation:true } });
  win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error(event.message); } });
  await win.loadFile(path.resolve('panda-delivery.html'));
  const result = await win.webContents.executeJavaScript(`(() => {
    const assert = (ok, message) => { if (!ok) throw Error(message); };
    const scene = document.querySelector('.scene');
    const animations = scene.getAnimations({subtree:true});
    assert(animations.length >= 16, 'CSS animations missing');
    const period=selector=>parseFloat(getComputedStyle(document.querySelector(selector)).animationDuration);
    assert(Math.abs(period('.crank-spin')/period('.wheel-spin')-1.45)<.00001,'Wheel gear ratio mismatch');
    assert(Math.abs(240/period('.road-scroll')-2*Math.PI*90/period('.wheel-spin'))<.01,'Tyres sliding on the road');
    assert(Math.abs(11/period('.chain')-2*Math.PI*26/period('.crank-spin'))<.01,'Chain speed mismatch');
    const matrix = id => new DOMMatrix(getComputedStyle(document.getElementById(id)).transform);
    const point = (m,x=0,y=0) => ({x:m.a*x+m.c*y+m.e,y:m.b*x+m.d*y+m.f});
    const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
    let maxError=0;
    for (let sample=0; sample<=720; sample++) {
      const time=sample/720*500, angle=sample/720*2*Math.PI;
      for (const animation of animations) animation.currentTime=time;
      const pedals={};
      for (const [side,phase] of [['near',0],['far',Math.PI]]) {
        const thigh=matrix(side+'-thigh'),shin=matrix(side+'-shin'),foot=matrix(side+'-foot'),pedal=matrix(side+'-pedal');
        const expected={x:470+32*Math.cos(angle+phase),y:410+32*Math.sin(angle+phase)};
        const ankle=point(foot),actualPedal=point(pedal);
        const errors=[distance(point(thigh),{x:438,y:304}),distance(point(thigh,78),point(shin)),distance(point(shin,77),ankle),distance({x:ankle.x,y:ankle.y+12},actualPedal),distance(actualPedal,expected),Math.abs(distance(point(thigh),point(thigh,78))-78),Math.abs(distance(point(shin),point(shin,77))-77)];
        maxError=Math.max(maxError,...errors);
        assert(Math.max(...errors)<.025,'Kinematics mismatch at '+sample+' '+side+': '+errors);
        assert(point(shin).x>=438,'Knee bent backward');
        pedals[side]=actualPedal;
      }
      assert(Math.abs((pedals.near.x+pedals.far.x)/2-470)<.001 && Math.abs((pedals.near.y+pedals.far.y)/2-410)<.001,'Pedals not opposite');
      const crank=new DOMMatrix(getComputedStyle(document.querySelector('.crank-spin')).transform);
      assert(distance(point(crank,32),{x:pedals.near.x-470,y:pedals.near.y-410})<.025,'Crank lost pedal');
    }
    for (const animation of animations) animation.currentTime=90;
    const slider=document.getElementById('cadence');
    slider.value='200'; slider.dispatchEvent(new Event('input'));
    assert(document.getElementById('cadence-value').textContent.includes('200'),'Speed control failed');
    assert(document.getElementById('speed-value').textContent==='37.2','Speed ratio incorrect');
    document.getElementById('pause').click();
    assert(scene.classList.contains('paused'),'Pause class missing');
    assert(document.getElementById('speed-value').textContent==='0.0','Paused speed incorrect');
    assert(scene.getAnimations({subtree:true}).every(a=>a.playState==='paused'),'Pause did not freeze all animation');
    document.getElementById('pause').click();
    assert(!scene.classList.contains('paused'),'Resume failed');
    slider.value='150'; slider.dispatchEvent(new Event('input'));
    // Freeze a readable pose for inspection, without changing page controls.
    for (const animation of animations) { animation.pause(); animation.currentTime=85; }
    assert(document.documentElement.scrollWidth<=innerWidth,'Desktop horizontal overflow');
    return {animations:animations.length,sampledPoses:1442,maxJointErrorPx:maxError,speedControl:true,pauseResume:true,desktopOverflow:false};
  })()`);
  if(capture) fs.writeFileSync('.tmp/panda-delivery-desktop.png',(await win.webContents.capturePage()).toPNG());
  win.setContentSize(390,1130);
  await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const mobile = await win.webContents.executeJavaScript(`(() => {
    const art=document.querySelector('.art').getBoundingClientRect();
    const scene=document.querySelector('.scene').getBoundingClientRect();
    return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,artWidth:art.width,sceneWidth:scene.width};
  })()`);
  if(capture) fs.writeFileSync('.tmp/panda-delivery-mobile.png',(await win.webContents.capturePage()).toPNG());
  assert(!mobile.overflow,'Mobile horizontal overflow');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await win.reload();
  await new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
  const reducedMotion=await win.webContents.executeJavaScript("document.querySelector('.scene').classList.contains('paused') && document.querySelector('.scene').getAnimations({subtree:true}).every(a=>a.playState==='paused')");
  assert(reducedMotion,'Reduced motion must start paused');
  assert(errors.length===0,'Browser errors: '+errors.join('; '));
  console.log(JSON.stringify({ok:true,...result,mobile,reducedMotion,browserErrors:errors,rollingAndChainSpeed:true,screenshotsCaptured:capture},null,2));
  app.exit(0);
}).catch(error=>{console.error(error, errors);app.exit(1);});
