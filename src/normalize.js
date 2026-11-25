// 原始记录中的值一律以字符串保存。来源未能提供时写 "?"，
// 来源系统使用的组合编号以 "+" 分隔。任何计算都必须先经过本模块，
// 以免把 "?" 当成 0，或把组合编号当成一个普通编号。

export const UNKNOWN = '?'

export function isUnknown(value) {
  return value === UNKNOWN || value === undefined || value === null || value === ''
}

export function toMinutes(value) {
  if (isUnknown(value)) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function splitReferences(value) {
  if (isUnknown(value)) return []
  return String(value)
    .split('+')
    .map(part => part.trim())
    .filter(Boolean)
}

// "A1+A2" 或 "K1" -> 去重后的编号数组。
export function distinctReferences(value) {
  return [...new Set(splitReferences(value))]
}

export function minDefined(values) {
  let result = null
  for (const value of values) {
    if (value === null || value === undefined || Number.isNaN(value)) continue
    if (result === null || value < result) result = value
  }
  return result
}

export function maxDefined(values) {
  let result = null
  for (const value of values) {
    if (value === null || value === undefined || Number.isNaN(value)) continue
    if (result === null || value > result) result = value
  }
  return result
}

export function clampAtZero(value) {
  return value === null || value === undefined ? null : Math.max(0, value)
}

// 目标值是否落在 [from, to] 分钟区间内；区间端点可为空。
export function withinWindow(minute, window) {
  if (minute === null || !window) return false
  if (window.from !== null && minute < window.from) return false
  if (window.to !== null && minute > window.to) return false
  return true
}

export function parseWindow(label) {
  if (isUnknown(label)) return null
  const match = String(label).match(/^\s*(\d+)\s*-\s*(\d+)\s*$/)
  if (!match) return null
  return { from: Number(match[1]), to: Number(match[2]) }
}

export function mean(values) {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

export function round(value, digits = 2) {
  if (value === null || value === undefined) return value
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
