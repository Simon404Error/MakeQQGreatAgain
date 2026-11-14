"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {hostFixture}=require("./helpers.cjs");
function configFixture(){
    const f=hostFixture(),legacy=path.join(f.root,"data","LiteLoader","config.json"),loader=path.join(f.root,"data","loader.json");
    f.host.writeJson(loader,{enable_plugins:true,disabled_plugins:["old"],renderer_inject:"webframe"});
    fs.mkdirSync(path.dirname(legacy),{recursive:true});
    fs.writeFileSync(legacy,'﻿{\n  "enable_plugins": true, "disabled_plugins": ["old"], "extra": "keep", "deleting_plugins": {}\n}\n');
    return {...f,legacy,loader};
}
test("saving shared preferences updates the legacy override and preserves its other fields",()=>{
    const f=configFixture();f.host.saveLoaderConfig({enable_plugins:false,disabled_plugins:["new"],renderer_inject:"execute"});
    const effective=f.host.loaderConfig(),legacy=JSON.parse(fs.readFileSync(f.legacy,"utf8").replace(/^﻿/,""));
    assert.equal(effective.enable_plugins,false);assert.deepEqual(Array.from(effective.disabled_plugins),["new"]);
    assert.equal(legacy.extra,"keep");assert.deepEqual(legacy.deleting_plugins,{});
});
test("legacy write failure leaves both configuration files unchanged",()=>{
    const f=configFixture(),beforeLoader=fs.readFileSync(f.loader),beforeLegacy=fs.readFileSync(f.legacy),original=fs.renameSync;
    try{
        fs.renameSync=(from,to)=>{if(to===f.legacy)throw new Error("legacy locked");return original(from,to);};
        assert.throws(()=>f.host.saveLoaderConfig({enable_plugins:false,disabled_plugins:[]}),/legacy locked/);
    }finally{fs.renameSync=original;}
    assert.deepEqual(fs.readFileSync(f.loader),beforeLoader);assert.deepEqual(fs.readFileSync(f.legacy),beforeLegacy);
});
test("loader write failure restores the exact old legacy file including BOM",()=>{
    const f=configFixture(),beforeLoader=fs.readFileSync(f.loader),beforeLegacy=fs.readFileSync(f.legacy),original=fs.renameSync;
    let legacyWrites=0;
    try{
        fs.renameSync=(from,to)=>{if(to===f.loader)throw new Error("loader locked");if(to===f.legacy)legacyWrites++;return original(from,to);};
        assert.throws(()=>f.host.saveLoaderConfig({enable_plugins:false,disabled_plugins:[]}),/loader locked/);
    }finally{fs.renameSync=original;}
    assert.equal(legacyWrites>=2,true);assert.deepEqual(fs.readFileSync(f.loader),beforeLoader);assert.deepEqual(fs.readFileSync(f.legacy),beforeLegacy);
});
test("blocked configuration rollback reports a retained original backup",()=>{
    const f=configFixture(),beforeLegacy=fs.readFileSync(f.legacy),original=fs.renameSync;
    let legacyWrites=0,error;
    try{
        fs.renameSync=(from,to)=>{
            if(to===f.loader)throw new Error("loader locked");
            if(to===f.legacy&&++legacyWrites>1)throw new Error("rollback locked");
            return original(from,to);
        };
        try{f.host.saveLoaderConfig({enable_plugins:false,disabled_plugins:[]});}catch(e){error=e;}
    }finally{fs.renameSync=original;}
    assert.ok(error);assert.equal(typeof error.recoveryPath,"string");assert.deepEqual(fs.readFileSync(error.recoveryPath),beforeLegacy);
});
test("invalid shared preference types are rejected without altering old configuration",()=>{
    const f=configFixture(),before=fs.readFileSync(f.loader);
    for(const value of [{enable_plugins:"false"},{disabled_plugins:"name"},{disabled_plugins:[42]},null,[]])assert.throws(()=>f.host.saveLoaderConfig(value));
    assert.deepEqual(fs.readFileSync(f.loader),before);
});
test("malformed legacy JSON is not overwritten during shared preference updates",()=>{
    const f=configFixture();fs.writeFileSync(f.legacy,'{ "incomplete": ');
    const beforeLoader=fs.readFileSync(f.loader),beforeLegacy=fs.readFileSync(f.legacy);
    assert.throws(()=>f.host.saveLoaderConfig({enable_plugins:false}));
    assert.deepEqual(fs.readFileSync(f.loader),beforeLoader);assert.deepEqual(fs.readFileSync(f.legacy),beforeLegacy);
});
test("preferences without shared fields do not rewrite the legacy file",()=>{
    const f=configFixture(),before=fs.readFileSync(f.legacy);
    f.host.saveLoaderConfig({renderer_inject:"execute"});
    assert.deepEqual(fs.readFileSync(f.legacy),before);assert.equal(f.host.loaderConfig().renderer_inject,"execute");
});
test("a failed save never overwrites later legacy edits during rollback",()=>{
    const f=configFixture(),beforeLegacy=fs.readFileSync(f.legacy),original=fs.renameSync;
    let injected=false,error;
    try{
        fs.renameSync=(from,to)=>{
            if(to===f.loader)throw new Error("loader locked");
            const result=original(from,to);
            if(to===f.legacy&&!injected){injected=true;const latest=JSON.parse(fs.readFileSync(f.legacy,"utf8"));latest.extra="later edit";fs.writeFileSync(f.legacy,JSON.stringify(latest));}
            return result;
        };
        try{f.host.saveLoaderConfig({enable_plugins:false,disabled_plugins:[]});}catch(e){error=e;}
    }finally{fs.renameSync=original;}
    assert.equal(injected,true);assert.ok(error);assert.equal(typeof error.recoveryPath,"string");
    assert.equal(JSON.parse(fs.readFileSync(f.legacy,"utf8")).extra,"later edit");
    assert.deepEqual(fs.readFileSync(error.recoveryPath),beforeLegacy);
});
test("configuration namespaces reject traversal and reserved identifiers",()=>{
    const f=hostFixture();
    for(const slug of [".","..","../outside","a/b","CON","slot:stream"]){
        assert.throws(()=>f.host.getConfig(slug,{}));assert.throws(()=>f.host.setConfig(slug,{changed:true}));
    }
});
test("configuration APIs cannot escape the data root through a junction or symlink",()=>{
    const f=hostFixture(),outside=path.join(f.root,"outside-data"),file=path.join(outside,"config.json"),link=path.join(f.root,"data","linked");
    fs.mkdirSync(outside);fs.writeFileSync(file,JSON.stringify({keep:true}));
    fs.symlinkSync(outside,link,process.platform==="win32"?"junction":"dir");
    assert.throws(()=>f.host.getConfig("linked",{}));assert.throws(()=>f.host.setConfig("linked",{changed:true}));
    assert.deepEqual(JSON.parse(fs.readFileSync(file,"utf8")),{keep:true});
});
test("valid configuration namespaces still support default values and updates",()=>{
    const f=hostFixture();assert.equal(f.host.getConfig("valid-plugin",{enabled:true}).enabled,true);
    f.host.setConfig("valid-plugin",{enabled:false});assert.equal(f.host.getConfig("valid-plugin",{enabled:true}).enabled,false);
});
