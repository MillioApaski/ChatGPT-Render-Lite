// ==UserScript==
// @name         ChatGPT Render Lite · Native Bridge Lab
// @namespace    https://github.com/MillioApaski/ChatGPT-Render-Lite
// @version      0.1.0
// @description  Opt-in original ChatGPT page renderer bridge experiment. Restores native UI on failure.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(()=>{
'use strict';
// A variable-height Fenwick tree: O(log n) updates, prefix lookups and offset→row.
class HeightIndex {
  constructor(count = 0, estimate = 180) {
    if (!Number.isFinite(estimate) || estimate <= 0) throw new RangeError('Invalid estimate');
    this.estimate = estimate;
    this.reset(count);
  }

  reset(count) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Invalid count');
    this.heights = new Array(count).fill(this.estimate);
    this.rebuild();
  }

  rebuild() {
    const n = this.heights.length;
    this.tree = new Float64Array(n + 1);
    for (let i = 1; i <= n; i++) {
      this.tree[i] += this.heights[i - 1];
      const parent = i + (i & -i);
      if (parent <= n) this.tree[parent] += this.tree[i];
    }
  }

  get length() { return this.heights.length; }
  get total() { return this.prefix(this.length); }

  prefix(end) {
    if (!Number.isSafeInteger(end) || end < 0 || end > this.length) {
      throw new RangeError('Prefix index out of range');
    }
    let sum = 0;
    for (let i = end; i > 0; i -= i & -i) sum += this.tree[i];
    return sum;
  }

  update(index, height) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError('Height index out of range');
    }
    if (!Number.isFinite(height) || height <= 0) return 0;
    const next = Math.max(1, Math.ceil(height));
    const delta = next - this.heights[index];
    if (!delta) return 0;
    this.heights[index] = next;
    for (let i = index + 1; i <= this.length; i += i & -i) this.tree[i] += delta;
    return delta;
  }

  indexAt(offset) {
    if (!this.length) return 0;
    const target = Math.max(0, Math.min(this.total - 0.001, Number(offset) || 0));
    let index = 0;
    let sum = 0;
    let bit = 1;
    while ((bit << 1) <= this.length) bit <<= 1;
    for (; bit > 0; bit >>= 1) {
      const next = index + bit;
      if (next <= this.length && sum + this.tree[next] <= target) {
        index = next;
        sum += this.tree[next];
      }
    }
    return Math.min(index, this.length - 1);
  }

  prepend(count) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Invalid prepend count');
    if (!count) return;
    this.heights = new Array(count).fill(this.estimate).concat(this.heights);
    this.rebuild();
  }
}

function visibleRange(heights, scrollTop, viewportHeight, overscanPx = 800) {
  if (!heights.length) return { start: 0, end: 0, top: 0, bottom: 0 };
  const top = Math.max(0, scrollTop);
  const over = Math.max(0, overscanPx);
  const start = heights.indexAt(Math.max(0, top - over));
  const edge = Math.max(0, top + Math.max(1, viewportHeight) + over);
  const end = Math.min(heights.length, heights.indexAt(edge) + 1);
  return {
    start, end,
    top: heights.prefix(start),
    bottom: heights.total - heights.prefix(end),
  };
}

const MAX_FULL_ROWS = 1200;

function element(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

// Deliberately safe subset: no innerHTML, remote images, links or untrusted HTML.
// Its different fidelity from ChatGPT's rich renderer is documented in README.
function renderSafeText(text, destination) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let code = false;
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    destination.append(element(code ? 'pre' : 'p', code ? 'code-block' : 'paragraph', buffer.join('\n')));
    buffer = [];
  };
  for (const line of lines) {
    if (/^\s*`{3}/.test(line)) {
      flush();
      code = !code;
      continue;
    }
    if (!code && /^\s*#{1,3}\s+/.test(line)) {
      flush();
      destination.append(element('h3', 'message-heading', line.replace(/^\s*#{1,3}\s+/, '')));
    } else if (!code && /^\s*[-*]\s+/.test(line)) {
      flush();
      destination.append(element('p', 'bullet', '• ' + line.replace(/^\s*[-*]\s+/, '')));
    } else if (!code && line.trim() === '') {
      flush();
    } else {
      buffer.push(line);
    }
  }
  flush();
}

function createTurn(message, index) {
  const row = element('article', 'turn turn--' + (message.role === 'user' ? 'user' : 'assistant'));
  row.dataset.index = String(index);
  const header = element('header', 'turn-header');
  header.append(element('strong', '', message.role === 'user' ? '你' : message.role === 'assistant' ? 'ChatGPT' : message.role));
  header.append(element('span', 'turn-number', '#' + (index + 1)));
  const body = element('div', 'turn-body');
  renderSafeText(message.text, body);
  row.append(header, body);
  return row;
}

class VirtualTimeline {
  constructor(scroller, { estimate = 220, overscanPx = 900, onStats = () => {} } = {}) {
    if (!scroller) throw new TypeError('Scroller required');
    this.scroller = scroller;
    this.estimate = estimate;
    this.overscanPx = overscanPx;
    this.onStats = onStats;
    this.messages = [];
    this.index = new HeightIndex(0, estimate);
    this.mode = 'virtual';
    this.nodes = new Map();
    this.raf = 0;
    this.destroyed = false;
    this.topSpacer = element('div', 'timeline-spacer');
    this.rows = element('div', 'timeline-rows');
    this.bottomSpacer = element('div', 'timeline-spacer');
    const surface = element('div', 'timeline-surface');
    surface.append(this.topSpacer, this.rows, this.bottomSpacer);
    scroller.replaceChildren(surface);
    this.onScroll = () => this.scheduleRender();
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => this.onResize(entries)) : null;
  }

  setMessages(messages, { toBottom = true } = {}) {
    if (!Array.isArray(messages)) throw new TypeError('Messages must be an array');
    this.messages = messages;
    this.index.reset(messages.length);
    this.resetNodes();
    this.scroller.scrollTop = 0;
    this.render(); // Establish spacers and scroll height before setting bottom.
    if (toBottom && this.messages.length) {
      this.scroller.scrollTop = this.index.total;
      this.render();
    }
  }

  setMode(mode) {
    if (mode !== 'virtual' && mode !== 'full') throw new RangeError('Unknown render mode');
    if (mode === 'full' && this.messages.length > MAX_FULL_ROWS) {
      throw new RangeError('Full DOM baseline is limited to 1,200 messages to avoid freezing the browser.');
    }
    if (mode === this.mode) return;
    this.mode = mode;
    this.resetNodes();
    this.scroller.scrollTop = 0;
    this.render();
  }

  prepend(messages) {
    if (!Array.isArray(messages) || !messages.length) return;
    if (this.mode === 'full' && this.messages.length + messages.length > MAX_FULL_ROWS) {
      throw new RangeError('Full DOM baseline limit exceeded.');
    }
    const oldTop = this.scroller.scrollTop;
    const delta = messages.length * this.estimate;
    this.messages = messages.concat(this.messages);
    this.index.prepend(messages.length);
    this.resetNodes();
    this.render(); // Update scroll height before applying the anchor adjustment.
    this.scroller.scrollTop = oldTop + delta;
    this.render();
  }

  jumpTo(index) {
    const i = Math.max(0, Math.min(this.messages.length - 1, Math.trunc(index)));
    if (!this.messages.length) return;
    // In full mode, the rendered DOM may have different real heights.
    if (this.mode === 'full') this.rows.children[i]?.scrollIntoView({ block: 'start' });
    else this.scroller.scrollTop = this.index.prefix(i);
    this.scheduleRender();
  }

  scheduleRender() {
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  resetNodes() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.nodes.clear();
    this.rows.replaceChildren();
  }

  onResize(entries) {
    if (this.mode !== 'virtual' || this.destroyed) return;
    const firstVisible = this.index.indexAt(this.scroller.scrollTop);
    let correction = 0;
    let modified = false;
    for (const entry of entries) {
      const i = Number(entry.target.dataset.index);
      if (!Number.isInteger(i) || i < 0 || i >= this.index.length) continue;
      const box = entry.borderBoxSize;
      const height = box?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
      const delta = this.index.update(i, height);
      if (!delta) continue;
      modified = true;
      if (i < firstVisible) correction += delta;
    }
    if (correction) this.scroller.scrollTop += correction;
    if (modified) this.scheduleRender();
  }

  render() {
    if (this.destroyed) return;
    const started = performance.now();
    if (this.mode === 'full') {
      if (!this.nodes.size && this.messages.length) {
        const frag = document.createDocumentFragment();
        this.messages.forEach((message, i) => {
          const node = createTurn(message, i);
          frag.append(node);
          this.nodes.set(message.id, node);
        });
        this.rows.append(frag);
      }
      this.topSpacer.style.height = '0px';
      this.bottomSpacer.style.height = '0px';
      this.onStats({
        mode: this.mode, total: this.messages.length, mounted: this.nodes.size,
        start: 0, end: this.messages.length,
        renderMs: performance.now() - started,
      });
      return;
    }

    const { start, end, top, bottom } = visibleRange(
      this.index, this.scroller.scrollTop, this.scroller.clientHeight, this.overscanPx
    );
    const next = new Map();
    let sibling = this.rows.firstChild;
    for (let i = start; i < end; i++) {
      const message = this.messages[i];
      let row = this.nodes.get(message.id);
      const fresh = !row;
      if (!row) row = createTurn(message, i);
      row.dataset.index = String(i);
      next.set(message.id, row);
      if (row === sibling) {
        sibling = sibling.nextSibling;
      } else {
        this.rows.insertBefore(row, sibling);
      }
      if (fresh) this.resizeObserver?.observe(row);
    }
    // Remove rows no longer within the current window.
    for (const [key, node] of this.nodes) {
      if (!next.has(key)) {
        this.resizeObserver?.unobserve(node);
        node.remove();
      }
    }
    this.nodes = next;
    const topPx = top + 'px';
    const bottomPx = bottom + 'px';
    if (this.topSpacer.style.height !== topPx) this.topSpacer.style.height = topPx;
    if (this.bottomSpacer.style.height !== bottomPx) this.bottomSpacer.style.height = bottomPx;
    this.onStats({
      mode: this.mode, total: this.messages.length, mounted: this.nodes.size,
      start, end, renderMs: performance.now() - started,
    });
  }

  destroy() {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.resizeObserver?.disconnect();
    this.resetNodes();
  }
}
{ MAX_FULL_ROWS };


const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
if (page.ChatGPTRenderLiteBridge) return;
const OPTIONS = {maxTurns:1200, maxChars:3000000, maxPerTurn:30000};
const selectors = [
  '[data-testid^="conversation-turn-"]',
  '[data-message-author-role]',
  '[data-turn-id]',
  '[data-message-id]',
  'main article',
  'main [role="article"]'
];
const state = {mode:'off',selector:null,source:null,host:null,view:null,observer:null,timer:null,watch:null,resize:null,previous:null,path:null,lastError:null};
const err = e => e instanceof Error ? e.message : String(e);
const conversationRoute = () => /^\/(?:c|g)\//.test(location.pathname);
const element = (name,text) => {const e=document.createElement(name);if(text!==undefined)e.textContent=String(text);return e;};
function nodesFor(selector) {
  const all=[...document.querySelectorAll(selector)].filter(e=>e instanceof HTMLElement && e.closest('main'));
  return all.filter(e=>!all.some(p=>p!==e && p.contains(e)));
}
function commonParent(nodes) {
  for(let a=nodes[0];a;a=a.parentElement) if(nodes.every(n=>a.contains(n)))return a;
  return null;
}
function selectSource(selector) {
  const nodes=nodesFor(selector);
  if(nodes.length<2||nodes.length>OPTIONS.maxTurns)throw Error('需要同一个区域的 2～1200 条消息');
  const main=nodes[0].closest('main');
  if(!main||nodes.some(n=>n.closest('main')!==main))throw Error('消息跨越多个 main');
  const root=commonParent(nodes);
  if(!root||root===main||root===document.body||root===document.documentElement)throw Error('无法隔离消息根节点');
  if(root.querySelector('form,textarea,[contenteditable="true"]'))throw Error('根节点包含输入框，已拒绝');
  const composer=main.querySelector('textarea,form,[contenteditable="true"]');
  if(composer&&root.contains(composer))throw Error('消息根节点包含输入框');
  return {selector,nodes,root,main,composer};
}
function discover() {
  if(state.selector)return selectSource(state.selector);
  for(const selector of selectors)try{return selectSource(selector);}catch {}
  throw Error('找不到安全的消息区域。可通过 setSelector("CSS") 指定每条消息。');
}
function snapshot(source) {
  const nodes=nodesFor(source.selector);
  if(nodes.length<2||nodes.length>OPTIONS.maxTurns||nodes.some(n=>!source.root.contains(n)))throw Error('消息根节点改变，自动恢复');
  let chars=0;
  const messages=nodes.map((node,i)=>{
    const txt=(node.textContent||'').slice(0,OPTIONS.maxPerTurn);
    chars+=txt.length;
    const author=node.matches('[data-message-author-role]')?node:node.querySelector('[data-message-author-role]');
    const role=author?.getAttribute('data-message-author-role')||'unknown';
    const key=node.getAttribute('data-message-id')||node.getAttribute('data-turn-id')||node.getAttribute('data-testid')||String(i);
    return {id:String(i)+':'+key,role:role==='user'?'user':'assistant',text:txt};
  });
  if(chars>OPTIONS.maxChars)throw Error('镜像文本太大，已自动恢复');
  return messages;
}
const css = [
 ':host{all:initial;display:block;position:fixed;z-index:2147483000;box-sizing:border-box;font:13px/1.6 system-ui,sans-serif;color:#20282d}',
 '*{box-sizing:border-box}',
 '.shell{height:100%;display:flex;flex-direction:column;border:1px solid #c2d0d0;box-shadow:0 8px 30px #0003;background:#fff;border-radius:12px;overflow:hidden}',
 '.bar{flex:0 0 auto;background:#e8f3ef;border-bottom:1px solid #c9d7d1;padding:8px 12px;display:flex;align-items:center;gap:10px}',
 '.bar strong{flex:1;font-size:12px}.bar span{color:#607b70;font-size:11px}',
 '.bar button{font:inherit;padding:5px 9px;border:1px solid #9cbfb2;border-radius:8px;background:#fff;cursor:pointer;color:#215446}',
 '.scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}',
 '.timeline-spacer{height:0;pointer-events:none}.timeline-rows{width:100%}',
 '.turn{padding:13px 17px 17px;border-bottom:1px solid #e2e8e8;overflow-wrap:anywhere}',
 '.turn--user{background:#f3f7f6}.turn-header{display:flex;gap:14px;margin-bottom:9px;font-size:11px;color:#527b6e}',
 '.turn-body{white-space:pre-wrap;font-size:13px;line-height:1.7}.turn-body p{margin:0 0 8px}.turn-body h3{font-size:14px;margin:0 0 8px}',
 '.turn-body pre{background:#edf1f1;padding:12px;overflow:auto;font-size:11px}.hint{padding:6px 10px;font-size:10px;color:#667;background:#f7f8f8}',
 '@media(prefers-color-scheme:dark){.shell{background:#222b30;color:#e8efea;border-color:#536361}.bar{background:#29433c;border-color:#56756c;color:#eee}.bar span{color:#bccfc3}.turn{border-color:#465358}.turn--user{background:#293936}.turn-body pre{background:#152123}.hint{background:#2a3537;color:#c0c7c7}}'
].join('\n');
function layout() {
  if(!state.host||!state.source)return;
  const main=state.source.main.getBoundingClientRect();
  if(state.mode==='preview'){
    Object.assign(state.host.style,{top:'90px',right:'14px',left:'auto',bottom:'auto',width:'min(650px,60vw)',height:'min(70vh,680px)'});
  }else{
    const composer=state.source.composer?.getBoundingClientRect();
    const top=Math.max(5,main.top+5);
    const bottom=composer && composer.top>top+170 ? innerHeight-composer.top+8 : Math.max(8,innerHeight-main.bottom);
    Object.assign(state.host.style,{top:top+'px',left:Math.max(5,main.left+4)+'px',right:'auto',
      bottom:Math.max(8,bottom)+'px',width:Math.max(300,Math.min(innerWidth-main.left-8,main.width-8))+'px',height:'auto'});
  }
}
function stopListeners(){
  if(state.observer)state.observer.disconnect();
  if(state.timer)clearTimeout(state.timer);
  if(state.watch)clearInterval(state.watch);
  if(state.resize)window.removeEventListener('resize',state.resize);
  window.removeEventListener('keydown',keyboard,true);
  state.observer=null;state.timer=null;state.watch=null;state.resize=null;
}
function restore() {
  stopListeners();
  if(state.source?.root&&state.previous) {
    if(state.previous.value)state.source.root.style.setProperty('display',state.previous.value,state.previous.priority);
    else state.source.root.style.removeProperty('display');
  }
  state.previous=null;
  state.view?.destroy();
  state.host?.remove();
  state.mode='off';state.source=null;state.view=null;state.host=null;state.path=null;
  return status();
}
function keyboard(e){if(e.key==='Escape')restore();}
function verify(){
  if(state.mode==='off')return false;
  if(location.pathname!==state.path||!conversationRoute()||!state.source.root.isConnected||
    !state.source.main.isConnected||state.source.root.querySelector('form,textarea,[contenteditable="true"]')||
    (state.source.composer&&!state.source.composer.isConnected)){
    state.lastError='路由或 DOM 边界发生变化，已恢复原版';restore();return false;
  }
  return true;
}
function sync(){
  if(!verify())return;
  try{
    const old=state.view.scroller.scrollTop;
    const nearBottom=state.view.scroller.scrollHeight-state.view.scroller.clientHeight-old<80;
    state.view.setMessages(snapshot(state.source),{toBottom:nearBottom});
    if(!nearBottom){state.view.scroller.scrollTop=old;state.view.render();}
  }catch(e){state.lastError=err(e);restore();}
}
function queueSync(){
  if(state.timer)return;
  state.timer=setTimeout(()=>{state.timer=null;sync();},450);
}
function start(mode='preview'){
  if(!['preview','takeover'].includes(mode))throw RangeError('未知模式');
  if(!conversationRoute())throw Error('仅支持 ChatGPT 会话路由');
  restore();
  const source=discover();
  const messages=snapshot(source);
  if(mode==='takeover'&&!window.confirm('高风险实验：将原消息区域暂时隐藏，显示只读虚拟消息镜像。React 依然运行。按 Esc 恢复，确定继续？'))return {cancelled:true};
  const host=element('div');host.setAttribute('data-rl-native-bridge','');
  document.body.append(host);
  const shadow=host.attachShadow({mode:'open'});
  const style=element('style',css);
  const shell=element('section');shell.className='shell';
  const bar=element('div');bar.className='bar';
  bar.append(element('strong','Render Lite · 原网页消息镜像'),element('span',String(messages.length)+' 条'));
  const close=element('button','恢复原版');close.addEventListener('click',restore);bar.append(close);
  const scroll=element('div');scroll.className='scroll';
  const hint=element('div','只读文本镜像。图片、引用、代码复制等请恢复原版后使用。');hint.className='hint';
  shell.append(bar,scroll,hint);shadow.append(style,shell);
  const view=new VirtualTimeline(scroll,{estimate:240,overscanPx:800});
  state.source=source;state.view=view;state.host=host;state.mode=mode;state.path=location.pathname;
  layout();view.setMessages(messages,{toBottom:true});
  if(mode==='takeover') {
    state.previous={value:source.root.style.getPropertyValue('display'),priority:source.root.style.getPropertyPriority('display')};
    source.root.style.setProperty('display','none','important');
  }
  state.observer=new MutationObserver(queueSync);
  state.observer.observe(source.root,{childList:true,characterData:true,subtree:true});
  state.watch=setInterval(()=>{if(verify())layout();},1500);
  state.resize=layout;window.addEventListener('resize',layout,{passive:true});
  window.addEventListener('keydown',keyboard,true);
  return status();
}
function status(){return {version:'0.1.0',mode:state.mode,selector:state.source?.selector||state.selector||'auto',
 messages:state.view?.messages.length||0,mounted:state.view?.nodes.size||0,lastError:state.lastError,
 reactFiberMarker:state.source?Object.keys(state.source.nodes[0]||{}).some(k=>k.startsWith('__reactFiber$')):null};}
function probe(){
  const counts={};for(const selector of selectors)counts[selector]=nodesFor(selector).length;
  return {counts,route:conversationRoute()?'conversation':'other',version:'0.1.0'};
}
function fiberProbe(){
  const s=state.source||discover(),samples=[];
  for(const n of s.nodes.slice(0,3)){
    const key=Object.keys(n).find(k=>k.startsWith('__reactFiber$'));
    const chain=[],seen=new Set();
    for(let f=key?n[key]:null;f&&!seen.has(f)&&chain.length<30;f=f.return){
      seen.add(f);const t=f.elementType||f.type;
      const component=typeof t==='string'?t:typeof t==='function'?(t.displayName||t.name||'anonymous'):typeof t?.displayName==='string'?t.displayName:'unknown';
      chain.push({tag:typeof f.tag==='number'?f.tag:null,component:String(component).slice(0,80)});
    }
    samples.push({found:Boolean(key),chain});
  }
  return {selector:s.selector,samples};
}
function setSelector(selector){
  if(state.mode!=='off')throw Error('请先恢复原版');
  if(selector!==null&&(typeof selector!=='string'||selector.length>240))throw TypeError('无效 CSS 选择器');
  if(selector)document.querySelectorAll(selector);
  state.selector=selector||null;return status();
}
function menu(label,fn){if(typeof GM_registerMenuCommand==='function')GM_registerMenuCommand(label,fn);}
function safe(fn){return()=>{try{console.info('[RL Bridge]',fn());}catch(e){state.lastError=err(e);console.warn('[RL Bridge]',err(e));}};}
menu('Phase6：扫描页面结构',safe(probe));
menu('Phase6：只读 React 组件路径',safe(fiberProbe));
menu('Phase6：预览轻量渲染器',safe(()=>start('preview')));
menu('Phase6：实验性隐藏原消息区域',safe(()=>start('takeover')));
menu('Phase6：恢复原网页',safe(restore));
menu('Phase6：设置消息 CSS 选择器',safe(()=>{
  const value=window.prompt('输入匹配每条消息的 CSS 选择器；留空恢复自动识别',state.selector||'');
  return value===null?status():setSelector(value.trim()||null);
}));
page.ChatGPTRenderLiteBridge=Object.freeze({probe,fiberProbe,start,restore,status,setSelector});

})();
