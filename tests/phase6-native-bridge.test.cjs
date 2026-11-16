const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const code=fs.readFileSync(path.resolve(__dirname,'../chatgpt-native-render-bridge.user.js'),'utf8');
function init() {
  const menus=new Map();let elementsCreated=0;
  const win={removeEventListener(){},addEventListener(){},confirm(){return true;}};
  const doc={
    querySelectorAll(s){if(s===':bad(')throw Error('Invalid selector');return [];},
    querySelector(){return null;},
    createElement(){elementsCreated++;throw Error('Off mode must not create DOM elements');},
  };
  const ctx={window:win,document:doc,location:{pathname:'/c/test'},
    HTMLElement:class{},performance:{now(){return 0;}},structuredClone,
    GM_registerMenuCommand:(label,fn)=>menus.set(label,fn),
    setInterval(){throw Error('Off mode must not poll');},clearInterval(){},
    setTimeout(){throw Error('Off mode must not schedule');},clearTimeout(){},
    console:{info(){},warn(){}}
  };
  vm.createContext(ctx);vm.runInContext(code,ctx);
  return {api:win.ChatGPTRenderLiteBridge,menus,getElements:()=>elementsCreated};
}
test('default-off userscript registers controls but does not touch DOM',()=>{
  const {api,menus,getElements}=init();
  assert.equal(api.status().mode,'off');
  assert.ok(menus.size>=6);
  assert.equal(getElements(),0);
});
test('unrecognized ChatGPT markup fails closed without hiding anything',()=>{
  const {api,getElements}=init();
  assert.equal(api.probe().counts['[data-message-id]'],0);
  assert.throws(()=>api.start('preview'),/找不到安全的消息区域/);
  assert.throws(()=>api.start('takeover'),/找不到安全的消息区域/);
  assert.equal(api.status().mode,'off');
  assert.equal(getElements(),0);
});
test('custom selectors are explicit, can be reset, and reject invalid values',()=>{
  const {api}=init();
  assert.equal(api.setSelector('main article').selector,'main article');
  assert.equal(api.setSelector('').selector,'auto');
  assert.throws(()=>api.setSelector('a'.repeat(241)),/无效/);
  assert.throws(()=>api.setSelector(':bad('),/Invalid selector/);
  assert.equal(api.status().mode,'off');
});
test('status and React probe do not export conversations or credentials',()=>{
  const {api}=init();
  const data=api.status();
  assert.deepEqual(Object.keys(data).sort(),
    ['version','mode','selector','messages','mounted','lastError','reactFiberMarker'].sort());
  assert.throws(()=>api.fiberProbe(),/找不到安全的消息区域/);
});
