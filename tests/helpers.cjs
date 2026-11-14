"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const safe = require("../src/paths-safe.js");
const loaderRoot = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mqga-fixed-test-"));
process.on("exit", () => fs.rmSync(temp, {recursive:true,force:true}));

function hooksFixture(options = {}) {
    const root = path.join(temp, "host-" + Math.random().toString(16).slice(2));
    fs.mkdirSync(root, {recursive:true});
    const listeners = new Map(), handlers = new Map(), messages = [];
    const host = {PATHS:{root,profile:root,plugins:path.join(root,"plugins"),preload:path.join(root,"src","preload.js")},log:(...args)=>messages.push(args),emit:()=>{}};
    let ready = false;
    const protocols = new Map();
    const protocol = {registerSchemesAsPrivileged:()=>{},handle:(scheme,fn)=>{protocols.set(scheme,fn);}};
    const ipcMain = {on:(name,fn)=>listeners.set(name,fn),handle:(name,fn)=>{
        if (handlers.has(name)) throw new Error("second handler");
        handlers.set(name,fn);
    }};
    class OriginalWindow { constructor(){ this.webContents={session:null}; } }
    const electron = {app:{isReady:()=>ready},protocol,ipcMain,BrowserWindow:OriginalWindow,net:{fetch:async(url)=>({ok:true,url})}};
    const module = {exports:{}};
    const req = (name)=>{
        if (name==="./host.js") return host;
        if (name==="./paths-safe.js") return safe;
        if (name==="electron") return electron;
        return require(name);
    };
    req.cache = options.noElectronCache ? {} : {electron:{exports:electron}};
    vm.runInNewContext(fs.readFileSync(path.join(loaderRoot,"src","hooks.js"),"utf8"),{require:req,module,exports:module.exports,console,URL,Response},{filename:"hooks.js"});
    return {hooks:module.exports,electron,host,handlers,listeners,messages,protocols,setReady:(value)=>{ready=value;},OriginalWindow};
}

function hostFixture() {
    const root=path.join(temp,"profile-"+Math.random().toString(16).slice(2));
    fs.mkdirSync(path.join(root,"src"),{recursive:true});
    const module={exports:{}};
    const proc={pid:process.pid,env:{MQGA_PROFILE:root},resourcesPath:path.join(root,"QQ","resources")};
    vm.runInNewContext(fs.readFileSync(path.join(loaderRoot,"src","host.js"),"utf8"),{
        require,module,exports:module.exports,__dirname:path.join(root,"src"),process:proc,
        console:{log(){}},setInterval:()=>({unref(){}}),Date,Map,Set,Buffer,SharedArrayBuffer,Int32Array,Atomics
    },{filename:"host.js"});
    return {host:module.exports,root};
}
module.exports = {hooksFixture, hostFixture, loaderRoot, temp};
