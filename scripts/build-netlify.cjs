const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'netlify-deploy');
// LAN packages do not need Ably. Preserve the existing SDK for optional web builds.
let ablyRoot;
try { ablyRoot = path.resolve(path.dirname(require.resolve('ably')), '..'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const sdk = ablyRoot ? fs.readFileSync(path.join(ablyRoot, 'build/ably.min.js'))
  : fs.existsSync(path.join(out, 'vendor/ably.min.js')) ? fs.readFileSync(path.join(out, 'vendor/ably.min.js')) : null;
const license = ablyRoot ? fs.readFileSync(path.join(ablyRoot, 'LICENSE'))
  : fs.existsSync(path.join(out, 'vendor/ABLY-LICENSE')) ? fs.readFileSync(path.join(out, 'vendor/ABLY-LICENSE')) : null;
// Recreate only the known generated directory; never copy secrets or repository files.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
if (sdk && license) {
  fs.writeFileSync(path.join(out, 'vendor/ably.min.js'), sdk);
  fs.writeFileSync(path.join(out, 'vendor/ABLY-LICENSE'), license);
}
for (const asset of ['index.html', 'app.js', 'style.css', 'manifest.json', 'live-session.js', 'message-media.js', 'sha256.js', 'server-manager.html', 'server-manager.js']) {
  fs.copyFileSync(path.join(root, asset), path.join(out, asset));
}
fs.writeFileSync(path.join(out, 'dashboard-config.js'), `window.DASHBOARD_CONFIG = ${JSON.stringify({
  meetingEndpoint: '/.netlify/functions/meeting', meetingDocumentEndpoint: '/.netlify/functions/meeting-document', meetingSdk: './vendor/ably.min.js'
})};\n`);
fs.writeFileSync(path.join(out, '_headers'), `/*
  X-Content-Type-Options: nosniff
/*.html
  Cache-Control: public, max-age=0, must-revalidate
/app.js
  Cache-Control: public, max-age=0, must-revalidate
/live-session.js
  Cache-Control: public, max-age=0, must-revalidate
/message-media.js
  Cache-Control: public, max-age=0, must-revalidate
/dashboard-config.js
  Cache-Control: public, max-age=0, must-revalidate
`);
console.log(`배포 폴더 생성 완료: ${out}`);
