export interface ModelLike {
  modelId: string
  kind?: string
}

const GPT56_ORDER = ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']

export function pickPreferredChatModel<T extends ModelLike>(models: T[]): T | undefined {
  const chats = models.filter((m) => (m.kind ?? 'chat') === 'chat')
  for (const id of GPT56_ORDER) {
    const hit = chats.find((m) => m.modelId === id)
    if (hit) return hit
  }
  return chats.find((m) => m.modelId === 'gpt-5.5')
    ?? chats.find((m) => m.modelId.startsWith('gpt-5.5'))
    ?? chats[0]
}
