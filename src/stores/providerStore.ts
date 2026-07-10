import { create } from 'zustand'

// ── Types (mirror Rust providers::ProviderInfo) ───────────────────────────────

/** A configured provider as returned by `providers_list`. Never carries the
 *  plaintext key — only `has_key` + a tail-4 `key_mask`. */
export interface ProviderInfo {
  id: string
  label: string
  base_url: string
  wire_api: string
  enabled: boolean
  has_key: boolean
  key_mask: string
  is_default: boolean
}

/** Result of a provider connectivity test (mirrors engine_config::TestResult). */
export interface ProviderTestResult {
  success: boolean
  message: string
  elapsed_ms: number
}

/** One model id with its usage classification (mirrors Rust ProviderModelEntry). */
export interface ProviderModelEntry {
  id: string
  /** "chat" | "image" | "video" | "other" */
  kind: string
}

/** Per-provider model listing with health status (mirrors Rust ProviderModels,
 *  returned by the `providers_models_status` command). */
export interface ProviderModelsStatus {
  provider_id: string
  provider_label: string
  ok: boolean
  models: ProviderModelEntry[]
  /** Error description when `ok == false`（如 "HTTP 401 INVALID_API_KEY"）。 */
  error: string | null
}

// ── Tauri guard ───────────────────────────────────────────────────────────────

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface ProviderStore {
  providers: ProviderInfo[]
  loaded: boolean
  /** Per-provider health（模型数 / 错误原文），来自 providers_models_status。 */
  status: ProviderModelsStatus[]
  statusLoading: boolean
  statusLoaded: boolean
  loadProviders: () => Promise<void>
  /** Refresh per-provider health. Backend cache is invalidated on every
   *  provider mutation, so calling this after upsert/setKey/delete is fresh. */
  loadStatus: () => Promise<void>
  /** Create (no id) or update a provider's metadata. Returns the id, or null on error. */
  upsert: (p: {
    id?: string
    label: string
    base_url: string
    wire_api: string
    enabled: boolean
  }) => Promise<string | null>
  /** Store or clear (empty key) a provider's API key in the OS credential store. */
  setKey: (id: string, key: string) => Promise<void>
  remove: (id: string) => Promise<void>
  test: (id: string) => Promise<ProviderTestResult>
}

export const useProviderStore = create<ProviderStore>((set, get) => ({
  providers: [],
  loaded: false,
  status: [],
  statusLoading: false,
  statusLoaded: false,

  loadProviders: async () => {
    if (!isTauri) return
    try {
      const providers = await tauriInvoke<ProviderInfo[]>('providers_list')
      set({ providers, loaded: true })
    } catch (e) {
      console.warn('[providerStore] loadProviders failed:', e)
      set({ loaded: true })
    }
  },

  loadStatus: async () => {
    if (!isTauri) return
    set({ statusLoading: true })
    try {
      const status = await tauriInvoke<ProviderModelsStatus[]>(
        'providers_models_status',
      )
      set({ status, statusLoading: false, statusLoaded: true })
    } catch (e) {
      console.warn('[providerStore] loadStatus failed:', e)
      set({ statusLoading: false, statusLoaded: true })
    }
  },

  upsert: async (p) => {
    if (!isTauri) return null
    try {
      const id = await tauriInvoke<string>('provider_upsert', {
        id: p.id ?? null,
        label: p.label,
        baseUrl: p.base_url,
        wireApi: p.wire_api,
        enabled: p.enabled,
      })
      await get().loadProviders()
      return id
    } catch (e) {
      console.warn('[providerStore] upsert failed:', e)
      throw e
    }
  },

  setKey: async (id, key) => {
    if (!isTauri) return
    await tauriInvoke<void>('provider_set_key', { id, key })
    await get().loadProviders()
  },

  remove: async (id) => {
    if (!isTauri) return
    await tauriInvoke<void>('provider_delete', { id })
    await get().loadProviders()
    void get().loadStatus()
  },

  test: async (id) => {
    return tauriInvoke<ProviderTestResult>('provider_test', { id })
  },
}))
