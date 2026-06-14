const fs = require('fs');
const path = require('path');

const targetFile = path.resolve('src/routes/crm_dashboard.js');
let content = fs.readFileSync(targetFile, 'utf8');

const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Find ${js(
    const jsIndex = line.indexOf("${js('");
    if (jsIndex !== -1) {
        // Is it part of string concatenation? 
        // e.g., ... + ${js(...) + ...
        // We look for a plus sign, or if it's inside a javascript const/let assignment.
        const isConcat = line.includes(" + ${js(") || line.includes("} + ${js(") || line.includes(") + ${js(");
        const isAssign = line.includes("const ") || line.includes("let ") || line.includes(" = ");
        const isPrompt = line.includes("prompt(") || line.includes("showToast(") || line.includes("showConfirm(");
        const isObj = line.includes("': ${js(");
        
        if (!isConcat && !isAssign && !isPrompt && !isObj) {
            console.log(`Line ${i+1}: ${line.trim()}`);
        }
    }
}
