// ==UserScript==
// @name         ChatGPT Render Lite · Native Bridge Lab
// @namespace    https://github.com/MillioApaski/ChatGPT-Render-Lite
// @version      0.4.0
// @description  Opt-in original ChatGPT page renderer bridge experiment. Restores native UI on failure.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/feature/phase6-native-render-bridge/chatgpt-native-render-bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/feature/phase6-native-render-bridge/chatgpt-native-render-bridge.user.js
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
const OPTIONS = {maxTurns:1200, maxChars:3000000, maxPerTurn:30000,
 minInferredRows:5, maxDiagnosticNodes:1600, maxDiagnosticDepth:9};
const selectors = [
  '[data-testid^="conversation-turn-"]',
  '[data-message-author-role]',
  '[data-turn-id]',
  '[data-message-id]',
  'main article',
  'main [role="article"]'
];
const state = {mode:'off',selector:null,source:null,host:null,view:null,observer:null,timer:null,watch:null,resize:null,previous:null,path:null,lastError:null,manualRoot:null,manualPath:null,picker:null};
const err = e => e instanceof Error ? e.message : String(e);
const conversationRoute = () => /^\/(?:c|g)\//.test(location.pathname);
const bridgeElement = (name,text) => {const e=document.createElement(name);if(text!==undefined)e.textContent=String(text);return e;};
const contentSelectors=['.markdown','.prose','[class*="markdown"]','[class*="prose"]','[class*="text-message"]','[class*="message-content"]','[class*="whitespace-pre-wrap"]'];
const composerSelector='form,textarea,[contenteditable="true"],[role="textbox"]';
const findMain=e=>e?.closest?.('main,[role="main"]');
function nodesFor(selector) {
  const all=[...document.querySelectorAll(selector)].filter(e=>e instanceof HTMLElement&&findMain(e)&&!e.closest('[data-rl-native-bridge]'));
  return all.filter(e=>!all.some(p=>p!==e && p.contains(e)));
}
function safeRoot(root,main) {
  return Boolean(root&&main&&main.contains(root)&&root!==main&&root!==document.body&&root!==document.documentElement&&
    !root.matches(composerSelector)&&!root.querySelector(composerSelector));
}
function sourceFromRoot(root,label='structure'){
  const main=findMain(root);
  if(!safeRoot(root,main))throw Error('推断的消息区域包含输入框或越过了 main 边界');
  const getNodes=()=>[...root.children].filter(e=>e instanceof HTMLElement&&e.textContent?.trim());
  const nodes=getNodes();
  if(nodes.length<OPTIONS.minInferredRows||nodes.length>OPTIONS.maxTurns)
    throw Error('推断的消息行少于 5 个，无法确认消息容器；已拒绝接管');
  return {selector:label,nodes,root,main,composer:main.querySelector(composerSelector),getNodes};
}
// DOM-structure inference does not rely on version-specific message attributes.
function structuralCandidates(main,onlyContaining=null){
  const found=new Set();
  for(const selector of contentSelectors){
    for(const item of main.querySelectorAll(selector)){
      if(found.size>=1800)break;
      if(item instanceof HTMLElement&&!item.closest('[data-rl-native-bridge]')&&!item.closest(composerSelector)&&item.textContent?.trim())found.add(item);
    }
  }
  const anchors=[...found].filter(e=>{
    for(let parent=e.parentElement;parent&&parent!==main;parent=parent.parentElement)if(found.has(parent))return false;
    return true;
  });
  const groups=new Map();
  for(const anchor of anchors){
    let child=anchor;
    for(let depth=0;depth<20&&child.parentElement;depth++){
      const root=child.parentElement;
      if(root===main)break;
      if(!groups.has(root))groups.set(root,new Set());
      groups.get(root).add(child);
      child=root;
    }
  }
  const result=[];
  for(const [root,branches] of groups){
    if(!safeRoot(root,main)||onlyContaining&&!root.contains(onlyContaining))continue;
    const all=[...root.children].filter(e=>e instanceof HTMLElement&&e.textContent?.trim());
    if(all.length<OPTIONS.minInferredRows||all.length>OPTIONS.maxTurns||branches.size<OPTIONS.minInferredRows)continue;
    const hits=all.filter(e=>branches.has(e)).length;
    if(hits<OPTIONS.minInferredRows||hits/all.length<0.5)continue;
    result.push({root,count:all.length,hits,score:hits*2+10*hits/all.length+Math.min(all.length,100)/10});
  }
  result.sort((a,b)=>b.score-a.score);
  return result.slice(0,8);
}
function manualCandidate(target){
  const main=findMain(target);
  if(!main||target.closest('[data-rl-native-bridge]'))throw Error('请点击真正的聊天消息');
  const inferred=structuralCandidates(main,target);
  if(inferred.length)return inferred[0].root;
  let current=target;
  const candidates=[];
  for(let depth=0;depth<22&&current?.parentElement;depth++,current=current.parentElement){
    const root=current.parentElement;
    if(root===main)break;
    if(!safeRoot(root,main))continue;
    const nodes=[...root.children].filter(e=>e instanceof HTMLElement&&e.textContent?.trim());
    if(nodes.length<3||nodes.length>OPTIONS.maxTurns)continue;
    const similar=nodes.filter(e=>e.localName===current.localName).length;
    const substantial=nodes.filter(e=>e.textContent.trim().length>=8).length;
    if(similar/nodes.length<.7||substantial/nodes.length<.7)continue;
    candidates.push({root,score:nodes.length+similar});
  }
  candidates.sort((a,b)=>b.score-a.score);
  if(!candidates.length)throw Error('未找到安全的重复消息容器。请使用自定义 CSS 选择器');
  return candidates[0].root;
}
// Confirmed by a user-supplied live DIL message ancestry report.
// These nodes may be only the currently mounted portion of a conversation.
const NATIVE={
  transcript:'[data-rail-chat-transcript]',
  turn:'[data-turn-key]',
  response:'[data-response-body]',
  dil:'[data-dil-message-id]',
  scroll:'[data-thread-frame-scrollbar]',
  turnState:'[data-talvt-turn-state]'
};
function transcriptRoot(){
  const nodes=[...document.querySelectorAll(NATIVE.transcript)]
    .filter(node=>node instanceof HTMLElement&&findMain(node)&&!node.closest('[data-rl-native-bridge]'));
  return nodes.length===1?nodes[0]:null;
}
function nativeTurnNodes(root=transcriptRoot()){
  if(!root)return [];
  const nodes=[...root.querySelectorAll(NATIVE.turn)]
    .filter(node=>node instanceof HTMLElement&&!node.closest('[data-rl-native-bridge]'));
  return nodes.filter(node=>!nodes.some(other=>other!==node&&other.contains(node)));
}
function nativeOverview(){
  const root=transcriptRoot(),turns=nativeTurnNodes(root);
  return {
    version:'0.4.0',
    transcriptCount:document.querySelectorAll(NATIVE.transcript).length,
    mountedTurnCount:turns.length,
    turnMarkers:document.querySelectorAll(NATIVE.turn).length,
    dilMessageCount:document.querySelectorAll(NATIVE.dil).length,
    responseBodies:document.querySelectorAll(NATIVE.response).length,
    turnStateMarkers:document.querySelectorAll(NATIVE.turnState).length,
    scrollHosts:document.querySelectorAll(NATIVE.scroll).length,
    transcriptContainsComposer:Boolean(root?.querySelector(composerSelector)),
    turnSamples:turns.slice(0,5).map(n=>({
      hasDIL:!!n.querySelector(NATIVE.dil),
      hasResponseBody:!!n.querySelector(NATIVE.response),
      hasTurnState:!!n.querySelector(NATIVE.turnState),
      childCount:n.children.length
    })),
    notice:'仅当前 DOM 挂载的消息；没有读取会话历史、正文或任何标识值'
  };
}
function nativeSource(){
  const root=transcriptRoot(),main=findMain(root);
  if(!safeRoot(root,main))throw Error('无法隔离 transcript 容器或其内部包含输入区域');
  const getNodes=()=>nativeTurnNodes(root),nodes=getNodes();
  if(!nodes.length||nodes.length>OPTIONS.maxTurns)throw Error('当前 transcript 没有可预览的挂载消息');
  return {selector:'native-turns',root,main,composer:main.querySelector(composerSelector),nodes,getNodes};
}
// Sample mounted keys during a manually performed scroll, without geometry
// reads, text extraction or network traffic. Key values never leave the page.
function monitorTurns(durationMs=12000){
  const duration=Number(durationMs);
  if(!Number.isFinite(duration)||duration<1000||duration>30000)
    throw RangeError('监测时长须为 1000～30000ms');
  const root=transcriptRoot();
  if(!root)throw Error('找不到唯一的 transcript 容器');
  const pathname=location.pathname,seen=new Set();
  let previous=new Set(),min=Infinity,max=0,totalAdded=0,totalRemoved=0;
  const samples=[],start=performance.now();
  return new Promise(resolve=>{
    let timer,finished=false;
    function complete(reason){
      if(finished)return;
      finished=true;clearInterval(timer);
      const result={
        version:'0.4.0',elapsedMs:Math.round(performance.now()-start),
        sampleCount:samples.length,minMounted:min===Infinity?0:min,
        maxMounted:max,uniqueTurnKeys:seen.size,addedKeys:totalAdded,
        removedKeys:totalRemoved,reason,samples,
        interpretation:'滚动时已挂载 key 发生替换是按需挂载的证据；无法仅凭此证明 React 组件已卸载、何时重算布局或历史已完整加载'
      };
      console.info('[RL Bridge] turn churn',result);resolve(result);
    }
    function sample(){
      if(location.pathname!==pathname||!root.isConnected){complete('route-or-root-changed');return;}
      const active=nativeTurnNodes(root);
      const keys=new Set(active.map(n=>n.getAttribute('data-turn-key')||n));
      const added=[...keys].filter(k=>!previous.has(k)).length;
      const removed=[...previous].filter(k=>!keys.has(k)).length;
      for(const key of keys)seen.add(key);
      totalAdded+=added;totalRemoved+=removed;
      min=Math.min(min,active.length);max=Math.max(max,active.length);
      samples.push({t:Math.round(performance.now()-start),mounted:active.length,
        appeared:added,disappeared:removed,uniqueSeen:seen.size});
      previous=keys;
      if(performance.now()-start>=duration)complete('completed');
    }
    sample();timer=setInterval(sample,400);
  });
}
function commonParent(nodes) {
  for(let a=nodes[0];a;a=a.parentElement) if(nodes.every(n=>a.contains(n)))return a;
  return null;
}
function selectSource(selector) {
  const nodes=nodesFor(selector);
  if(nodes.length<OPTIONS.minInferredRows||nodes.length>OPTIONS.maxTurns)
    throw Error('至少需要 5 个可靠消息行；当前区域不足或超出限制');
  const main=findMain(nodes[0]);
  if(!main||nodes.some(n=>findMain(n)!==main))throw Error('消息跨越多个 main');
  const root=commonParent(nodes);
  if(!safeRoot(root,main))throw Error('无法隔离消息根节点');
  if(root.querySelector('form,textarea,[contenteditable="true"]'))throw Error('根节点包含输入框，已拒绝');
  const composer=main.querySelector(composerSelector);
  if(composer&&root.contains(composer))throw Error('消息根节点包含输入框');
  return {selector,nodes,root,main,composer,getNodes:()=>nodesFor(selector)};
}
function discover() {
  if(state.selector)return selectSource(state.selector);
  if(transcriptRoot())return nativeSource();
  if(state.manualRoot?.isConnected&&state.manualPath===location.pathname)return sourceFromRoot(state.manualRoot,'picked');
  for(const selector of selectors)try{return selectSource(selector);}catch {}
  for(const main of document.querySelectorAll('main,[role="main"]')){
    const guessed=structuralCandidates(main);
    if(guessed.length)return sourceFromRoot(guessed[0].root,'inferred');
  }
  throw Error('找不到安全的消息区域。请点击消息选择容器，或使用自定义 CSS 选择器。');
}
function snapshot(source) {
  const nodes=source.getNodes();
  const minimum=source.selector==='native-turns'?1:OPTIONS.minInferredRows;
  if(nodes.length<minimum||nodes.length>OPTIONS.maxTurns||nodes.some(n=>!source.root.contains(n)))throw Error('消息根节点改变，自动恢复');
  let chars=0;
  const messages=nodes.map((node,i)=>{
    const txt=(node.textContent||'').slice(0,OPTIONS.maxPerTurn);
    chars+=txt.length;
    const author=node.matches('[data-message-author-role]')?node:node.querySelector('[data-message-author-role]');
    const role=author?.getAttribute('data-message-author-role')||'unknown';
    const key=node.getAttribute('data-message-id')||node.getAttribute('data-turn-id')||node.getAttribute('data-testid')||String(i);
    return {id:String(i)+':'+key,role:role==='user'?'user':role==='assistant'?'assistant':'unknown',text:txt};
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
 '.scroll{flex:1;min-height:0;overflow:auto;overflow-anchor:none;overscroll-behavior:contain;scrollbar-gutter:stable}',
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
  stopPicker();
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
    !state.source.main.isConnected||state.source.root.querySelector(composerSelector)||
    (state.source.composer&&!state.source.composer.isConnected)){
    state.lastError='路由或 DOM 边界发生变化，已恢复原版';restore();return false;
  }
  return true;
}
function sync(){
  if(!verify())return;
  try{
    const next=snapshot(state.source);
    const current=state.view.messages;
    const same=current.length===next.length&&current.every((msg,i)=>msg.id===next[i].id);
    if(same){
      let modified=false;
      next.forEach((msg,i)=>{
        if(current[i].text===msg.text&&current[i].role===msg.role)return;
        modified=true;
        current[i]=msg;
        const row=state.view.nodes.get(msg.id);
        if(row){
          row.className='turn turn--'+(msg.role==='user'?'user':'assistant');
          const body=row.querySelector('.turn-body');
          if(body){body.replaceChildren();renderSafeText(msg.text,body);}
        }
      });
      if(modified)state.view.scheduleRender();
    }else{
      const old=state.view.scroller.scrollTop;
      const nearBottom=state.view.scroller.scrollHeight-state.view.scroller.clientHeight-old<80;
      state.view.setMessages(next,{toBottom:nearBottom});
      if(!nearBottom){state.view.scroller.scrollTop=old;state.view.render();}
    }
  }catch(e){state.lastError=err(e);restore();}
}
function queueSync(){
  if(state.timer)return;
  state.timer=setTimeout(()=>{state.timer=null;sync();},450);
}
function start(mode='preview'){
  if(!['preview','takeover'].includes(mode))throw RangeError('未知模式');
  if(!conversationRoute())throw Error('仅支持 ChatGPT 会话路由');
  if(mode==='takeover'&&transcriptRoot())throw Error('新版 DIL transcript 可能只挂载部分消息：为防止丢失历史，暂时拒绝 takeover。请先运行 monitorTurns()');
  restore();
  const source=discover();
  const messages=snapshot(source);
  if(mode==='takeover'&&!window.confirm('高风险实验：将原消息区域暂时隐藏，显示只读虚拟消息镜像。React 依然运行。按 Esc 恢复，确定继续？'))return {cancelled:true};
  const host=bridgeElement('div');host.setAttribute('data-rl-native-bridge','');
  document.body.append(host);
  const shadow=host.attachShadow({mode:'open'});
  const style=bridgeElement('style',css);
  const shell=bridgeElement('section');shell.className='shell';
  const bar=bridgeElement('div');bar.className='bar';
  bar.append(bridgeElement('strong','Render Lite · 原网页消息镜像'),bridgeElement('span',String(messages.length)+' 条'));
  const close=bridgeElement('button','恢复原版');close.addEventListener('click',restore);bar.append(close);
  const scroll=bridgeElement('div');scroll.className='scroll';
  const hint=bridgeElement('div','只读文本镜像。图片、引用、代码复制等请恢复原版后使用。');hint.className='hint';
  shell.append(bar,scroll,hint);shadow.append(style,shell);
  const view=new VirtualTimeline(scroll,{estimate:240,overscanPx:800});
  state.source=source;state.view=view;state.host=host;state.mode=mode;state.path=location.pathname;
  layout();view.setMessages(messages,{toBottom:true});
  requestAnimationFrame(()=>{if(state.view===view&&state.mode!=='off'){view.scroller.scrollTop=view.scroller.scrollHeight;view.render();}});
  setTimeout(()=>{if(state.view===view&&state.mode!=='off'){view.scroller.scrollTop=view.scroller.scrollHeight;view.render();}},80);
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
function status(){return {version:'0.4.0',mode:state.mode,selector:state.source?.selector||state.selector||'auto',
 messages:state.view?.messages.length||0,mounted:state.view?.nodes.size||0,lastError:state.lastError,
 reactFiberMarker:state.source?Object.keys(state.source.nodes[0]||{}).some(k=>k.startsWith('__reactFiber$')):null};}
function probe(){
  const counts={};for(const selector of selectors)counts[selector]=nodesFor(selector).length;
  const anchors={};
  for(const selector of contentSelectors)anchors[selector]=document.querySelectorAll('main '+selector+',[role="main"] '+selector).length;
  const containers=[...document.querySelectorAll('main,[role="main"]')].map((main,index)=>{
    const found=structuralCandidates(main);
    const first=found[0];
    return {index,elementCount:main.querySelectorAll('*').length,
      candidate:first?{rows:first.count,matchedBranches:first.hits}:null};
  });
  return {counts,anchors,containers,mainCount:containers.length,iframeCount:document.querySelectorAll('iframe').length,
    route:conversationRoute()?'conversation':'other',version:'0.4.0',note:'匿名结构信息，不含消息文本'};
}
// Read-only, anonymized structural report. No node text, HTML, IDs, URLs,
// React props, attribute values, or raw class names are returned.
function structure(){
  const roots=[...document.querySelectorAll('main,[role="main"]')].slice(0,3);
  const reports=[];
  for(const main of roots){
    const nodes=[];
    const walk=(node,depth,path)=>{
      if(nodes.length>=OPTIONS.maxDiagnosticNodes||depth>OPTIONS.maxDiagnosticDepth)return;
      if(!(node instanceof HTMLElement)||node.closest('[data-rl-native-bridge]'))return;
      const children=[...node.children].filter(c=>c instanceof HTMLElement);
      const tagCounts={};
      for(const child of children)tagCounts[child.localName]=(tagCounts[child.localName]||0)+1;
      const dataNames=node.getAttributeNames().filter(name=>
        /^(data-|role$|contenteditable$)/.test(name)
      ).slice(0,8);
      const entry={path,depth,tag:node.localName,childCount:children.length,
        tags:tagCounts,attrNames:dataNames};
      // Only structural patterns: no class values or message text.
      if(depth===0||children.length>=2||node.matches('article,[role="article"]')||
        contentSelectors.some(selector=>node.matches(selector))){
        nodes.push(entry);
      }
      if(depth<OPTIONS.maxDiagnosticDepth)
        children.forEach((child,index)=>walk(child,depth+1,path?path+'.'+index:String(index)));
    };
    walk(main,0,'');
    reports.push({visitedNodes:nodes.length,limit:OPTIONS.maxDiagnosticNodes,
      depthLimit:OPTIONS.maxDiagnosticDepth,branches:nodes.slice(0,240)});
  }
  return {version:'0.4.0',mainCount:roots.length,
    reports,note:'仅元素标签、路径、孩子数及属性名称；不包含任何对话文本、属性值或 React 数据'};
}
function selectedPath(target){
  const main=findMain(target),chain=[];
  if(!main)return {error:'目标不在 main 中'};
  let item=target;
  for(let step=0;item&&step<24;step++,item=item.parentElement){
    const parent=item.parentElement,children=parent?[...parent.children]:[];
    const tags={};
    for(const child of children)tags[child.localName]=(tags[child.localName]||0)+1;
    chain.push({tag:item.localName,
      siblingIndex:children.indexOf(item),siblingCount:children.length,
      siblingTags:tags,children:item.children.length,
      attrNames:item.getAttributeNames().filter(n=>/^(data-|role$)/.test(n)).slice(0,8)});
    if(item===main)break;
  }
  return {chain,note:'仅 DOM 祖先与兄弟结构，不含消息内容'};
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
// Interactive fallback when ChatGPT changes all message selectors.
function stopPicker(){
  const p=state.picker;if(!p)return;
  document.removeEventListener('click',p.click,true);
  document.removeEventListener('keydown',p.keydown,true);
  p.banner.remove();state.picker=null;
}
function pick(){
  if(state.mode!=='off')throw Error('请先恢复原页面');
  stopPicker();
  const banner=bridgeElement('div','点击一条历史聊天消息，选择候选消息区域。Esc 取消，不会隐藏或上传任何内容。');
  banner.setAttribute('data-rl-picker','');
  banner.style.cssText='position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);background:#1e4e43;color:#fff;padding:10px 18px;border-radius:10px;pointer-events:none;font:13px system-ui';
  document.body.append(banner);
  const click=e=>{
    if(!(e.target instanceof HTMLElement)||!findMain(e.target))return;
    e.preventDefault();e.stopImmediatePropagation();
    try{
      console.info('[RL Bridge] 点选结构',selectedPath(e.target));
      const root=manualCandidate(e.target),source=sourceFromRoot(root,'picked');
      state.manualRoot=root;state.manualPath=location.pathname;state.lastError=null;
      console.info('[RL Bridge] 已定位候选消息区域',{rows:source.nodes.length,rootTag:root.localName,
        note:'请先运行预览确认消息完整，再考虑隐藏原列表'});
    }catch(error){state.lastError=err(error);console.warn('[RL Bridge]',state.lastError);}
    stopPicker();
  };
  const keydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();stopPicker();}};
  state.picker={banner,click,keydown};
  document.addEventListener('click',click,true);
  document.addEventListener('keydown',keydown,true);
  return {mode:'pick',note:'点击历史消息完成选取，Esc 取消'};
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
menu('Phase6：检测新版 DIL 消息结构',safe(nativeOverview));
menu('Phase6：记录消息挂载变化（12 秒内手动滚动）',safe(()=>monitorTurns(12000)));
menu('Phase6：匿名 DOM 层级报告',safe(structure));
menu('Phase6：点击消息定位容器',safe(pick));
menu('Phase6：只读 React 组件路径',safe(fiberProbe));
menu('Phase6：预览轻量渲染器',safe(()=>start('preview')));
menu('Phase6：实验性隐藏原消息区域',safe(()=>start('takeover')));
menu('Phase6：恢复原网页',safe(restore));
menu('Phase6：设置消息 CSS 选择器',safe(()=>{
  const value=window.prompt('输入匹配每条消息的 CSS 选择器；留空恢复自动识别',state.selector||'');
  return value===null?status():setSelector(value.trim()||null);
}));
page.ChatGPTRenderLiteBridge=Object.freeze({probe,structure,nativeOverview,monitorTurns,fiberProbe,pick,start,restore,status,setSelector});

})();
