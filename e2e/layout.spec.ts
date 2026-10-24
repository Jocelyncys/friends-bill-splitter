import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { addSimpleExpense, createEvent, eventIdOf, newUser } from './helpers.ts'

// Automated part of the plan's manual bilingual/mobile checks (Step 5). Runs at 360×800 (mobile project)
// and 1280×800 (desktop project).

/** No horizontal page scroll, and no visible control whose content is cut off or pushed off-screen. */
async function expectNoOverflow(page: Page) {
  const problems = await page.evaluate(() => {
    const found: string[] = []
    const width = window.innerWidth
    if (document.documentElement.scrollWidth > width) found.push(`page scrollWidth ${document.documentElement.scrollWidth} > ${width}`)
    for (const el of document.querySelectorAll<HTMLElement>('button, a, input, select, textarea, label, h1, h2, h3')) {
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      const name = `${el.tagName.toLowerCase()} "${(el.textContent || (el as HTMLInputElement).value || '').trim().slice(0, 40)}"`
      if (box.left < -1 || box.right > width + 1) found.push(`${name} outside viewport (${Math.round(box.left)}..${Math.round(box.right)})`)
      if (el.matches('button, a, select') && el.scrollWidth > el.clientWidth + 1) found.push(`${name} clipped (${el.scrollWidth} > ${el.clientWidth})`)
    }
    return found
  })
  expect(problems).toEqual([])
}

// A stable, language-independent element that only renders once each screen's data has loaded.
const READY: Record<string, (page: Page) => Promise<void>> = {
  start: page => expect(page.getByRole('main').getByRole('button')).toHaveCount(2),
  home: page => expect(page.getByRole('main').getByRole('article').first()).toBeVisible(),
  editor: page => expect(page.getByRole('main').getByRole('checkbox')).toHaveCount(1),
  people: page => expect(page.getByRole('main').getByRole('listitem')).toHaveCount(1),
  settlement: page => expect(page.getByRole('radio')).toHaveCount(3),
}

async function check(page: Page, testInfo: TestInfo, screen: string, lang: string) {
  await READY[screen](page)
  await expectNoOverflow(page)
  await page.screenshot({ path: testInfo.outputPath(`${screen}-${lang}.png`), fullPage: true })
}

test('bilingual screens fit the viewport; guided, active and attention states render', async ({ browser }, testInfo) => {
  test.setTimeout(120_000)
  const page = await newUser(browser)
  await page.goto('/')
  await expectNoOverflow(page)

  // New event: large guided actions.
  const eventId = await createEvent(page, 'Trip or Event', 'Cameron Highlands Weekend Getaway', 'Ana')
  const guided = page.getByRole('main').locator('section.guided-actions')
  await expect(guided).toHaveClass(/guided-actions--large/)
  for (const name of ['Scan a receipt', 'Add simple expense', 'Invite friends']) {
    const box = await guided.getByRole('button', { name }).boundingBox()
    expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(48)
  }

  // Active event: compact actions, recent expenses, attention for an unassigned itemized bill.
  await addSimpleExpense(page, 'Strawberry farm tickets', '64.00')
  await page.getByRole('button', { name: 'Add simple expense' }).click()
  await page.getByLabel('Description').fill('Steamboat dinner')
  await page.getByLabel('Split method').selectOption({ label: 'Itemized (friends claim items)' })
  await page.getByLabel('Item 1 name').fill('Seafood set')
  await page.getByLabel('Item 1 price').fill('88.00')
  await page.getByRole('button', { name: 'Save expense' }).click()
  await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible()
  await expect(guided).not.toHaveClass(/guided-actions--large/)
  await expect(page.getByRole('heading', { name: 'Needs your attention' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Steamboat dinner: .* not yet assigned/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Latest expenses' })).toBeVisible()
  await expect(page.locator('.expense-row', { hasText: 'Strawberry farm tickets' })).toBeVisible()
  await expectNoOverflow(page)
  // Resolve it so the settlement screen below shows the three plan cards.
  await page.getByRole('button', { name: /Steamboat dinner: .* not yet assigned/ }).click()
  await page.getByRole('button', { name: 'Assign to Ana' }).click()
  await expect(page.getByText('Assigned to: Ana')).toBeVisible()

  const screens: Array<[string, string]> = [
    ['home', `/#/event/${eventId}`],
    ['editor', `/#/event/${eventId}/expenses/new`],
    ['people', `/#/event/${eventId}/people`],
    ['settlement', `/#/event/${eventId}/settle`],
  ]
  const headings: Record<string, Record<string, string>> = {
    en: { home: 'What do you want to do?', editor: 'Add expense', people: 'People', settlement: 'Settle up' },
    'zh-CN': { home: '你想做什么？', editor: '添加开销', people: '成员', settlement: '结算' },
  }
  for (const [lang, button] of [['en', 'English'], ['zh-CN', '简体中文']] as const) {
    await test.step(`screens in ${lang}`, async () => {
      await page.getByRole('button', { name: button }).click()
      await expect(page.locator('html')).toHaveAttribute('lang', lang)
      await page.goto('/')
      await check(page, testInfo, 'start', lang)
      for (const [screen, url] of screens) {
        await test.step(screen, async () => {
          await page.goto(url)
          await expect(page.getByRole('heading', { level: 1 })).toHaveText(headings[lang][screen])
          await check(page, testInfo, screen, lang)
        })
      }
    })
  }
  await page.context().close()
})

test('anonymous identity: same browser keeps membership, a fresh browser is a stranger', async ({ browser }) => {
  const page = await newUser(browser)
  await createEvent(page, 'Single Bill', 'Identity check', 'Ana')
  const url = page.url()
  const eventId = eventIdOf(page)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Let’s add the first expense' })).toBeVisible()
  await page.goto('/')
  await page.goto(url)
  await expect(page.getByRole('heading', { name: 'Let’s add the first expense' })).toBeVisible()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'People' }).click()
  await expect(page.getByText('Ana (you)')).toBeVisible()

  // Cleared site data = a new browser context: no session, so no access to the event without an invite.
  const stranger = await newUser(browser)
  await stranger.goto(`/#/event/${eventId}`)
  await expect(stranger.getByRole('alert')).toBeVisible()
  await expect(stranger.getByText('Identity check')).toHaveCount(0)
  await stranger.goto(`/#/event/${eventId}/people`)
  await expect(stranger.getByRole('alert')).toBeVisible()
  await expect(stranger.getByText('Ana')).toHaveCount(0)

  await page.context().close()
  await stranger.context().close()
})
