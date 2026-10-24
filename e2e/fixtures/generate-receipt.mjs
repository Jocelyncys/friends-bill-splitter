// Regenerates e2e/fixtures/receipt.png, a small synthetic receipt for the OCR e2e test.
//   node e2e/fixtures/generate-receipt.mjs
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const lines = [['Nasi Lemak', '12.50'], ['Teh Tarik', '3.80'], ['Roti Canai', '4.20']]
const html = `<body style="margin:0;background:#fff">
<div id="r" style="width:420px;padding:28px;font:28px/1.6 Arial,sans-serif;color:#000;background:#fff">
<div style="text-align:center;font-weight:bold">KEDAI MAKAN</div>
${lines.map(([d, p]) => `<div style="display:flex;justify-content:space-between"><span>${d}</span><span>${p}</span></div>`).join('')}
<div style="display:flex;justify-content:space-between;margin-top:12px"><span>TOTAL</span><span>20.50</span></div>
</div></body>`

const browser = await chromium.launch()
const page = await browser.newPage({ deviceScaleFactor: 1 })
await page.setContent(html)
await page.locator('#r').screenshot({ path: fileURLToPath(new URL('./receipt.png', import.meta.url)) })
await browser.close()
