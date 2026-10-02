import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TasksWidget } from '../widgets/TasksWidget'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const tasks = [{ id: 'task-1', title: 'Revisar paneles', due_date: null, priority: 'alta', assigned_to: null }]
describe('TasksWidget', () => {
  it('does not report completion when the server rejects it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const completed = vi.fn()
    render(<TasksWidget tasks={tasks} onCompleted={completed} />)
    fireEvent.click(screen.getByRole('button', { name: 'Completar tarea: Revisar paneles' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo completar')
    expect(completed).not.toHaveBeenCalled()
  })
  it('refreshes the task list after a confirmed success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const completed = vi.fn()
    render(<TasksWidget tasks={tasks} onCompleted={completed} />)
    fireEvent.click(screen.getByRole('button', { name: 'Completar tarea: Revisar paneles' }))
    await waitFor(() => expect(completed).toHaveBeenCalledWith('task-1'))
  })
})
