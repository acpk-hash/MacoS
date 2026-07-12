import { create } from 'zustand'

// 图像板块本地状态。
// 收藏：历史记录 GenMediaRow 没有收藏字段，故收藏 id 集合放在 localStorage
// 持久化（仅本机生效），由本 store 统一读写。

const LS_KEY = 'agentboard.image.favorites'

function loadFavorites(): string[] {
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === 'string')
      : []
  } catch {
    return []
  }
}

function saveFavorites(ids: string[]) {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(ids))
  } catch {
    // 持久化失败（如存储被禁用）时仅保留内存态。
  }
}

interface ImageStore {
  /** 收藏的媒体记录 id。 */
  favoriteIds: string[]
  toggleFavorite: (id: string) => void
  /** 删除媒体记录时同步清理收藏。 */
  removeFavorite: (id: string) => void
}

export const useImageStore = create<ImageStore>((set) => ({
  favoriteIds: typeof window === 'undefined' ? [] : loadFavorites(),

  toggleFavorite: (id) =>
    set((s) => {
      const ids = s.favoriteIds.includes(id)
        ? s.favoriteIds.filter((x) => x !== id)
        : [...s.favoriteIds, id]
      saveFavorites(ids)
      return { favoriteIds: ids }
    }),

  removeFavorite: (id) =>
    set((s) => {
      if (!s.favoriteIds.includes(id)) return {}
      const ids = s.favoriteIds.filter((x) => x !== id)
      saveFavorites(ids)
      return { favoriteIds: ids }
    }),
}))
