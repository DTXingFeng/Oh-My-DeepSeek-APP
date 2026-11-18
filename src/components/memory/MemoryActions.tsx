import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import styles from './MemoryActions.module.css'

export const MemoryActions = ({
  actions,
  disabled,
}: {
  actions: { label: string; onSelect: () => void; danger?: boolean }[]
  disabled?: boolean
}) => {
  const t = useTranslate()
  const menuId = useId()
  const [open, setOpen] = useState(false)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { align: 'end', offset: 4 })
  const close = () => setOpen(false)
  useDismiss(open, [anchorRef, floatingRef], close)
  useEffect(() => {
    if (open) {
      floatingRef.current?.querySelector('button')?.focus()
    }
  }, [open, floatingRef])
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-label={t('memoryItemActions')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              role="menu"
              id={menuId}
              aria-label={t('memoryItemActions')}
              className={styles.menu}
              style={position ?? undefined}
              onKeyDown={(event) => {
                const items = [...event.currentTarget.querySelectorAll('button')]
                const index = items.indexOf(document.activeElement as HTMLButtonElement)
                const next =
                  event.key === 'ArrowDown'
                    ? (index + 1) % items.length
                    : event.key === 'ArrowUp'
                      ? (index + items.length - 1) % items.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? items.length - 1
                          : null
                if (next !== null) {
                  event.preventDefault()
                  items[next]?.focus()
                }
                if (event.key === 'Escape' || event.key === 'Tab') {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                  }
                  close()
                  anchorRef.current?.focus()
                }
              }}
            >
              {actions.map((action) => (
                <button
                  type="button"
                  role="menuitem"
                  key={action.label}
                  className={action.danger ? styles.danger : undefined}
                  onClick={() => {
                    close()
                    anchorRef.current?.focus()
                    action.onSelect()
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
