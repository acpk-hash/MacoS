import nacl from 'tweetnacl'
import { decodeBase64, decodeUTF8, encodeBase64, encodeUTF8 } from 'tweetnacl-util'

const ROOT_KEY_STORAGE = 'iris.remote.root-key.v1'
let credentialRootKey: Uint8Array | null = null

export interface EncryptedEnvelope {
  v: 1
  alg: 'XSalsa20-Poly1305'
  nonce: string
  ciphertext: string
}

export interface PairingPayload {
  v: 1
  type: 'iris-remote-pairing'
  server: string
  key: string
  createdAt: number
}

export async function initializeRemoteRootKey(): Promise<void> {
  if (credentialRootKey || typeof localStorage === 'undefined') return
  const candidate = encodeBase64(getOrCreateRemoteRootKey())
  const isTauri = !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  if (!isTauri) return
  const { invoke } = await import('@tauri-apps/api/core')
  const saved = await invoke<string>('sync_e2ee_key_get_or_create', { candidate })
  const key = decodeBase64(saved)
  if (key.length !== nacl.secretbox.keyLength) throw new Error('Windows 凭据中的 Iris 密钥无效')
  credentialRootKey = key
  // Remove the old plaintext-at-rest copy after one-time Credential Manager migration.
  localStorage.removeItem(ROOT_KEY_STORAGE)
}

export function getOrCreateRemoteRootKey(): Uint8Array {
  if (credentialRootKey) return credentialRootKey
  const saved = localStorage.getItem(ROOT_KEY_STORAGE)
  if (saved) {
    const key = decodeBase64(saved)
    if (key.length === nacl.secretbox.keyLength) return key
  }
  const key = nacl.randomBytes(nacl.secretbox.keyLength)
  localStorage.setItem(ROOT_KEY_STORAGE, encodeBase64(key))
  return key
}

export function createPairingPayload(server: string): PairingPayload {
  return {
    v: 1,
    type: 'iris-remote-pairing',
    server,
    key: encodeBase64(getOrCreateRemoteRootKey()),
    createdAt: Date.now(),
  }
}

export function encodePairingPayload(payload: PairingPayload): string {
  return `iris://remote/pair?data=${encodeURIComponent(encodeBase64(decodeUTF8(JSON.stringify(payload))))}`
}

export function encryptRemoteJson(value: unknown): EncryptedEnvelope {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const plaintext = decodeUTF8(JSON.stringify(value))
  const ciphertext = nacl.secretbox(plaintext, nonce, getOrCreateRemoteRootKey())
  return {
    v: 1,
    alg: 'XSalsa20-Poly1305',
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  }
}

export function decryptRemoteJson<T>(envelope: EncryptedEnvelope): T {
  if (envelope.v !== 1 || envelope.alg !== 'XSalsa20-Poly1305') {
    throw new Error('不支持的 Iris 加密消息版本')
  }
  const plaintext = nacl.secretbox.open(
    decodeBase64(envelope.ciphertext),
    decodeBase64(envelope.nonce),
    getOrCreateRemoteRootKey(),
  )
  if (!plaintext) throw new Error('Iris 加密消息认证失败')
  return JSON.parse(encodeUTF8(plaintext)) as T
}
