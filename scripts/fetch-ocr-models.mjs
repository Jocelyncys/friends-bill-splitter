// Downloads the OCR runtime and model files into public/ocr-models/ so the app never fetches them
// from a third-party origin at runtime. Every file is pinned by SHA-256; any mismatch fails the build.
// Files that already exist with the right hash are skipped (CI caches the folder).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'ocr-models')
const PADDLE = 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0'

// lang 'ch' + PP-OCRv5 resolves to the mobile det/rec models in @paddleocr/paddleocr-js 0.4.2.
// The SDK's worker bundles onnxruntime-web 1.24.3 glue code, so it needs that exact version's wasm
// (the onnxruntime-web 1.30.0 in node_modules is a different build and would not load).
const FILES = [
  {
    out: 'PP-OCRv5_mobile_det_onnx_infer.tar',
    url: `${PADDLE}/PP-OCRv5_mobile_det_onnx_infer.tar`,
    sha256: '781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30',
  },
  {
    out: 'PP-OCRv5_mobile_rec_onnx_infer.tar',
    url: `${PADDLE}/PP-OCRv5_mobile_rec_onnx_infer.tar`,
    sha256: 'f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c',
  },
  {
    out: 'ort-1.24.3/ort-wasm-simd-threaded.jsep.wasm',
    url: 'https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.24.3.tgz',
    archiveSha256: 'd521349a11a1f6012ce6b21fcdafce310b3111bbb7552a1d1f7dcb2714b76d78',
    entry: 'package/dist/ort-wasm-simd-threaded.jsep.wasm',
    sha256: '2e0a3d0e3f6b7c13ecfaba38c13691fd19c9ed470e72f9d7d8416ca59ab6dbcd',
  },
]

const sha256 = buf => createHash('sha256').update(buf).digest('hex')

function verify(label, buf, expected) {
  const actual = sha256(buf)
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${label}: expected ${expected}, got ${actual}`)
}

async function download(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed ${url}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

// Minimal ustar reader: returns the bytes of the entry whose path equals `name`.
function extractTarEntry(tar, name) {
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(b => b === 0)) break
    const str = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '')
    const prefix = str(345, 155)
    const path = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100)
    const size = parseInt(str(124, 12).trim() || '0', 8)
    if (path === name) return tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error(`Entry ${name} not found in archive`)
}

for (const file of FILES) {
  const target = join(OUT_DIR, file.out)
  if (existsSync(target) && sha256(readFileSync(target)) === file.sha256) {
    console.log(`ok (cached) ${file.out}`)
    continue
  }
  console.log(`downloading ${file.url}`)
  let bytes = await download(file.url)
  if (file.entry) {
    verify(file.url, bytes, file.archiveSha256)
    bytes = extractTarEntry(gunzipSync(bytes), file.entry)
  }
  verify(file.out, bytes, file.sha256)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(`${target}.part`, bytes)
  renameSync(`${target}.part`, target)
  console.log(`ok ${file.out} (${bytes.length} bytes)`)
}
