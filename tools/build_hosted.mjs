// Builds dist/pse-portfolio-analytics.html: one self-contained page (demo prices,
// sample workbook embedded) for hosting as a static page. Run: node tools/build_hosted.mjs
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const r = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const xlsxVer = JSON.parse(r('node_modules/xlsx/package.json')).version;
const chartVer = JSON.parse(r('node_modules/chart.js/package.json')).version;

const js = (await build({ entryPoints: [path.join(root, 'tools/hosted/entry.mjs')], bundle: true, format: 'iife', minify: true, write: false, target: 'es2020' })).outputFiles[0].text;
const css = r('public/css/style.css');
const html = r('public/index.html');
const title = html.match(/<title>.*?<\/title>/)[0];
let body = html.split('<body>')[1].split('</body>')[0].replace(/<script type="module"[^>]*><\/script>/, '');
const sample = fs.readFileSync(path.join(root, 'public/sample/PSE_Portfolio_Sample.xlsx')).toString('base64');
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
const page = `${title}
<style>
${css}
</style>
<script src="https://cdn.jsdelivr.net/npm/xlsx@${xlsxVer}/dist/xlsx.full.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@${chartVer}/dist/chart.umd.js"></script>
${body}
<script>window.PSE_SAMPLE_B64 = "${sample}";</script>
<script>${safe(js)}</script>
`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/pse-portfolio-analytics.html'), page);
console.log('wrote dist/pse-portfolio-analytics.html', (page.length / 1024).toFixed(0) + ' KB');
