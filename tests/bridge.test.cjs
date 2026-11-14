"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {hostFixture,loaderRoot}=require("./helpers.cjs");
test("openExternal propagates an asynchronous shell failure instead of returning success",async()=>{
    const rejection=Promise.reject(new Error("shell refused URL"));rejection.catch(()=>{});
    const f=hostFixture({electron:{shell:{openExternal:()=>rejection}}});
    await assert.rejects(()=>f.host.createApi({}).openExternal("https://example.test"),/shell refused URL/);
});
test("openPath reports a fulfilled error string and succeeds only on an empty error",async()=>{
    const f=hostFixture({electron:{shell:{openPath:async(target)=>target==="ok"?"":"path not found"}}});
    const api=f.host.createApi({});
    await assert.rejects(()=>api.openPath("missing"),/path not found/);
    assert.equal(await api.openPath("ok"),true);
});
test("public async preload methods use invoke rather than blocking sync calls",async()=>{
    const text=fs.readFileSync(path.join(loaderRoot,"src","preload.js"),"utf8"),start=text.indexOf("const apiMethods = {"),end=text.indexOf("const hostVersion =",start),calls=[];
    const api=vm.runInNewContext(text.slice(start,end)+"\napiMethods;",{
        require,sync:()=>{throw new Error("unexpected sync IPC");},invoke:(method,args)=>{calls.push({method,args});return Promise.resolve({ok:true});}
    });
    const run=[
        ()=>api.config.get("test",{}),()=>api.config.set("test",{}),()=>api.plugin.install("source"),
        ()=>api.plugin.uninstall("test",{mode:"none"}),()=>api.plugin.delete("test",[false,false],true),
        ()=>api.plugin.installFromPath("source",{}),()=>api.plugin.setLoaderConfig({}),()=>api.plugin.disable("test"),()=>api.plugin.enable("test"),
        ()=>api.openExternal("https://example.test"),()=>api.openPath("mock"),()=>api.log("test"),()=>api.reloadPlugins(),()=>api.setLoaderConfig({}),
        ()=>api.installPluginFromPath("source",{}),()=>api.pickAndInstallPlugin("zip"),()=>api.plugin.pickAndInstall("zip"),()=>api.plugin.pickAndInstallFolder()
    ];
    for(const action of run)assert.equal((await action()).ok,true);
    assert.equal(calls.length,run.length);
});
