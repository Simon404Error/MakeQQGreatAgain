"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const safe = require("../src/paths-safe.js");
const {hooksFixture, hostFixture, loaderRoot, temp} = require("./helpers.cjs");

test("async IPC returns resolved dialog/install result, not empty Promise object", async()=>{
    const f=hooksFixture();
    f.hooks.installIpc(f.electron,{api:{operation:async()=>({ok:true,path:"chosen"})},rendererScripts:()=>[]});
    const result=await f.handlers.get("mqga.async")({},["operation"],[]);
    assert.equal(result.ok,true);
    assert.equal(result.path,"chosen");
});
test("async IPC preserves useful rejection message", async()=>{
    const f=hooksFixture();
    f.hooks.installIpc(f.electron,{api:{operation:async()=>{throw new Error("dialog cancelled by system");}},rendererScripts:()=>[]});
    const result=await f.handlers.get("mqga.async")({},["operation"],[]);
    assert.match(result.mqga_error,/dialog cancelled/);
});
test("sync IPC explicitly rejects Promise-valued APIs",()=>{
    const f=hooksFixture();
    f.hooks.installIpc(f.electron,{api:{operation:async()=>({ok:true})},rendererScripts:()=>[]});
    const ev={sender:null}; f.listeners.get("mqga.sync")(ev,["operation"],[]);
    assert.match(ev.returnValue.mqga_error,/mqga.async/);
});
test("API invocation keeps method receiver",async()=>{
    const f=hooksFixture();
    f.hooks.installIpc(f.electron,{api:{nested:{value:7,method(){return this.value;}}},rendererScripts:()=>[]});
    assert.equal(await f.handlers.get("mqga.async")({},["nested","method"],[]),7);
});
test("malformed/prototype API paths return explicit errors",async()=>{
    const f=hooksFixture();
    f.hooks.installIpc(f.electron,{api:{},rendererScripts:()=>[]});
    for (const p of [null,[],["__proto__"],["constructor"],["missing"]]) {
        assert.ok((await f.handlers.get("mqga.async")({},p,[])).mqga_error);
    }
});
test("IPC initialization is idempotent",()=>{
    const f=hooksFixture(); const state={api:{},rendererScripts:()=>[]};
    f.hooks.installIpc(f.electron,state);
    assert.doesNotThrow(()=>f.hooks.installIpc(f.electron,state));
});
test("native preload registers once and avoids legacy duplicate paths",()=>{
    const f=hooksFixture(); let native=0;
    const session={registerPreloadScript(){native++;},getPreloadScripts(){return [];}};
    const original=session.getPreloadScripts;
    assert.equal(f.hooks.injectPreloadIntoSession(session),true);
    assert.equal(f.hooks.injectPreloadIntoSession(session),true);
    assert.equal(native,1); assert.equal(session.getPreloadScripts,original);
});
test("failed preload registration remains retryable",()=>{
    const f=hooksFixture(); let attempts=0;
    const session={registerPreloadScript(){if (++attempts===1) throw new Error("not ready");}};
    assert.equal(f.hooks.injectPreloadIntoSession(session),false);
    assert.equal(f.hooks.injectPreloadIntoSession(session),true);
    assert.equal(attempts,2);
});
test("legacy preload wrapper does not mutate Electron's original array",()=>{
    const f=hooksFixture(); const original=[];
    const session={getPreloadScripts(){return original;}};
    assert.equal(f.hooks.injectPreloadIntoSession(session),false);
    assert.equal(session.getPreloadScripts().length,1);
    assert.equal(original.length,0);
    f.hooks.injectPreloadIntoSession(session);
    assert.equal(session.getPreloadScripts().length,1);
});
test("electron fallback captures BrowserWindow without recursive getter",()=>{
    const f=hooksFixture({noElectronCache:true});
    const electron=f.hooks.installElectronHook();
    const Constructor=electron.BrowserWindow;
    assert.equal(typeof Constructor,"function");
    const win=new Constructor(); assert.ok(win instanceof f.OriginalWindow);
});
test("protocol registration waits for ready and then registers both schemes",()=>{
    const f=hooksFixture();
    f.hooks.registerProtocolOn(f.electron,f.electron.protocol);
    assert.equal(f.protocols.size,0);
    f.setReady(true); f.hooks.registerProtocolOn(f.electron,f.electron.protocol);
    assert.equal(f.protocols.size,2);
});
test("IPC filesystem prefix lookalikes are denied",async()=>{
    const f=hooksFixture();
    f.hooks.installIpc(f.electron,{api:{},rendererScripts:()=>[]});
    const other=f.host.PATHS.root+"-other"; fs.mkdirSync(other);
    const file=path.join(other,"private.txt"); fs.writeFileSync(file,"not loader content");
    await assert.rejects(()=>f.handlers.get("mqga.readFile")({},file),/拒绝/);
});
test("canonical path checks reject traversal and allow new files inside root",()=>{
    const base=path.join(temp,"allowed");fs.mkdirSync(base);
    assert.equal(safe.isWithin(path.join(base,"data","new.json"),base),true);
    assert.equal(safe.isWithin(base+"-neighbor",base),false);
    assert.equal(safe.isWithin(path.join(base,"..","outside"),base),false);
    assert.throws(()=>safe.assertAllowed(path.join(base,"..","outside"),[base]));
});
test("mqga protocol rejects neighboring-directory traversal",async()=>{
    const f=hooksFixture();f.setReady(true);f.hooks.registerProtocolOn(f.electron,f.electron.protocol);
    const response=await f.protocols.get("mqga")({url:"mqga://root/%2e%2e%2foutside.txt"});
    assert.equal(response.status,403);
});
test("preload dialog actions use async invoke",()=>{
    const source=fs.readFileSync(path.join(loaderRoot,"src","preload.js"),"utf8");
    assert.match(source,/pickAndInstall: async \(mode\) => invoke/);
    assert.match(source,/pickAndInstallFolder: async \(\) => invoke/);
});
test("native QQ entry is attempted when loader bootstrap fails",()=>{
    const host={PATHS:{root:temp,profile:temp,logs:temp},log:()=>{},loaderConfig:()=>({}),writeJson:()=>{}};
    let nativeStarts=0;
    const req=(name)=>{
        if (name==="path") return path;
        if (name==="./host.js") return host;
        if (name==="./hooks.js") return {installElectronHook(){throw new Error("simulated loader failure");}};
        if (name===path.join(temp,"package.json")) return {version:"test-fixed"};
        if (name.includes("application.asar")) {nativeStarts++;return {};}
        throw new Error("Unexpected require: "+name);
    };
    const module={exports:{}};
    vm.runInNewContext(fs.readFileSync(path.join(loaderRoot,"src","main.js"),"utf8"),{
        require:req,module,exports:module.exports,global:{},globalThis:{},setImmediate:()=>{},console,
        process:{pid:999,versions:{},platform:"win32",resourcesPath:path.join(temp,"QQ","resources")}
    },{filename:"main.js"});
    assert.equal(nativeStarts,1);assert.equal(module.exports.ready,false);assert.equal(module.exports.qqStarted,true);
    assert.match(module.exports.error,/simulated loader failure/);
});
test("startup marker is explicit, not inferred from require() returning",()=>{
    const source=fs.readFileSync(path.join(loaderRoot,"src","main.js"),"utf8");
    assert.match(source,/startup-status\.json/);
    assert.match(source,/module\.exports = startupStatus/);
});
test("atomic config write replaces complete JSON and removes temporary file",()=>{
    const f=hostFixture(),file=path.join(f.root,"data","atomic.json");
    f.host.writeJson(file,{revision:1});f.host.writeJson(file,{revision:2,payload:"完整配置"});
    assert.deepEqual(JSON.parse(fs.readFileSync(file,"utf8")),{revision:2,payload:"完整配置"});
    assert.equal(fs.readdirSync(path.dirname(file)).some(name=>name.includes(".tmp-")),false);
});
test("failed config replacement preserves the old file",()=>{
    const f=hostFixture(),file=path.join(f.root,"data","atomic.json");
    f.host.writeJson(file,{revision:1});
    const original=fs.renameSync;
    try {
        fs.renameSync=(from,to)=>{if(to===file)throw new Error("simulated locked config");return original(from,to);};
        assert.throws(()=>f.host.writeJson(file,{revision:2}),/locked config/);
    }finally{fs.renameSync=original;}
    assert.deepEqual(JSON.parse(fs.readFileSync(file,"utf8")),{revision:1});
    assert.equal(fs.readdirSync(path.dirname(file)).some(name=>name.includes(".tmp-")),false);
});
test("failed pending plugin deletion stays queued and preserves plugin content",()=>{
    const f=hostFixture(),plugin=path.join(f.root,"plugins","locked-plugin");
    fs.mkdirSync(plugin,{recursive:true});fs.writeFileSync(path.join(plugin,"keep.txt"),"preserve");
    const config=path.join(f.root,"data","LiteLoader","config.json");
    f.host.writeJson(config,{deleting_plugins:{"locked-plugin":{self:true,data:false}}});
    const original=fs.renameSync;
    try {
        fs.renameSync=(from,to)=>{if(from===plugin)throw new Error("simulated locked directory");return original(from,to);};
        const results=f.host.applyPendingPluginDeletions();assert.equal(results[0].result.ok,false);
    }finally{fs.renameSync=original;}
    assert.ok(JSON.parse(fs.readFileSync(config,"utf8")).deleting_plugins["locked-plugin"]);
    assert.equal(fs.readFileSync(path.join(plugin,"keep.txt"),"utf8"),"preserve");
});
