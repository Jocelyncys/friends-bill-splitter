import { expect, test } from '@playwright/test'
import { createEvent, inviteLink, joinEvent, newUser, rm } from './helpers.ts'

test('single bill: itemized entry, a friend claims an item, the host assigns the rest, then settle', async ({ browser }) => {
  test.setTimeout(120_000)
  const owner = await newUser(browser)
  const ben = await newUser(browser)

  await createEvent(owner, 'Single Bill', 'Friday Dinner', 'Ana')
  const link = await inviteLink(owner)
  await joinEvent(ben, link, 'Ben')

  // Itemized, friends claim items: two items entered by hand.
  await owner.getByRole('button', { name: 'Add simple expense' }).click()
  await owner.getByLabel('Description').fill('Mamak dinner')
  await owner.getByLabel('Split method').selectOption({ label: 'Itemized (friends claim items)' })
  await owner.getByLabel('Item 1 name').fill('Nasi lemak')
  await owner.getByLabel('Item 1 price').fill('12.00')
  await owner.getByRole('button', { name: 'Add item' }).click()
  await owner.getByLabel('Item 2 name').fill('Teh tarik')
  await owner.getByLabel('Item 2 price').fill('8.50')
  await expect(owner.getByText(rm('20.50'))).toBeVisible()
  await owner.getByRole('button', { name: 'Save expense' }).click()

  // Nothing is claimed yet: the event home asks for attention.
  const attention = owner.getByRole('button', { name: /Mamak dinner.*not yet assigned/ })
  await expect(attention).toBeVisible()

  // Ben claims the nasi lemak from the claim page (reached from his event home through realtime).
  await ben.getByRole('button', { name: /Mamak dinner.*not yet assigned/ }).click({ timeout: 15_000 })
  await expect(ben.getByRole('heading', { name: 'Claim items' })).toBeVisible()
  const benItem = ben.getByRole('article').filter({ hasText: 'Nasi lemak' })
  await benItem.getByRole('button', { name: 'Claim for me' }).click()
  await expect(benItem).toContainText('Claimed by: Ben')

  // The owner assigns the teh tarik to themselves.
  await attention.click()
  const ownerItem = owner.getByRole('article').filter({ hasText: 'Teh tarik' })
  await ownerItem.getByRole('group', { name: 'Who had Teh tarik' }).getByRole('button', { name: 'Ana' }).click()
  await ownerItem.getByRole('button', { name: 'Assign Teh tarik' }).click()
  await expect(ownerItem).toContainText('Assigned to: Ana')
  await expect(owner.getByRole('article').filter({ hasText: 'Nasi lemak' })).toContainText('Claimed by: Ben')
  await expect(owner.getByText(/Not yet claimed/)).toHaveCount(0)

  // Settle with the (default) optimized plan.
  await owner.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home' }).click()
  await owner.getByRole('button', { name: 'Settle now' }).click()
  await expect(owner.getByRole('radio', { name: /Optimized direct settlement/ })).toBeChecked()
  await owner.locator('.settlement__footer').getByRole('button', { name: 'Settle now' }).click()
  await owner.getByRole('dialog').getByRole('button', { name: 'Confirm and settle' }).click()

  // Ben paid nothing and owes his nasi lemak.
  await expect(owner.getByRole('listitem').filter({ hasText: 'Ben pays you' })).toContainText(rm('12.00'))
  await ben.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home' }).click()
  await ben.getByRole('button', { name: 'View payments' }).click({ timeout: 15_000 })
  await expect(ben.getByText(/Pay RM\s?12\.00 to Ana/)).toBeVisible()
  await expect(ben.getByRole('button', { name: "I've sent the payment" })).toBeVisible()

  await owner.context().close()
  await ben.context().close()
})

test('single bill: the host shares one item between two people, enters a lower amount paid, then settle', async ({ browser }) => {
  test.setTimeout(120_000)
  const owner = await newUser(browser)
  const ben = await newUser(browser)

  await createEvent(owner, 'Single Bill', 'Satay night', 'Ana')
  const link = await inviteLink(owner)
  await joinEvent(ben, link, 'Ben')

  // Satay platter RM 20 shared by Ana and Ben, teh tarik RM 8 for Ben, RM 5 off: paid RM 23.
  await owner.reload()
  await owner.getByRole('button', { name: 'Add simple expense' }).click()
  await owner.getByLabel('Description').fill('Satay dinner')
  await owner.getByLabel('Split method').selectOption({ label: 'Itemized (I assign items)' })
  await owner.getByLabel('Item 1 name').fill('Satay platter')
  await owner.getByLabel('Item 1 price').fill('20.00')
  const who1 = owner.getByRole('group', { name: 'Who had Item 1' })
  await who1.getByRole('button', { name: 'Ana' }).click()
  await who1.getByRole('button', { name: 'Ben' }).click()
  await expect(owner.getByText('Shared by 2, RM 10.00 each')).toBeVisible()
  await owner.getByRole('button', { name: 'Add item' }).click()
  await owner.getByLabel('Item 2 name').fill('Teh tarik')
  await owner.getByLabel('Item 2 price').fill('8.00')
  await owner.getByRole('group', { name: 'Who had Item 2' }).getByRole('button', { name: 'Ben' }).click()

  await owner.getByLabel('Amount paid').fill('23.00')
  await expect(owner.getByText(/Discounts, tax and rounding: −RM\s?5\.00/)).toBeVisible()
  // Ana's items RM 10, Ben's RM 18: the RM 23 paid splits 8.21 / 14.79 (largest remainder to Ben).
  const pays = owner.getByRole('list', { name: 'What each person pays' })
  await expect(pays.getByRole('listitem').filter({ hasText: 'Ben' })).toContainText(rm('14.79'))
  await owner.getByRole('button', { name: 'Save expense' }).click()
  await expect(owner.locator('.expense-row', { hasText: 'Satay dinner' })).toContainText(rm('23.00'))

  await owner.getByRole('button', { name: 'Settle now' }).click()
  await expect(owner.getByRole('radio', { name: /Optimized direct settlement/ })).toBeChecked()
  await owner.locator('.settlement__footer').getByRole('button', { name: 'Settle now' }).click()
  await owner.getByRole('dialog').getByRole('button', { name: 'Confirm and settle' }).click()

  await expect(owner.getByRole('listitem').filter({ hasText: 'Ben pays you' })).toContainText(rm('14.79'))
  await ben.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home' }).click()
  await ben.getByRole('button', { name: 'View payments' }).click({ timeout: 15_000 })
  await expect(ben.getByText(/Pay RM\s?14\.79 to Ana/)).toBeVisible()

  await owner.context().close()
  await ben.context().close()
})

test('critical path in Simplified Chinese', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '简体中文' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('你想怎样分账？')

  await page.getByRole('button', { name: '单次账单' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('创建活动')
  await page.getByLabel('活动名称').fill('周五晚餐')
  await page.getByLabel('你的名字').fill('小美')
  await page.getByRole('button', { name: '创建活动' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('来记第一笔开销吧')

  await page.getByRole('button', { name: '添加简单开销' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('添加开销')
  await page.getByLabel('说明').fill('晚餐')
  await page.getByLabel('金额', { exact: true }).fill('45.00')
  await page.getByRole('button', { name: '保存开销' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('你想做什么？')

  await page.getByRole('button', { name: '立即结算' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('结算')
  await expect(page.getByRole('radio', { name: /优化直接结算/ })).toBeChecked()
  await expect(page.getByText('推荐', { exact: true })).toBeVisible()

  // The choice survives a reload.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('结算')
})
