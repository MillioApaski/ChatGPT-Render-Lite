import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=12000){
  const end=Date.now()+ms;
  while(Date.now()<end){try{const x=await fn();if(x)return x;}catch{}await sleep(80);}
  throw Error('Timed out waiting for browser condition');
}
async function cdp(port){
  const target=await until(async()=>{
    const data=await(await fetch('http://127.0.0.1:'+port+'/json')).json();
    return data.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);
  });
  const socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
    socket.addEventListener('open',resolve,{once:true});
    socket.addEventListener('error',reject,{once:true});
  });
  const pending=new Map(),errors=[];let seq=0;
  socket.addEventListener('message',e=>{
    const msg=JSON.parse(String(e.data));
    if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params?.exceptionDetails?.text);
    const p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);
    msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result);
  });
  const call=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++seq;pending.set(id,{resolve,reject});
    socket.send(JSON.stringify({id,method,params}));
  });
  const run=async expression=>{
    const res=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(res.exceptionDetails)throw Error(res.exceptionDetails.exception?.description||res.exceptionDetails.text);
    return res.result.value;
  };
  await call('Page.enable');await call('Runtime.enable');
  return {socket,call,run,errors};
}
const fixture=String.raw`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;font:14px system-ui}main{width:75%;margin:30px auto}
#messages article{padding:18px;border-bottom:1px solid #ccc}
form{position:sticky;bottom:0;background:white;padding:14px}
</style></head><body><aside>原侧边栏</aside><main>
<div id="messages"></div><form id="composer">
<textarea aria-label="输入框"></textarea><button>发送</button></form></main>
<script>
for(let i=0;i<90;i++){
const row=document.createElement('article');
row.setAttribute('data-testid','conversation-turn-'+i);
row.setAttribute('data-message-author-role',i%2?'assistant':'user');
row.textContent='第 '+i+' 条消息：'+('不同长度的历史对话内容。'.repeat(i%9+1));
document.querySelector('#messages').append(row);
}
document.querySelector('#messages').firstElementChild['__reactFiber$example']={tag:5,type:'div',return:null};
</script><script src="/bridge.js"></script></body></html>`;
test('real Chromium bridge: native preview, reversible takeover, route guard', {timeout:60000}, async t=>{
  const binary=process.env.CHROME_BIN||'chromium';
  if(spawnSync(binary,['--version'],{stdio:'ignore'}).status!==0)
    return t.skip('Chromium unavailable');
  const source=await readFile(new URL('../chatgpt-native-render-bridge.user.js',import.meta.url),'utf8');
  const server=createServer((req,res)=>{
    if(req.url==='/bridge.js'){
      res.setHeader('Content-Type','text/javascript');
      res.end(source);
    }else{
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(fixture);
    }
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const profile=await mkdtemp(join(tmpdir(),'bridge-lab-'));
  let proc,client;
  try{
    proc=spawn(binary,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
      '--remote-allow-origins=*','--remote-debugging-port=0',
      '--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
    const port=await until(async()=>Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]));
    client=await cdp(port);
    await client.call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/c/test'});
    await until(()=>client.run('!!window.ChatGPTRenderLiteBridge'));
    assert.equal(await client.run('ChatGPTRenderLiteBridge.status().mode'),'off');
    assert.equal(await client.run("document.querySelectorAll('[data-rl-native-bridge]').length"),0);
    const probe=await client.run('ChatGPTRenderLiteBridge.probe()');
    assert.equal(probe.counts['[data-testid^="conversation-turn-"]'],90);
    const fiber=await client.run('ChatGPTRenderLiteBridge.fiberProbe()');
    assert.equal(fiber.samples[0].found,true);
    let result=await client.run("ChatGPTRenderLiteBridge.start('preview')");
    assert.equal(result.mode,'preview');
    assert.equal(result.messages,90);
    assert.ok(result.mounted<40);
    assert.equal(await client.run("document.querySelector('#messages').style.display"),'');
    assert.equal(await client.run("document.querySelector('#composer textarea').isConnected"),true);
    await client.run("document.querySelector('#messages').lastElementChild.textContent='新回复 <script>not executed</script>'");
    await new Promise(r=>setTimeout(r,950));
    console.log('PHASE6_BRIDGE_DEBUG',await client.run("({status:ChatGPTRenderLiteBridge.status(),lastDOM:document.querySelector('#messages').lastElementChild.textContent,mirrorLast:[...document.querySelector('[data-rl-native-bridge]').shadowRoot.querySelectorAll('.turn')].at(-1)?.textContent,scrollerTop:document.querySelector('[data-rl-native-bridge]').shadowRoot.querySelector('.scroll')?.scrollTop,scrollerHeight:document.querySelector('[data-rl-native-bridge]').shadowRoot.querySelector('.scroll')?.scrollHeight,clientHeight:document.querySelector('[data-rl-native-bridge]').shadowRoot.querySelector('.scroll')?.clientHeight,spacers:[...document.querySelector('[data-rl-native-bridge]').shadowRoot.querySelectorAll('.timeline-spacer')].map(e=>({height:e.style.height,computed:getComputedStyle(e).height})),rowIndices:[...document.querySelector('[data-rl-native-bridge]').shadowRoot.querySelectorAll('.turn')].map(e=>e.dataset.index).slice(-4)})"));
    await until(()=>client.run("document.querySelector('[data-rl-native-bridge]')?.shadowRoot.textContent.includes('新回复')"));
    assert.equal(await client.run("document.querySelector('[data-rl-native-bridge]').shadowRoot.querySelectorAll('script').length"),0);
    await client.run('window.confirm=()=>true');
    result=await client.run("ChatGPTRenderLiteBridge.start('takeover')");
    assert.equal(result.mode,'takeover');
    assert.equal(await client.run("document.querySelector('#messages').style.display"),'none');
    assert.equal(await client.run("document.querySelector('#composer textarea').isConnected"),true);
    await client.run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    assert.equal(await client.run("document.querySelector('#messages').style.display"),'');
    assert.equal(await client.run('ChatGPTRenderLiteBridge.status().mode'),'off');
    await client.run("ChatGPTRenderLiteBridge.start('preview')");
    await client.run("history.pushState({},'','/c/new-conversation')");
    await until(()=>client.run("ChatGPTRenderLiteBridge.status().mode==='off'"),6000);
    assert.deepEqual(client.errors,[]);
  }finally{
    try{client?.socket.close();}catch{}
    proc?.kill('SIGKILL');
    await new Promise(r=>server.close(r));
    await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:90});
  }
});
