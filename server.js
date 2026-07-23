'use strict';

const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PORT = process.env.PORT || 3000;

// Stub browser globals pdfjs checks for at load time (Node.js has neither)
if (typeof globalThis.DOMMatrix === 'undefined') globalThis.DOMMatrix = class DOMMatrix {};
if (typeof globalThis.Path2D === 'undefined') globalThis.Path2D = class Path2D {};

let pdfjsLib = null;
async function getPdfjs() {
  if (!pdfjsLib) {
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjsLib = mod;
    if (pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    }
  }
  return pdfjsLib;
}

async function extractPdf(pdfBase64) {
  const pdfjs = await getPdfjs();
  const pdfBuffer = Buffer.from(pdfBase64, 'base64');

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });

  const pdf = await loadingTask.promise;
  const lines = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // Group items into rows by y-position (3pt tolerance)
    const rows = [];
    for (const item of content.items) {
      if (!item.str || item.str.trim() === '') continue;
      const y = Math.round(item.transform[5]);
      let row = rows.find(r => Math.abs(r.y - y) <= 3);
      if (!row) {
        row = { y, items: [] };
        rows.push(row);
      }
      row.items.push({ x: Math.round(item.transform[4]), text: item.str });
    }

    // Sort rows top-to-bottom, items left-to-right within each row
    rows.sort((a, b) => b.y - a.y);
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      // Split row into column segments at large horizontal gaps (>40pts)
      const segments = [];
      let current = [row.items[0]];
      for (let i = 1; i < row.items.length; i++) {
        const gap = row.items[i].x - (row.items[i - 1].x + row.items[i - 1].text.length * 4);
        if (gap > 40) {
          segments.push(current);
          current = [];
        }
        current.push(row.items[i]);
      }
      segments.push(current);
      lines.push(segments.map(seg => seg.map(it => it.text).join(' ')).join(' | '));
    }
  }

  return { text: lines.join('\n') };
}

async function renderPdf(pdfBase64) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  const outPrefix = path.join(tmpDir, 'page');
  try {
    fs.writeFileSync(pdfPath, Buffer.from(pdfBase64, 'base64'));
    await new Promise((resolve, reject) => {
      execFile('pdftoppm', ['-jpeg', '-r', '150', '-l', '1', pdfPath, outPrefix], (err) => {
        if (err) reject(err); else resolve();
      });
    });
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.jpg'));
    if (!files.length) throw new Error('pdftoppm produced no output');
    const imgPath = path.join(tmpDir, files[0]);
    return { imageBase64: fs.readFileSync(imgPath).toString('base64') };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/render') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { pdfBase64 } = JSON.parse(body);
        if (!pdfBase64) throw new Error('pdfBase64 is required');
        const result = await renderPdf(pdfBase64);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/extract') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const { pdfBase64 } = JSON.parse(body);
      if (!pdfBase64) throw new Error('pdfBase64 is required');
      const result = await extractPdf(pdfBase64);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, () => console.log(`PDF extractor listening on :${PORT}`));
