"use strict";
const fs = require("fs");
const path = require("path");
function canonical(file) {
    let current = path.resolve(String(file));
    const tail = [];
    while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) break;
        tail.unshift(path.basename(current));
        current = parent;
    }
    if (fs.existsSync(current)) current = fs.realpathSync(current);
    return path.resolve(current, ...tail);
}
function isWithin(file, directory) {
    const relative = path.relative(canonical(directory), canonical(file));
    return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}
function assertAllowed(file, directories) {
    if (typeof file !== "string" || !file || file.includes("\0")) throw new Error("无效的文件路径");
    const resolved = canonical(file);
    if (!directories.some((base) => isWithin(resolved, base))) throw new Error("拒绝访问加载器范围之外的路径: " + resolved);
    return resolved;
}
module.exports = { canonical, isWithin, assertAllowed };
