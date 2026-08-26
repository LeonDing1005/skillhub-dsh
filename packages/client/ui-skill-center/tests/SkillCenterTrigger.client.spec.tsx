// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillCenterTrigger, type SkillCenterTriggerProps } from '../src/client/SkillCenterTrigger.tsx'
import { en } from '../src/client/locales.ts'

const t: SkillCenterTriggerProps['t'] = key => en[key as keyof typeof en] ?? key

afterEach(cleanup)

describe('SkillCenterTrigger', () => {
  it.each([true, false])('opens the Skill Center in wide=%s sidebar mode', (wide) => {
    const open = vi.fn()
    const unusedHook = (): never => { throw new Error('unused global slot hook') }
    render(
      <SkillCenterTrigger
        wide={wide}
        open={open}
        t={t}
        useSessions={unusedHook as never}
        useWorkspaces={unusedHook as never}
      />,
    )

    const button = screen.getByRole('button', { name: 'Skill Center' })
    fireEvent.click(button)
    expect(open).toHaveBeenCalledOnce()
    expect(screen.queryByText('Skill Center')).toBe(wide ? button.querySelector('span') : null)
  })
})
