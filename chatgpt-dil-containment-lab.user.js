// ==UserScript==
// @name         ChatGPT Render Lite - DIL Block Containment Lab (Phase 6.3)
// @namespace    https://github.com/MillioApaski/ChatGPT-Render-Lite
// @version      0.1.0
// @description  Default-off, reversible content-visibility A/B experiment on measured offscreen DIL blocks.
// @match        https://chatgpt.com/*
// @noframes
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/MillioApaski/ChatGPT-Render-Lite
// @updateURL    https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/feature/phase6-native-render-bridge/chatgpt-dil-containment-lab.user.js
// @downloadURL  https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/feature/phase6-native-render-bridge/chatgpt-dil-containment-lab.user.js
// ==/UserScript==

(() => {
  'use strict';
  const API = 'ChatGPTRenderLiteDILContainment';
  if (Object.hasOwn(window, API)) return;
  const MAX_CANDIDATES = 240;
  const MIN_PER_RESPONSE = 8;
  const MIN_APPLIED = 4;
  const MIN_HEIGHT_PX = 36;
  const MIN_OFFSCREEN_PX = 300;
  const MAX_HEIGHT_DELTA_PX = 80;
  const MAX_HEIGHT_DELTA_RATIO = 0.01;
  const QUIET_MS = 500;
  const SAFE_BLOCKS = ':scope > p, :scope > pre, :scope > blockquote, :scope > ul, :scope > ol';
  const INTERACTIVE = 'input,textarea,video,audio,iframe,canvas,[contenteditable],[role="textbox"],[data-mcp-app-portal-target]';
  const STYLE_PROPS = ['content-visibility', 'contain-intrinsic-block-size'];
  const state = {
    active: false, pending: false, token: 0, route: null, host: null, originals: new Map(),
    observer: null, routeTimer: null,
    lastReason: 'never-enabled', lastAttempt: null,
    beforeHeight: null, afterHeight: null
  };
  const isConversation = () => /^\/(?:c|g)\//.test(location.pathname);
  // Inactive installation adds no scroll listeners, DOM observers or timers.
  function status() {
    return Object.freeze({
      version: '0.1.0', active: state.active, pending: state.pending, appliedBlocks: state.originals.size,
      lastReason: state.lastReason, lastAttempt: state.lastAttempt,
      beforeHeight: state.beforeHeight, afterHeight: state.afterHeight,
      warning: 'Opt-in CSS experiment; no getBoundingClientRect monkeypatch or network calls.'
    });
  }
  function scrollHost() {
    const hosts=[...document.querySelectorAll('[data-thread-frame-scrollbar]')];
    if(hosts.length===1) return hosts[0];
    return document.scrollingElement || document.documentElement;
  }
  function viewportFor(host) {
    if(host===document.scrollingElement||host===document.documentElement||host===document.body){
      return { top: 0, bottom: innerHeight };
    }
    const rect=host.getBoundingClientRect();
    return { top: Math.max(0,rect.top), bottom: Math.min(innerHeight,rect.bottom) };
  }
  function candidates() {
    const roots=[...document.querySelectorAll('[data-rail-chat-transcript] [data-dil-response]')];
    const nodes=[];
    for(const root of roots){
      if(!root.closest('[data-turn-key]')) continue;
      const direct=[...root.querySelectorAll(SAFE_BLOCKS)];
      if(direct.length<MIN_PER_RESPONSE)continue;
      for(const node of direct){
        if(nodes.length>=MAX_CANDIDATES) return nodes;
        if(!(node instanceof HTMLElement)||node.querySelector(INTERACTIVE)||
          node.isContentEditable||node.closest('[data-rl-native-bridge]')||
          node.style.getPropertyValue('content-visibility')||
          node.style.getPropertyValue('contain-intrinsic-block-size')||
          node.contains(document.activeElement)) continue;
        nodes.push(node);
      }
    }
    return nodes;
  }
  function rememberAndApply(node,height) {
    const originals={};
    for(const prop of STYLE_PROPS){
      originals[prop]={
        value:node.style.getPropertyValue(prop),
        priority:node.style.getPropertyPriority(prop)
      };
    }
    state.originals.set(node,originals);
    node.style.setProperty('contain-intrinsic-block-size','auto '+Math.ceil(height)+'px');
    node.style.setProperty('content-visibility','auto');
  }
  function disable(reason='manual'){
    state.token++;state.pending=false;
    if(state.observer){state.observer.disconnect();state.observer=null;}
    if(state.routeTimer!==null){clearInterval(state.routeTimer);state.routeTimer=null;}
    let restored=0;
    for(const [node,originals] of state.originals){
      // Never erase a newer third-party write that replaced our CSS.
      const current=node.style.getPropertyValue('content-visibility');
      if(current!=='auto')continue;
      for(const prop of STYLE_PROPS){
        const old=originals[prop];
        if(old.value)node.style.setProperty(prop,old.value,old.priority);
        else node.style.removeProperty(prop);
      }
      restored++;
    }
    state.originals.clear();state.active=false;state.host=null;
    state.lastReason=reason;
    return { ...status(),restored };
  }
  async function enable(){
    if(state.active||state.pending) throw Error('实验已开启或正在准备，先执行 disable()');
    state.pending=true;
    const token=++state.token;
    try{return await prepareAndEnable(token);}
    finally{if(state.token===token)state.pending=false;}
  }
  async function prepareAndEnable(token){
    if(!isConversation()) throw Error('只允许在 ChatGPT 对话页启用');
    if(document.visibilityState!=='visible') throw Error('必须在可见网页中启用');
    if(!CSS.supports('content-visibility','auto')||
       !CSS.supports('contain-intrinsic-block-size','auto 80px'))
      throw Error('当前浏览器不支持所需 CSS');
    const host=scrollHost();
    const firstPath=location.pathname,firstScroll=host.scrollTop;
    await new Promise(resolve=>setTimeout(resolve,QUIET_MS));
    if(state.token!==token||state.active)throw Error('启用请求已经取消');
    if(location.pathname!==firstPath||!host.isConnected||document.visibilityState!=='visible'||
       Math.abs(host.scrollTop-firstScroll)>1)
      throw Error('页面正在滚动或已经切换，请停止滚动并重新执行 enable()');
    const viewport=viewportFor(host);
    if(viewport.bottom<=viewport.top+80)throw Error('无法安全判定滚动视口');
    const blocks=candidates();
    const planned=[];
    for(const node of blocks){
      if(!node.isConnected || !host.contains(node)&&host!==document.scrollingElement)continue;
      const rect=node.getBoundingClientRect();
      if(!Number.isFinite(rect.height)||rect.height<MIN_HEIGHT_PX)continue;
      const distance=rect.bottom<viewport.top?viewport.top-rect.bottom:
        rect.top>viewport.bottom?rect.top-viewport.bottom:0;
      if(distance<MIN_OFFSCREEN_PX)continue;
      planned.push({node,height:rect.height});
    }
    const attempt={scanned:blocks.length,eligible:planned.length,applied:0,reason:null};
    state.lastAttempt=attempt;
    if(planned.length<MIN_APPLIED){
      attempt.reason='not-enough-measured-offscreen-blocks';
      state.lastReason=attempt.reason;return status();
    }
    const before=host.scrollHeight;
    state.route=location.pathname;state.host=host;state.beforeHeight=before;
    try{
      for(const {node,height} of planned)rememberAndApply(node,height);
      state.active=true;attempt.applied=planned.length;
      const after=host.scrollHeight;
      state.afterHeight=after;
      const delta=Math.abs(after-before);
      if(delta>Math.max(MAX_HEIGHT_DELTA_PX,before*MAX_HEIGHT_DELTA_RATIO)){
        attempt.reason='scroll-height-changed';
        return disable('scroll-height-changed');
      }
      state.observer=new MutationObserver(mutations=>{
        if(mutations.length)disable('modified-DIL-block');
      });
      for(const node of state.originals.keys()){
        state.observer.observe(node,{childList:true,characterData:true,subtree:true});
      }
      state.routeTimer=setInterval(()=>{
        if(location.pathname!==state.route)disable('route-changed');
        else if([...state.originals.keys()].some(n=>!n.isConnected))disable('blocks-unmounted');
        else if(document.visibilityState!=='visible')disable('tab-hidden');
      },700);
      state.lastReason='active';
      return status();
    }catch(error){
      disable('error');throw error;
    }
  }
  window.addEventListener('pagehide',()=>disable('pagehide'));
  Object.defineProperty(window,API,{
    configurable:true,value:Object.freeze({status,enable,disable})
  });
})();
