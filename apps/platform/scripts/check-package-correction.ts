import assert from 'node:assert/strict'
import { planPackageCorrection, type CorrectionFacts } from '../src/features/finances/correction'

const facts: CorrectionFacts = {
  status: 'ACTIVE',
  lessonCount: 4,
  remaining: 4,
  price: 4000,
  unitPrice: 1000,
  hasPayment: true,
  isGift: false,
  fromCrm: true,
  chargedCount: 0,
  chargedMoney: 0,
  returnableLessons: 0,
}

const resize = planPackageCorrection(facts, { remaining: 4, lessonCount: 6, price: 4000 }).plan
assert.equal(resize?.remaining, 4)
assert.equal(resize?.lessonDelta, 0)
assert.equal(resize?.sizeDelta, 2)
assert.equal(resize?.unitPrice, 666)

const trim = planPackageCorrection(
  { ...facts, unitPrice: 950, chargedCount: 1, chargedMoney: 725 },
  { remaining: 2, lessonCount: 4, price: 4000 },
).plan
assert.equal(trim?.lessonDelta, -2)
assert.equal(trim?.unitPrice, 950)
assert.equal(trim?.pastRevenueDelta, 0)

assert.ok(
  planPackageCorrection(
    { ...facts, remaining: 2, returnableLessons: 2 },
    { remaining: 3, lessonCount: 4, price: 4000 },
  ).error,
)

assert.equal(
  planPackageCorrection(facts, { remaining: 4, lessonCount: 4, price: 5000 }).plan?.priceDelta,
  1000,
)
assert.ok(
  planPackageCorrection(
    { ...facts, paymentStatus: 'CANCELLED' },
    { remaining: 4, lessonCount: 4, price: 5000 },
  ).error,
)

const legacyResize = planPackageCorrection(
  { ...facts, price: 0, isLegacy: true, chargedCount: 1, chargedMoney: 1000 },
  { remaining: 4, lessonCount: 6, price: 0 },
).plan
assert.equal(legacyResize?.unitPrice, 1000)
assert.equal(legacyResize?.pastRevenueDelta, 0)

const gift = {
  ...facts,
  isGift: true,
  hasPayment: false,
  price: 0,
  unitPrice: 0,
  returnableLessons: 2,
  remaining: 2,
}
assert.equal(
  planPackageCorrection(gift, { remaining: 1, lessonCount: 4, price: 0 }).plan?.lessonDelta,
  -1,
)
assert.ok(planPackageCorrection(gift, { remaining: 3, lessonCount: 4, price: 0 }).error)
const pricedGift = planPackageCorrection(gift, { remaining: 2, lessonCount: 4, price: 100 }).plan
assert.equal(pricedGift?.priceDelta, 100)
assert.equal(pricedGift?.unitPrice, 25)
