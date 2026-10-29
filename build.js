const fs=require('fs'),zlib=require('zlib');
const source=fs.readFileSync('index.source.html','utf8');
const match=source.match(/<script>([\s\S]*?)<\/script>/);
if(!match)throw new Error('inline app script not found');
const encoded=zlib.gzipSync(Buffer.from(match[1],'utf8'),{level:9}).toString('base64');
const boot=`<script id="daily-review-bundle" type="application/octet-stream">${encoded}</script>\n<script>(async function(){try{var s=document.getElementById('daily-review-bundle').textContent.trim(),b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);var t=await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'))).text();(0,eval)(t);}catch(e){document.body.innerHTML='<div style="padding:24px;color:#ef4444">插件加载失败：'+String(e&&e.message||e)+'</div>';}})();<\/script>`;
fs.writeFileSync('index.html',source.replace(match[0],boot),'utf8');
console.log(JSON.stringify({sourceBytes:Buffer.byteLength(source,'utf8'),bundleBase64Bytes:Buffer.byteLength(encoded,'utf8'),indexBytes:Buffer.byteLength(fs.readFileSync('index.html','utf8'),'utf8')},null,2));
