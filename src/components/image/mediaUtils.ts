import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import type { GenMediaRow } from '../../stores/studioStore'

// 图像板块共享工具（恢复自 698a026 StudioGen 的 helpers）。

/** 读取媒体记录 params_json 里保存的尺寸。 */
export function sizeOf(row: GenMediaRow): string | null {
  if (!row.params_json) return null
  try {
    const p = JSON.parse(row.params_json) as { size?: string }
    return p.size ?? null
  } catch {
    return null
  }
}

/** 读取「标注再加工」记录的来源图 id（image_edit 在 params_json 里记
 *  source_media_id 溯源），非再加工记录返回 null。 */
export function sourceIdOf(row: GenMediaRow): string | null {
  if (!row.params_json) return null
  try {
    const p = JSON.parse(row.params_json) as { source_media_id?: string }
    return p.source_media_id ?? null
  } catch {
    return null
  }
}

/** 该记录是否由「标注修改」二次生成而来。 */
export function isEditedRow(row: GenMediaRow): boolean {
  return sourceIdOf(row) !== null
}

export function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

/** 弹出「另存为」对话框，把已完成的媒体文件经 media_export 后端命令导出。
 *  取消对话框为 no-op。 */
export async function downloadMedia(
  row: GenMediaRow,
  onError: (msg: string) => void,
): Promise<void> {
  if (!row.local_path) return
  try {
    const ext = row.local_path.split('.').pop() || 'png'
    const dest = await save({
      defaultPath: 'agentboard-' + row.id.slice(0, 8) + '.' + ext,
      filters: [{ name: '图片', extensions: [ext] }],
    })
    if (!dest) return // 用户取消
    await invoke('media_export', { id: row.id, destPath: dest })
  } catch (e) {
    onError('下载失败：' + String(e))
  }
}
