"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const {hooksFixture, hostFixture, loaderRoot} = require("./helpers.cjs");
function pluginFixture() {
    const f = hostFixture(), slug = "replace-test";
    const dest = path.join(f.root,"plugins",slug), source = path.join(f.root,"incoming");
    fs.mkdirSync(dest,{recursive:true});fs.mkdirSync(source,{recursive:true});
    const manifest = {manifest_version:4,type:"extension",slug,name:"Replacement test",version:"1.0.0",injects:{main:"main.js"}};
    fs.writeFileSync(path.join(dest,"manifest.json"),JSON.stringify(manifest));
    fs.writeFileSync(path.join(dest,"main.js"),"old version");
    fs.writeFileSync(path.join(source,"manifest.json"),JSON.stringify({...manifest,version:"2.0.0"}));
    fs.writeFileSync(path.join(source,"main.js"),"new version");
    return {...f,slug,dest,source};
}
function preloadApi(sync,invoke) {
    const text = fs.readFileSync(path.join(loaderRoot,"src","preload.js"),"utf8");
    const start = text.indexOf("const apiMethods = {");
    const end = text.indexOf("const hostVersion =",start);
    return vm.runInNewContext(text.slice(start,end)+"\napiMethods;",{sync,invoke,require});
}
test("failed replacement activation restores the entire old plugin",()=>{
    const f = pluginFixture(), original = fs.renameSync;
    let result;
    try {
        fs.renameSync = (from,to)=>{
            if (to === f.dest && String(from).includes(".installing-")) throw new Error("simulated activation failure");
            return original(from,to);
        };
        result = f.host.installPlugin(f.source);
    }finally{fs.renameSync=original;}
    assert.equal(result.ok,false);
    assert.equal(fs.readFileSync(path.join(f.dest,"main.js"),"utf8"),"old version");
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dest,"manifest.json"),"utf8")).version,"1.0.0");
});
test("if rollback rename fails, old plugin remains at a reported recovery path",()=>{
    const f = pluginFixture(), original = fs.renameSync;
    let result;
    try {
        fs.renameSync = (from,to)=>{if(to===f.dest)throw new Error("simulated activation and rollback failure");return original(from,to);};
        result = f.host.installPlugin(f.source);
    }finally{fs.renameSync=original;}
    assert.equal(result.ok,false);assert.equal(typeof result.recoveryPath,"string");
    assert.equal(fs.readFileSync(path.join(result.recoveryPath,"main.js"),"utf8"),"old version");
});
test("staging cleanup failure after activation does not misreport a successful install",()=>{
    const f = pluginFixture(), original = fs.rmSync;
    let result;
    try {
        fs.rmSync = (file,options)=>{if(path.basename(String(file)).startsWith(".installing-"))throw new Error("simulated cleanup failure");return original(file,options);};
        result = f.host.installPlugin(f.source);
    }finally{fs.rmSync=original;}
    assert.equal(result.ok,true);assert.equal(result.replaced,true);
    assert.equal(fs.readFileSync(path.join(f.dest,"main.js"),"utf8"),"new version");
});
test("successful replacement activates the new version and retains plugin data",()=>{
    const f = pluginFixture(), data = path.join(f.root,"data",f.slug,"config.json");
    f.host.writeJson(data,{keep:true});
    const result=f.host.installPlugin(f.source);
    assert.equal(result.ok,true);assert.equal(result.replaced,true);
    assert.equal(fs.readFileSync(path.join(f.dest,"main.js"),"utf8"),"new version");
    assert.deepEqual(JSON.parse(fs.readFileSync(data,"utf8")),{keep:true});
});
test("reserved and invalid deletion slugs are rejected before directory removal",()=>{
    const f=hostFixture(), file=path.join(f.root,"data","keep","config.json");f.host.writeJson(file,{keep:true});
    for(const slug of [".","..","CON","NUL.txt","test:stream","foo.","bad?slug"]){
        const result=f.host.uninstallPlugin(slug,{mode:"data"});
        assert.equal(result.ok,false,slug);
    }
    assert.equal(fs.existsSync(file),true);
});
test("unknown deletion modes and invalid options never default to deleting everything",()=>{
    const f=pluginFixture();
    for(const options of [{mode:"typo"},{mode:""},null,42,"plugin"]){
        let result;assert.doesNotThrow(()=>{result=f.host.uninstallPlugin(f.slug,options);});
        assert.equal(result.ok,false);
    }
    assert.equal(fs.readFileSync(path.join(f.dest,"main.js"),"utf8"),"old version");
});
test("queued deletion with both choices false removes neither plugin nor data",()=>{
    const f=pluginFixture(), data=path.join(f.root,"data",f.slug,"config.json"), queue=path.join(f.root,"data","LiteLoader","config.json");
    f.host.writeJson(data,{keep:true});f.host.writeJson(queue,{deleting_plugins:{[f.slug]:{self:false,data:false}}});
    const result=f.host.applyPendingPluginDeletions();
    assert.equal(result[0].result.ok,true);assert.equal(result[0].result.mode,"none");
    assert.equal(fs.existsSync(path.join(f.dest,"main.js")),true);assert.equal(fs.existsSync(data),true);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(queue,"utf8")).deleting_plugins).length,0);
});
test("data-only deletion preserves a disabled installed plugin",()=>{
    const f=pluginFixture();f.host.writeJson(path.join(f.root,"data",f.slug,"config.json"),{reset:true});
    f.host.saveLoaderConfig({disabled_plugins:[f.slug]});
    const result=f.host.uninstallPlugin(f.slug,{mode:"data"});
    assert.equal(result.ok,true);assert.equal(fs.existsSync(f.dest),true);
    assert.equal(f.host.loaderConfig().disabled_plugins.includes(f.slug),true);
});
test("failed plugin deletion does not clean its disabled state",()=>{
    const f=pluginFixture(), original=fs.renameSync;f.host.saveLoaderConfig({disabled_plugins:[f.slug]});
    let result;
    try {
        fs.renameSync=(from,to)=>{if(from===f.dest)throw new Error("locked plugin");return original(from,to);};
        result=f.host.uninstallPlugin(f.slug,{mode:"plugin"});
    }finally{fs.renameSync=original;}
    assert.equal(result.ok,false);assert.equal(f.host.loaderConfig().disabled_plugins.includes(f.slug),true);
});
test("public pickAndInstallPlugin alias uses async invoke rather than sync IPC",async()=>{
    const calls=[];
    const api=preloadApi(()=>{throw new Error("sync path used for async dialog");},(method,args)=>{calls.push({method,args});return Promise.resolve({ok:true,path:"chosen"});});
    assert.equal((await api.pickAndInstallPlugin("zip")).ok,true);
    assert.equal(calls.length,1);assert.equal(calls[0].method[0],"pickAndInstallPlugin");
});
test("preload translates [false,false] deletion choices into a no-op",async()=>{
    const calls=[],api=preloadApi(()=>{throw new Error("unexpected sync IPC");},(method,args)=>{calls.push({method,args});return Promise.resolve({ok:true});});
    await api.plugin.delete("example",[false,false],true);
    assert.equal(calls[0].args[1].mode,"none");
});
test("malformed preload deletion flags never become destructive requests",async()=>{
    const calls=[],api=preloadApi(()=>{throw new Error("unexpected sync IPC");},(method,args)=>{calls.push({method,args});return Promise.resolve({ok:true});});
    for(const flags of [["false",false],[false],[]])assert.equal((await api.plugin.delete("example",flags)).ok,false);
    assert.equal(calls.length,0);
});
test("protocol retries only the scheme that previously failed",()=>{
    const f=hooksFixture(), calls={mqga:0,local:0};f.setReady(true);
    f.electron.protocol.handle=(scheme,handler)=>{
        calls[scheme]++;
        if(scheme==="local"&&calls.local===1)throw new Error("transient registration failure");
        if(f.protocols.has(scheme))throw new Error("already registered");
        f.protocols.set(scheme,handler);
    };
    f.hooks.registerProtocolOn(f.electron,f.electron.protocol);
    f.hooks.registerProtocolOn(f.electron,f.electron.protocol);
    f.hooks.registerProtocolOn(f.electron,f.electron.protocol);
    assert.deepEqual(calls,{mqga:1,local:2});assert.equal(f.protocols.size,2);
});
test("legacy disabled-list cleanup survives queued-deletion bookkeeping",()=>{
    const f=pluginFixture(),file=path.join(f.root,"data","LiteLoader","config.json");
    f.host.writeJson(file,{disabled_plugins:[f.slug],extra:"preserve",deleting_plugins:{[f.slug]:{self:true,data:false}}});
    const result=f.host.applyPendingPluginDeletions(),cfg=JSON.parse(fs.readFileSync(file,"utf8"));
    assert.equal(result[0].result.ok,true);assert.deepEqual(cfg.disabled_plugins,[]);
    assert.equal(cfg.extra,"preserve");assert.deepEqual(cfg.deleting_plugins,{});
});
test("invalid queued flags stay pending without deleting a plugin",()=>{
    const f=pluginFixture(),file=path.join(f.root,"data","LiteLoader","config.json");
    f.host.writeJson(file,{deleting_plugins:{[f.slug]:{self:"false",data:false}}});
    const result=f.host.applyPendingPluginDeletions();
    assert.equal(result[0].result.ok,false);assert.equal(fs.existsSync(f.dest),true);
    assert.ok(JSON.parse(fs.readFileSync(file,"utf8")).deleting_plugins[f.slug]);
});
test("legacy config write failure keeps the queue and allows an idempotent retry",()=>{
    const f=pluginFixture(),file=path.join(f.root,"data","LiteLoader","config.json"),original=fs.renameSync;
    f.host.writeJson(file,{disabled_plugins:[f.slug],deleting_plugins:{[f.slug]:{self:true,data:false}}});
    try {
        fs.renameSync=(from,to)=>{if(to===file)throw new Error("legacy config locked");return original(from,to);};
        assert.equal(f.host.applyPendingPluginDeletions()[0].result.ok,false);
    }finally{fs.renameSync=original;}
    assert.ok(JSON.parse(fs.readFileSync(file,"utf8")).deleting_plugins[f.slug]);
    assert.equal(f.host.applyPendingPluginDeletions()[0].result.ok,true);
    const cfg=JSON.parse(fs.readFileSync(file,"utf8"));
    assert.deepEqual(cfg.disabled_plugins,[]);assert.deepEqual(cfg.deleting_plugins,{});
});
test("queue completion preserves newly added requests and settings",()=>{
    const f=pluginFixture(),file=path.join(f.root,"data","LiteLoader","config.json"),original=fs.renameSync;
    f.host.writeJson(file,{disabled_plugins:[f.slug],extra:"old",deleting_plugins:{[f.slug]:{self:true,data:false}}});
    let injected=false;
    try {
        fs.renameSync=(from,to)=>{
            const result=original(from,to);
            if(to===file&&!injected){
                injected=true;const latest=JSON.parse(fs.readFileSync(file,"utf8"));
                latest.extra="new";latest.deleting_plugins.another={self:false,data:true};f.host.writeJson(file,latest);
            }
            return result;
        };
        assert.equal(f.host.applyPendingPluginDeletions().length,1);
    }finally{fs.renameSync=original;}
    const cfg=JSON.parse(fs.readFileSync(file,"utf8"));
    assert.equal(injected,true);assert.equal(cfg.extra,"new");assert.deepEqual(cfg.disabled_plugins,[]);
    assert.deepEqual(cfg.deleting_plugins,{another:{self:false,data:true}});
});
test("missing manifest slug is rejected without disturbing the installed plugin",()=>{
    const f=pluginFixture(),file=path.join(f.source,"manifest.json");
    const manifest=JSON.parse(fs.readFileSync(file,"utf8"));delete manifest.slug;fs.writeFileSync(file,JSON.stringify(manifest));
    assert.equal(f.host.installPlugin(f.source).ok,false);
    assert.equal(fs.readFileSync(path.join(f.dest,"main.js"),"utf8"),"old version");
});
test("no-op deletion of a protected plugin changes no files",()=>{
    const f=pluginFixture();f.host.saveLoaderConfig({protected_plugins:[f.slug]});
    const result=f.host.uninstallPlugin(f.slug,{mode:"none"});
    assert.equal(result.ok,true);assert.equal(result.skipped,true);assert.equal(fs.existsSync(f.dest),true);
});
test("failed all-mode plugin removal preserves data and disabled state",()=>{
    const f=pluginFixture(),file=path.join(f.root,"data",f.slug,"config.json"),original=fs.renameSync;
    f.host.writeJson(file,{keep:true});f.host.saveLoaderConfig({disabled_plugins:[f.slug]});
    let result;
    try{
        fs.renameSync=(from,to)=>{if(from===f.dest)throw new Error("plugin still locked");return original(from,to);};
        result=f.host.uninstallPlugin(f.slug,{mode:"all"});
    }finally{fs.renameSync=original;}
    assert.equal(result.ok,false);assert.equal(fs.existsSync(f.dest),true);
    assert.equal(fs.existsSync(file),true);assert.equal(f.host.loaderConfig().disabled_plugins.includes(f.slug),true);
});
test("manifest slug whitespace is rejected instead of creating mismatched identifiers",()=>{
    const f=pluginFixture(),file=path.join(f.source,"manifest.json"),manifest=JSON.parse(fs.readFileSync(file,"utf8"));
    for(const slug of [" leading","trailing "]){
        fs.writeFileSync(file,JSON.stringify({...manifest,slug}));
        assert.equal(f.host.installPlugin(f.source).ok,false);
    }
    assert.equal(fs.readFileSync(path.join(f.dest,"main.js"),"utf8"),"old version");
});
