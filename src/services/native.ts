/** The bridge is exposed only to bundled pages inside our Android WebView. */
type NativeBridge = {
  readApiKey: () => string | null | undefined
  writeApiKey: (key: string | null) => boolean
  beginExport: (name: string, mime: string) => boolean
  appendExport: (base64: string) => boolean
  finishExport: () => void
  cancelExport: () => void
  openExternal: (url: string) => void
  setDarkMode: (dark: boolean) => void
}

declare global {
  interface Window {
    OhMyDeepSeekAndroid?: NativeBridge
    ohMyDeepSeekBack?: () => boolean
  }
}

export const nativeBridge = window.OhMyDeepSeekAndroid

/** SAF lets the user choose the destination, without broad storage permissions. */
export const saveBlob = async (name: string, blob: Blob): Promise<void> => {
  if (!nativeBridge) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return
  }
  if (!nativeBridge.beginExport(name, blob.type || 'application/octet-stream')) {
    throw new Error('另一个文件正在导出，请稍后重试。')
  }
  try {
    // Bound bridge messages and avoid making a second whole-file base64 copy.
    for (let offset = 0; offset < blob.size; offset += 48 * 1024) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + 48 * 1024).arrayBuffer())
      let binary = ''
      for (const byte of bytes) {
        binary += String.fromCharCode(byte)
      }
      if (!nativeBridge.appendExport(btoa(binary))) {
        throw new Error('写入导出文件失败，请检查设备剩余空间。')
      }
    }
    await new Promise<void>((resolve, reject) => {
      const onResult = (event: Event) => {
        window.removeEventListener('ohmydeepseek-export-result', onResult)
        const { ok, cancelled } = (event as CustomEvent<{ ok: boolean; cancelled: boolean }>).detail
        if (ok || cancelled) {
          resolve()
        } else {
          reject(new Error('保存文件失败，请重试。'))
        }
      }
      window.addEventListener('ohmydeepseek-export-result', onResult)
      nativeBridge.finishExport()
    })
  } catch (error) {
    nativeBridge.cancelExport()
    throw error
  }
}

export const setupNativeLinks = (onError: (message: string) => void) => {
  if (!nativeBridge) {
    return
  }
  const open = (url: string) => {
    if (/^https?:\/\//i.test(url)) {
      nativeBridge.openExternal(url)
    } else if (url.startsWith('blob:')) {
      void fetch(url)
        .then((response) => response.blob())
        .then((blob) => saveBlob('attachment', blob))
        .catch(() => onError('无法导出附件，请重试。'))
    }
  }
  window.open = (url) => {
    if (url) {
      open(String(url))
    }
    return null
  }
  document.addEventListener('click', (event) => {
    const anchor = (event.target as Element | null)?.closest('a')
    if (!anchor) {
      return
    }
    if (anchor.hasAttribute('download') && anchor.href.startsWith('blob:')) {
      event.preventDefault()
      void fetch(anchor.href)
        .then((response) => response.blob())
        .then((blob) => saveBlob(anchor.download || 'attachment', blob))
        .catch(() => onError('无法导出附件，请重试。'))
    } else if (/^https?:\/\//i.test(anchor.href) && anchor.origin !== location.origin) {
      event.preventDefault()
      open(anchor.href)
    }
  })
}
