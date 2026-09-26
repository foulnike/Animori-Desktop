// Акцентные темы тулкита: пресет переопределяет --am-accent на documentElement.
// Красятся только виджеты и модалки; тема сайта и инлайновые цвета источников не тронуты.

import type { AccentPreset } from './settings'

export interface AccentDefinition {
  name: string
  /** Триплет "r,g,b", либо null — тема сайта или свой цвет пользователя. */
  triple: string | null
  dot: string
}

export const AM_ACCENTS: Record<AccentPreset, AccentDefinition> = {
  site: { name: 'Тема сайта', triple: null, dot: 'rgb(var(--color-blue))' },
  sakura: { name: 'Sakura', triple: '244,114,182', dot: '#f472b6' },
  mono: { name: 'Mono', triple: '148,163,184', dot: '#94a3b8' },
  catppuccin: { name: 'Catppuccin', triple: '203,166,247', dot: '#cba6f7' },
  nord: { name: 'Nord', triple: '136,192,208', dot: '#88c0d0' },
  dracula: { name: 'Dracula', triple: '189,147,249', dot: '#bd93f9' },
  matcha: { name: 'Matcha', triple: '134,196,138', dot: '#86c48a' },
  sunset: { name: 'Sunset', triple: '251,146,60', dot: '#fb923c' },
  custom: {
    name: 'Свой цвет',
    triple: null,
    dot: 'conic-gradient(#f38ba8, #fab387, #a6e3a1, #89b4fa, #cba6f7, #f38ba8)',
  },
}

/** Цвет своей темы до первого выбора пользователя. */
export const DEFAULT_CUSTOM_ACCENT = '#7aa2f7'

/** Порог яркости, выше которого белый текст на акценте читается плохо. */
const LIGHT_LIMIT = 0.72

let amAccentTriple: string | null = null

export function getAccentTriple(): string | null {
  return amAccentTriple
}

/** #rgb/#rrggbb → триплет "r,g,b" для rgb(var(--am-accent-rgb) / α) в стилях. */
export function parseAccentHex(hex: string): string | null {
  const raw = hex.trim().replace(/^#/, '')
  const full = raw.length === 3 ? raw.replace(/./g, (c) => c + c) : raw
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  const num = Number.parseInt(full, 16)
  return String((num >> 16) & 255) + ',' + String((num >> 8) & 255) + ',' + String(num & 255)
}

/** Триплет "r,g,b" → #rrggbb для поля выбора цвета. */
export function accentTripleToHex(triple: string): string {
  const parts = triple.split(',').map((p) => {
    const n = Math.round(Number(p.trim()))
    return Number.isFinite(n) ? Math.min(255, Math.max(0, n)) : 0
  })
  const [r = 0, g = 0, b = 0] = parts
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')
}

/** Слишком светлый акцент: белый текст на нём не читается. */
export function isAccentTooLight(triple: string): boolean {
  const [r = 0, g = 0, b = 0] = triple.split(',').map((p) => Number(p.trim()) || 0)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > LIGHT_LIMIT
}

export function amApplyAccentToDom(): void {
  // 'site' (null) = синий AniList.
  document.documentElement.style.setProperty('--am-accent', amAccentTriple || 'var(--color-blue)')
}

export function amSetAccent(preset: string, customHex?: string): void {
  const p = (AM_ACCENTS[preset as AccentPreset] ? preset : 'site') as AccentPreset
  // Кривой свой цвет не гасит интерфейс, а откатывает акцент к теме сайта.
  amAccentTriple = p === 'custom' ? parseAccentHex(customHex ?? '') : AM_ACCENTS[p].triple
  amApplyAccentToDom()
}
